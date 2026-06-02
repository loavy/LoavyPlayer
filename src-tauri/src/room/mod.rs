use std::{
    net::{SocketAddr, UdpSocket},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
};

use crate::models::{RoomCreateRequest, RoomJoinRequest, RoomJoinResult, RoomPlaybackState, RoomStatus, RoomUser};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RoomWireMessage {
    RoomJoin {
        room_name: String,
        password: String,
        display_name: String,
    },
    AuthSuccess {
        room_name: String,
        playback: Option<RoomPlaybackState>,
        allow_guest_queue: bool,
    },
    AuthError {
        reason: String,
    },
    PlaybackState(RoomPlaybackState),
    QueueUpdate {
        tracks: Vec<i64>,
    },
    UserJoined {
        display_name: String,
    },
    UserLeft {
        display_name: String,
    },
    RoomHeartbeat {
        timestamp_ms: i64,
    },
    RoomError {
        message: String,
    },
    RoomKicked {
        reason: String,
    },
}

#[derive(Clone)]
pub struct RoomManager {
    inner: Arc<Mutex<Option<RoomRuntime>>>,
    next_client_id: Arc<AtomicU64>,
}

struct RoomRuntime {
    config: RoomConfig,
    state: Arc<Mutex<RoomSharedState>>,
    handle: JoinHandle<()>,
}

#[derive(Clone)]
struct RoomConfig {
    name: String,
    password_hash: String,
    max_users: Option<usize>,
    allow_guest_queue: bool,
    bind_addr: String,
    port: u16,
    share_addr: String,
    public_addr: Option<String>,
}

struct RoomSharedState {
    playback: Option<RoomPlaybackState>,
    clients: Vec<RoomClient>,
}

struct RoomClient {
    user: RoomUser,
    tx: mpsc::UnboundedSender<RoomWireMessage>,
}

impl RoomManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            next_client_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub async fn start(&self, request: RoomCreateRequest) -> Result<RoomStatus> {
        self.stop()?;

        let name = sanitize_room_name(&request.name)?;
        if request.password.trim().len() < 4 {
            return Err(anyhow!("Room password must be at least 4 characters."));
        }

        let bind_addr = request.bind_addr.unwrap_or_else(|| "0.0.0.0".to_string());
        let port = request.port.unwrap_or(0);
        let listener = TcpListener::bind((bind_addr.as_str(), port)).await?;
        let local_addr = listener.local_addr()?;
        let share_addr = local_ip().unwrap_or_else(|| "127.0.0.1".to_string());
        let public_addr = public_ip().await.ok();
        let config = RoomConfig {
            name,
            password_hash: hash_password(&request.password),
            max_users: request.max_users,
            allow_guest_queue: request.allow_guest_queue,
            bind_addr,
            port: local_addr.port(),
            share_addr,
            public_addr,
        };
        let state = Arc::new(Mutex::new(RoomSharedState {
            playback: None,
            clients: Vec::new(),
        }));

        let server_config = config.clone();
        let server_state = state.clone();
        let next_client_id = self.next_client_id.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((stream, remote_addr)) = listener.accept().await else {
                    continue;
                };
                let config = server_config.clone();
                let state = server_state.clone();
                let client_id = next_client_id.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let _ = handle_client(stream, remote_addr, client_id, config, state).await;
                });
            }
        });

        let runtime = RoomRuntime { config, state, handle };
        let status = runtime.status();
        *self.inner.lock().map_err(|_| anyhow!("Room state lock failed"))? = Some(runtime);
        Ok(status)
    }

    pub fn stop(&self) -> Result<()> {
        if let Some(runtime) = self.inner.lock().map_err(|_| anyhow!("Room state lock failed"))?.take() {
            runtime.handle.abort();
        }
        Ok(())
    }

    pub fn status(&self) -> Result<RoomStatus> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room state lock failed"))?
            .as_ref()
            .map(RoomRuntime::status)
            .unwrap_or_else(RoomStatus::stopped))
    }

    pub fn broadcast_playback(&self, playback: RoomPlaybackState) -> Result<()> {
        let guard = self.inner.lock().map_err(|_| anyhow!("Room state lock failed"))?;
        let Some(runtime) = guard.as_ref() else {
            return Err(anyhow!("No room is running."));
        };
        let mut state = runtime.state.lock().map_err(|_| anyhow!("Room shared state lock failed"))?;
        state.playback = Some(playback.clone());
        state
            .clients
            .retain(|client| client.tx.send(RoomWireMessage::PlaybackState(playback.clone())).is_ok());
        Ok(())
    }

    pub fn kick_user(&self, user_id: u64) -> Result<()> {
        let guard = self.inner.lock().map_err(|_| anyhow!("Room state lock failed"))?;
        let Some(runtime) = guard.as_ref() else {
            return Err(anyhow!("No room is running."));
        };

        let kicked = {
            let mut state = runtime.state.lock().map_err(|_| anyhow!("Room shared state lock failed"))?;
            let Some(index) = state.clients.iter().position(|client| client.user.id == user_id) else {
                return Err(anyhow!("User is not in the room."));
            };
            state.clients.remove(index)
        };

        let _ = kicked.tx.send(RoomWireMessage::RoomKicked {
            reason: "The host removed you from the room.".to_string(),
        });
        Ok(())
    }
}

