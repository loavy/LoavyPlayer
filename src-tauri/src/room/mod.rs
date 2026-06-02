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
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
    time::timeout,
};

use crate::models::{
    RoomClientStatus, RoomCreateRequest, RoomJoinRequest, RoomJoinResult, RoomPlaybackState,
    RoomStatus, RoomUser,
};

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
        allow_guest_control: bool,
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
    GuestPlaybackState(RoomPlaybackState),
    LibraryRescanRequest,
}

#[derive(Clone)]
pub struct RoomManager {
    inner: Arc<Mutex<Option<RoomRuntime>>>,
    next_client_id: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct RoomClientManager {
    inner: Arc<Mutex<Option<RoomGuestRuntime>>>,
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
    allow_guest_control: bool,
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

struct RoomGuestRuntime {
    host: String,
    port: u16,
    room_name: String,
    display_name: String,
    connected_at: i64,
    allow_guest_control: bool,
    tx: mpsc::UnboundedSender<RoomWireMessage>,
    handle: JoinHandle<()>,
}

impl RoomManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            next_client_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub async fn start(&self, app: AppHandle, request: RoomCreateRequest) -> Result<RoomStatus> {
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
            allow_guest_control: request.allow_guest_control,
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
                let app = app.clone();
                let client_id = next_client_id.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let _ = handle_client(app, stream, remote_addr, client_id, config, state).await;
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

impl RoomClientManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn join(&self, app: AppHandle, request: RoomJoinRequest) -> Result<RoomJoinResult> {
        self.leave()?;

        let stream = connect_room_stream(&request.host, request.port).await?;
        let (reader, mut writer) = stream.into_split();
        let mut lines = BufReader::new(reader).lines();
        let join = RoomWireMessage::RoomJoin {
            room_name: request.room_name.clone(),
            password: request.password.clone(),
            display_name: request.display_name.clone(),
        };
        write_message(&mut writer, &join).await?;

        let Some(line) = lines.next_line().await? else {
            return Err(anyhow!("Room closed before authentication."));
        };
        let response: RoomWireMessage = serde_json::from_str(&line)?;
        let (playback, allow_guest_control) = match response {
            RoomWireMessage::AuthSuccess { playback, allow_guest_control, .. } => (playback, allow_guest_control),
            RoomWireMessage::AuthError { reason } => {
                return Ok(RoomJoinResult {
                    success: false,
                    message: reason,
                    playback: None,
                });
            }
            _ => return Err(anyhow!("Unexpected room response.")),
        };

        if let Some(playback) = playback.clone() {
            let _ = app.emit("room://playback-state", playback);
        }

        let host = request.host;
        let port = request.port;
        let room_name = request.room_name;
        let display_name = sanitize_display_name(&request.display_name);
        let connected_at = chrono::Utc::now().timestamp_millis();
        let (tx, mut rx) = mpsc::unbounded_channel::<RoomWireMessage>();
        let handle = tokio::spawn(async move {
            let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
            loop {
                tokio::select! {
                    Some(outbound) = rx.recv() => {
                        if write_message(&mut writer, &outbound).await.is_err() {
                            break;
                        }
                    }
                    _ = heartbeat.tick() => {
                        let heartbeat = RoomWireMessage::RoomHeartbeat {
                            timestamp_ms: chrono::Utc::now().timestamp_millis(),
                        };
                        if write_message(&mut writer, &heartbeat).await.is_err() {
                            break;
                        }
                    }
                    line = lines.next_line() => {
                        match line {
                            Ok(Some(message)) => {
                                match serde_json::from_str::<RoomWireMessage>(&message) {
                                    Ok(RoomWireMessage::PlaybackState(playback)) => {
                                        let _ = app.emit("room://playback-state", playback);
                                    }
                                    Ok(RoomWireMessage::RoomKicked { reason }) => {
                                        let _ = app.emit("room://kicked", reason);
                                        break;
                                    }
                                    Ok(RoomWireMessage::RoomError { message }) => {
                                        let _ = app.emit("room://error", message);
                                    }
                                    _ => {}
                                }
                            }
                            Ok(None) | Err(_) => break,
                        }
                    }
                }
            }
            let _ = app.emit("room://disconnected", ());
        });

        *self.inner.lock().map_err(|_| anyhow!("Room client lock failed"))? = Some(RoomGuestRuntime {
            host,
            port,
            room_name,
            display_name,
            connected_at,
            allow_guest_control,
            tx,
            handle,
        });

        Ok(RoomJoinResult {
            success: true,
            message: "Joined room. You will stay connected until you leave or the host removes you.".to_string(),
            playback,
        })
    }

    pub fn send_guest_playback(&self, playback: RoomPlaybackState) -> Result<()> {
        let guard = self.inner.lock().map_err(|_| anyhow!("Room client lock failed"))?;
        let Some(runtime) = guard.as_ref() else {
            return Err(anyhow!("You are not connected to a room."));
        };
        if !runtime.allow_guest_control {
            return Err(anyhow!("The host does not allow guests to change songs."));
        }
        runtime
            .tx
            .send(RoomWireMessage::GuestPlaybackState(playback))
            .map_err(|_| anyhow!("Room connection is no longer active."))
    }

    pub fn request_host_scan(&self) -> Result<()> {
        let guard = self.inner.lock().map_err(|_| anyhow!("Room client lock failed"))?;
        let Some(runtime) = guard.as_ref() else {
            return Ok(());
        };
        if !runtime.allow_guest_control {
            return Err(anyhow!("The host does not allow guests to change songs."));
        }
        runtime
            .tx
            .send(RoomWireMessage::LibraryRescanRequest)
            .map_err(|_| anyhow!("Room connection is no longer active."))
    }

    pub fn leave(&self) -> Result<()> {
        if let Some(runtime) = self.inner.lock().map_err(|_| anyhow!("Room client lock failed"))?.take() {
            runtime.handle.abort();
        }
        Ok(())
    }

    pub fn status(&self) -> Result<RoomClientStatus> {
        let mut guard = self.inner.lock().map_err(|_| anyhow!("Room client lock failed"))?;
        if guard.as_ref().map(|runtime| runtime.handle.is_finished()).unwrap_or(false) {
            guard.take();
        }

        Ok(guard
            .as_ref()
            .map(|runtime| RoomClientStatus {
                connected: true,
                host: Some(runtime.host.clone()),
                port: Some(runtime.port),
                room_name: Some(runtime.room_name.clone()),
                display_name: Some(runtime.display_name.clone()),
                connected_at: Some(runtime.connected_at),
                allow_guest_control: runtime.allow_guest_control,
            })
            .unwrap_or(RoomClientStatus {
                connected: false,
                host: None,
                port: None,
                room_name: None,
                display_name: None,
                connected_at: None,
                allow_guest_control: false,
            }))
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
            allow_guest_control: self.config.allow_guest_control,
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
            allow_guest_control: false,
        }
    }
}

async fn handle_client(
    app: AppHandle,
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
        allow_guest_control: config.allow_guest_control,
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
                    Ok(Some(message)) => {
                        match serde_json::from_str::<RoomWireMessage>(&message) {
                            Ok(RoomWireMessage::GuestPlaybackState(playback)) => {
                                if config.allow_guest_control {
                                    let _ = app.emit("room://guest-playback-state", playback);
                                } else {
                                    let _ = write_message(&mut writer, &RoomWireMessage::RoomError {
                                        message: "The host does not allow guests to change songs.".to_string(),
                                    }).await;
                                }
                            }
                            Ok(RoomWireMessage::LibraryRescanRequest) => {
                                if config.allow_guest_control {
                                    let _ = app.emit("room://guest-scan-request", ());
                                }
                            }
                            _ => {}
                        }
                    }
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
    let stream = connect_room_stream(&request.host, request.port).await?;

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
            message: "Connection check succeeded. Use Join room to stay connected.".to_string(),
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

async fn connect_room_stream(host: &str, port: u16) -> Result<TcpStream> {
    timeout(Duration::from_secs(5), TcpStream::connect((host, port)))
        .await
        .map_err(|_| anyhow!(connection_help(host, port)))?
        .map_err(|err| anyhow!("{}\n\n{err}", connection_help(host, port)))
}

fn connection_help(host: &str, port: u16) -> String {
    format!(
        "Could not reach {host}:{port}. If you are testing on this same PC, use 127.0.0.1. If you are testing from another device on the same Wi-Fi, use the LAN/VPN address. The public address usually only works for people outside your network after TCP port {port} is forwarded to this PC and Windows Firewall allows Loavy Player."
    )
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