impl RoomRuntime {
    fn status(&self) -> RoomStatus {
        let users = self
            .state
            .lock()
            .map(|state| state.clients.iter().map(|client| client.user.clone()).collect::<Vec<_>>())
            .unwrap_or_default();
        let public_join = self
            .config
            .public_addr
            .as_ref()
            .map(|addr| format!("{addr}:{}", self.config.port));

        RoomStatus {
            running: true,
            name: Some(self.config.name.clone()),
            bind_addr: Some(self.config.bind_addr.clone()),
            port: Some(self.config.port),
            share_addr: Some(self.config.share_addr.clone()),
            public_addr: self.config.public_addr.clone(),
            local_join: Some(format!("{}:{}", self.config.share_addr, self.config.port)),
            public_join,
            connected_users: users.len(),
            users,
            max_users: self.config.max_users,
            allow_guest_queue: self.config.allow_guest_queue,
        }
    }
}

impl RoomStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            name: None,
            bind_addr: None,
            port: None,
            share_addr: None,
            public_addr: None,
            local_join: None,
            public_join: None,
            connected_users: 0,
            users: Vec::new(),
            max_users: None,
            allow_guest_queue: false,
        }
    }
}

async fn handle_client(
    stream: TcpStream,
    remote_addr: SocketAddr,
    client_id: u64,
    config: RoomConfig,
    state: Arc<Mutex<RoomSharedState>>,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    let Some(line) = lines.next_line().await? else {
        return Ok(());
    };
    let message: RoomWireMessage = serde_json::from_str(&line)?;

    let RoomWireMessage::RoomJoin {
        room_name,
        password,
        display_name,
    } = message else {
        write_message(&mut writer, &RoomWireMessage::AuthError {
            reason: "Expected room_join as the first message.".to_string(),
        }).await?;
        return Ok(());
    };

    if room_name != config.name || hash_password(&password) != config.password_hash {
        write_message(&mut writer, &RoomWireMessage::AuthError {
            reason: "Room name or password is incorrect.".to_string(),
        }).await?;
        return Ok(());
    }

    let (tx, mut rx) = mpsc::unbounded_channel();
    let full = {
        let shared = state.lock().map_err(|_| anyhow!("Room shared state lock failed"))?;
        config
            .max_users
            .map(|max_users| shared.clients.len() >= max_users)
            .unwrap_or(false)
    };

    if full {
        write_message(&mut writer, &RoomWireMessage::AuthError {
            reason: "Room is full.".to_string(),
        })
        .await?;
        return Ok(());
    }

    let playback = {
        let mut shared = state.lock().map_err(|_| anyhow!("Room shared state lock failed"))?;
        let user = RoomUser {
            id: client_id,
            display_name: sanitize_display_name(&display_name),
            remote_addr: remote_addr.to_string(),
            joined_at: chrono::Utc::now().timestamp_millis(),
        };
        shared.clients.push(RoomClient { user, tx });
        shared.playback.clone()
    };

    write_message(&mut writer, &RoomWireMessage::AuthSuccess {
        room_name: config.name.clone(),
        playback,
        allow_guest_queue: config.allow_guest_queue,
    }).await?;

    loop {
        tokio::select! {
            Some(message) = rx.recv() => {
                if write_message(&mut writer, &message).await.is_err() {
                    break;
                }
                if matches!(message, RoomWireMessage::RoomKicked { .. }) {
                    break;
                }
            }
            line = lines.next_line() => {
                match line {
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => break,
                }
            }
        }
    }

    if let Ok(mut shared) = state.lock() {
        shared.clients.retain(|client| client.user.id != client_id);
    }
    Ok(())
}

async fn write_message(writer: &mut tokio::net::tcp::OwnedWriteHalf, message: &RoomWireMessage) -> Result<()> {
    writer.write_all(serde_json::to_string(message)?.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    Ok(())
}

pub async fn join_probe(request: RoomJoinRequest) -> Result<RoomJoinResult> {
    let stream = TcpStream::connect((request.host.as_str(), request.port)).await?;
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    let join = RoomWireMessage::RoomJoin {
        room_name: request.room_name,
        password: request.password,
        display_name: request.display_name,
    };
    write_message(&mut writer, &join).await?;

    let Some(line) = lines.next_line().await? else {
        return Err(anyhow!("Room closed before authentication."));
    };
    let response: RoomWireMessage = serde_json::from_str(&line)?;
    match response {
        RoomWireMessage::AuthSuccess { playback, .. } => Ok(RoomJoinResult {
            success: true,
            message: "Joined room.".to_string(),
            playback,
        }),
        RoomWireMessage::AuthError { reason } => Ok(RoomJoinResult {
            success: false,
            message: reason,
            playback: None,
        }),
        _ => Err(anyhow!("Unexpected room response.")),
    }
}

fn sanitize_room_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.len() < 2 || trimmed.len() > 48 {
        return Err(anyhow!("Room name must be 2 to 48 characters."));
    }
    if !trimmed.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_')) {
        return Err(anyhow!("Room name can only contain letters, numbers, spaces, dashes, and underscores."));
    }
    Ok(trimmed.to_string())
}

fn sanitize_display_name(name: &str) -> String {
    let trimmed = name.trim();
    let cleaned = trimmed
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_'))
        .take(32)
        .collect::<String>();

    if cleaned.is_empty() {
        "Guest".to_string()
    } else {
        cleaned
    }
}

fn hash_password(password: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(b"loavy-room-v1:");
    hasher.update(password.as_bytes());
    BASE64.encode(hasher.finalize())
}

fn local_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip().to_string())
}

async fn public_ip() -> Result<String> {
    let ip = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?
        .get("https://api.ipify.org")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    Ok(ip.trim().to_string())
}
