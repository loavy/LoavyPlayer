use std::{
    collections::{HashMap, HashSet},
    io::SeekFrom,
    net::{Ipv4Addr, SocketAddr, UdpSocket as StdUdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use if_addrs::{get_if_addrs, IfAddr};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Emitter};
use tokio::{
    fs::{File as AsyncFile, OpenOptions},
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
    net::{tcp::OwnedWriteHalf, TcpListener, TcpStream, UdpSocket},
    sync::{mpsc, Notify},
    task::JoinHandle,
    time::{timeout, Instant},
};

use crate::models::{
    DiscoveredRoom, RoomClientStatus, RoomCreateRequest, RoomGuestTrack, RoomJoinRequest,
    RoomJoinResult, RoomNetworkAddress, RoomPlaybackState, RoomStatus, RoomUser,
};

const DISCOVERY_PORT: u16 = 39176;
const DISCOVERY_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 39, 176);
const DISCOVERY_QUERY: &[u8] = b"LOAVY_ROOM_DISCOVER_V1";
const MAX_GUEST_TRACK_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const GUEST_TRACK_CHUNK_BYTES: usize = 256 * 1024;
const GUEST_PLAYBACK_START_BYTES: u64 = 256 * 1024;
const STREAM_WRITE_CHUNK_BYTES: usize = 64 * 1024;
static NEXT_UPLOAD_ID: AtomicU64 = AtomicU64::new(1);

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
    GuestTrackStart {
        upload_id: u64,
        file_name: String,
        file_size: u64,
        playback: RoomPlaybackState,
    },
    GuestTrackChunk {
        upload_id: u64,
        data: String,
    },
    GuestTrackComplete {
        upload_id: u64,
    },
    LibraryRescanRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryAnnouncement {
    protocol: String,
    name: String,
    port: u16,
    password_required: bool,
    connected_users: usize,
    max_users: Option<usize>,
    allow_guest_control: bool,
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
    discovery_handle: JoinHandle<()>,
}

#[derive(Clone)]
struct RoomConfig {
    name: String,
    password_hash: String,
    max_users: Option<usize>,
    allow_guest_queue: bool,
    allow_guest_control: bool,
    guest_song_dir: Option<PathBuf>,
    bind_addr: String,
    port: u16,
    share_addr: String,
    public_addr: Option<String>,
    network_addresses: Vec<RoomNetworkAddress>,
}

struct RoomSharedState {
    playback: Option<RoomPlaybackState>,
    clients: Vec<RoomClient>,
    streams: HashMap<String, Arc<RoomStream>>,
    guest_tracks: HashMap<(u64, i64), GuestHostedTrack>,
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
    uploaded_tracks: Arc<Mutex<HashSet<String>>>,
    tx: mpsc::UnboundedSender<RoomGuestOutbound>,
    handle: JoinHandle<()>,
}

struct GuestHostedTrack {
    track_id: i64,
    stream_path: String,
}

enum RoomGuestOutbound {
    Wire(RoomWireMessage),
    Upload {
        path: String,
        playback: RoomPlaybackState,
    },
}

struct IncomingGuestTrack {
    upload_id: u64,
    expected_size: u64,
    written: u64,
    path: PathBuf,
    file: AsyncFile,
    playback: RoomPlaybackState,
    stream: Arc<RoomStream>,
    stream_path: String,
    host_track_id: i64,
    started: bool,
}

struct RoomStream {
    path: String,
    total_len: AtomicU64,
    available: AtomicU64,
    complete: AtomicBool,
    changed: Notify,
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
        let guest_song_dir = if request.allow_guest_control {
            let value = request
                .guest_song_dir
                .as_deref()
                .ok_or_else(|| anyhow!("Choose where guest songs should be saved."))?;
            Some(prepare_guest_song_dir(value)?)
        } else {
            None
        };

        let bind_addr = request.bind_addr.unwrap_or_else(|| "0.0.0.0".to_string());
        let port = request.port.unwrap_or(0);
        let listener = TcpListener::bind((bind_addr.as_str(), port)).await?;
        let local_addr = listener.local_addr()?;
        let network_addresses = network_addresses(local_addr.port());
        let share_addr = network_addresses
            .first()
            .map(|entry| entry.address.clone())
            .or_else(local_ip)
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let config = RoomConfig {
            name,
            password_hash: hash_password(&request.password),
            max_users: request.max_users,
            allow_guest_queue: request.allow_guest_queue,
            allow_guest_control: request.allow_guest_control,
            guest_song_dir,
            bind_addr,
            port: local_addr.port(),
            share_addr,
            public_addr: None,
            network_addresses,
        };
        let state = Arc::new(Mutex::new(RoomSharedState {
            playback: None,
            clients: Vec::new(),
            streams: HashMap::new(),
            guest_tracks: HashMap::new(),
        }));

        let server_config = config.clone();
        let server_state = state.clone();
        let discovery_config = config.clone();
        let discovery_state = state.clone();
        let discovery_handle = tokio::spawn(async move {
            run_discovery_responder(discovery_config, discovery_state).await;
        });
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

        let runtime = RoomRuntime {
            config,
            state,
            handle,
            discovery_handle,
        };
        let status = runtime.status();
        *self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room state lock failed"))? = Some(runtime);
        Ok(status)
    }

    pub fn stop(&self) -> Result<()> {
        if let Some(runtime) = self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room state lock failed"))?
            .take()
        {
            runtime.handle.abort();
            runtime.discovery_handle.abort();
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

    pub fn broadcast_playback(
        &self,
        playback: &mut RoomPlaybackState,
        stream_file: Option<String>,
    ) -> Result<()> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room state lock failed"))?;
        let Some(runtime) = guard.as_ref() else {
            return Err(anyhow!("No room is running."));
        };
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| anyhow!("Room shared state lock failed"))?;
        if let Some(stream_file) = stream_file {
            let token = stream_token(&stream_file);
            state
                .streams
                .insert(token.clone(), Arc::new(RoomStream::complete(stream_file)?));
            playback.stream_path = Some(format!("/stream/{token}"));
        } else if let Some(current) = state.playback.as_ref() {
            if same_track_metadata(playback, current) {
                playback.stream_path = current.stream_path.clone();
                if current.track_id.unwrap_or_default() < 0 {
                    playback.track_id = current.track_id;
                }
            }
        }
        state.playback = Some(playback.clone());
        state.clients.retain(|client| {
            client
                .tx
                .send(RoomWireMessage::PlaybackState(playback.clone()))
                .is_ok()
        });
        Ok(())
    }

    pub fn kick_user(&self, user_id: u64) -> Result<()> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room state lock failed"))?;
        let Some(runtime) = guard.as_ref() else {
            return Err(anyhow!("No room is running."));
        };

        let kicked = {
            let mut state = runtime
                .state
                .lock()
                .map_err(|_| anyhow!("Room shared state lock failed"))?;
            let Some(index) = state
                .clients
                .iter()
                .position(|client| client.user.id == user_id)
            else {
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
            RoomWireMessage::AuthSuccess {
                playback,
                allow_guest_control,
                ..
            } => (playback, allow_guest_control),
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
        let uploaded_tracks = Arc::new(Mutex::new(HashSet::new()));
        let upload_cache = uploaded_tracks.clone();
        let (tx, mut rx) = mpsc::unbounded_channel::<RoomGuestOutbound>();
        let handle = tokio::spawn(async move {
            let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
            loop {
                tokio::select! {
                    Some(outbound) = rx.recv() => {
                        match outbound {
                            RoomGuestOutbound::Wire(message) => {
                                if write_message(&mut writer, &message).await.is_err() {
                                    break;
                                }
                            }
                            RoomGuestOutbound::Upload { path, playback } => {
                                if let Err(error) = send_guest_track_upload(&mut writer, &path, playback).await {
                                    if let Ok(mut uploaded) = upload_cache.lock() {
                                        uploaded.remove(&path);
                                    }
                                    let _ = app.emit("room://error", format!("Could not send guest song: {error}"));
                                }
                            }
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

        *self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room client lock failed"))? = Some(RoomGuestRuntime {
            host,
            port,
            room_name,
            display_name,
            connected_at,
            allow_guest_control,
            uploaded_tracks,
            tx,
            handle,
        });

        Ok(RoomJoinResult {
            success: true,
            message:
                "Joined room. You will stay connected until you leave or the host removes you."
                    .to_string(),
            playback,
        })
    }

    pub fn send_guest_playback(&self, playback: RoomPlaybackState) -> Result<()> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room client lock failed"))?;
        let Some(runtime) = guard.as_ref() else {
            return Err(anyhow!("You are not connected to a room."));
        };
        if !runtime.allow_guest_control {
            return Err(anyhow!("The host does not allow guests to change songs."));
        }
        runtime
            .tx
            .send(RoomGuestOutbound::Wire(
                RoomWireMessage::GuestPlaybackState(playback),
            ))
            .map_err(|_| anyhow!("Room connection is no longer active."))
    }

    pub fn send_guest_track(&self, playback: RoomPlaybackState, path: String) -> Result<()> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room client lock failed"))?;
        let Some(runtime) = guard.as_ref() else {
            return Err(anyhow!("You are not connected to a room."));
        };
        if !runtime.allow_guest_control {
            return Err(anyhow!("The host does not allow guests to change songs."));
        }

        let metadata = std::fs::metadata(&path)
            .map_err(|_| anyhow!("The selected song file is no longer available."))?;
        if !metadata.is_file() {
            return Err(anyhow!("The selected song is not a file."));
        }
        if metadata.len() > MAX_GUEST_TRACK_BYTES {
            return Err(anyhow!("Guest songs cannot be larger than 2 GB."));
        }

        let should_upload = runtime
            .uploaded_tracks
            .lock()
            .map_err(|_| anyhow!("Guest upload state lock failed"))?
            .insert(path.clone());
        let outbound = if should_upload {
            RoomGuestOutbound::Upload {
                path: path.clone(),
                playback,
            }
        } else {
            RoomGuestOutbound::Wire(RoomWireMessage::GuestPlaybackState(playback))
        };
        if runtime.tx.send(outbound).is_err() {
            if should_upload {
                if let Ok(mut uploaded) = runtime.uploaded_tracks.lock() {
                    uploaded.remove(&path);
                }
            }
            return Err(anyhow!("Room connection is no longer active."));
        }
        Ok(())
    }

    pub fn request_host_scan(&self) -> Result<()> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room client lock failed"))?;
        let Some(runtime) = guard.as_ref() else {
            return Ok(());
        };
        if !runtime.allow_guest_control {
            return Err(anyhow!("The host does not allow guests to change songs."));
        }
        runtime
            .tx
            .send(RoomGuestOutbound::Wire(
                RoomWireMessage::LibraryRescanRequest,
            ))
            .map_err(|_| anyhow!("Room connection is no longer active."))
    }

    pub fn leave(&self) -> Result<()> {
        if let Some(runtime) = self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room client lock failed"))?
            .take()
        {
            runtime.handle.abort();
        }
        Ok(())
    }

    pub fn status(&self) -> Result<RoomClientStatus> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| anyhow!("Room client lock failed"))?;
        if guard
            .as_ref()
            .map(|runtime| runtime.handle.is_finished())
            .unwrap_or(false)
        {
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
            .map(|state| {
                state
                    .clients
                    .iter()
                    .map(|client| client.user.clone())
                    .collect::<Vec<_>>()
            })
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
            guest_song_dir: self
                .config
                .guest_song_dir
                .as_ref()
                .map(|path| display_filesystem_path(path)),
            network_addresses: self.config.network_addresses.clone(),
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
            guest_song_dir: None,
            network_addresses: Vec::new(),
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

    if line.starts_with("GET ") {
        let mut headers = Vec::new();
        while let Some(header) = lines.next_line().await? {
            if header.trim().is_empty() {
                break;
            }
            headers.push(header);
        }
        return handle_stream_request(line, headers, writer, state).await;
    }

    let message: RoomWireMessage = serde_json::from_str(&line)?;

    let RoomWireMessage::RoomJoin {
        room_name,
        password,
        display_name,
    } = message
    else {
        write_message(
            &mut writer,
            &RoomWireMessage::AuthError {
                reason: "Expected room_join as the first message.".to_string(),
            },
        )
        .await?;
        return Ok(());
    };

    if room_name != config.name || hash_password(&password) != config.password_hash {
        write_message(
            &mut writer,
            &RoomWireMessage::AuthError {
                reason: "Room name or password is incorrect.".to_string(),
            },
        )
        .await?;
        return Ok(());
    }

    let (tx, mut rx) = mpsc::unbounded_channel();
    let full = {
        let shared = state
            .lock()
            .map_err(|_| anyhow!("Room shared state lock failed"))?;
        config
            .max_users
            .map(|max_users| shared.clients.len() >= max_users)
            .unwrap_or(false)
    };

    if full {
        write_message(
            &mut writer,
            &RoomWireMessage::AuthError {
                reason: "Room is full.".to_string(),
            },
        )
        .await?;
        return Ok(());
    }

    let playback = {
        let mut shared = state
            .lock()
            .map_err(|_| anyhow!("Room shared state lock failed"))?;
        let user = RoomUser {
            id: client_id,
            display_name: sanitize_display_name(&display_name),
            remote_addr: remote_addr.to_string(),
            joined_at: chrono::Utc::now().timestamp_millis(),
        };
        shared.clients.push(RoomClient { user, tx });
        shared.playback.clone()
    };

    write_message(
        &mut writer,
        &RoomWireMessage::AuthSuccess {
            room_name: config.name.clone(),
            playback,
            allow_guest_queue: config.allow_guest_queue,
            allow_guest_control: config.allow_guest_control,
        },
    )
    .await?;

    let mut incoming_track: Option<IncomingGuestTrack> = None;
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
                            Ok(RoomWireMessage::GuestPlaybackState(mut playback)) => {
                                if config.allow_guest_control {
                                    if apply_guest_track_stream(&state, client_id, &mut playback).is_ok() {
                                        broadcast_guest_playback(&state, &playback);
                                        let _ = app.emit("room://guest-playback-state", playback);
                                    }
                                } else {
                                    let _ = write_message(&mut writer, &RoomWireMessage::RoomError {
                                        message: "The host does not allow guests to change songs.".to_string(),
                                    }).await;
                                }
                            }
                            Ok(RoomWireMessage::GuestTrackStart {
                                upload_id,
                                file_name,
                                file_size,
                                playback,
                            }) => {
                                if !config.allow_guest_control {
                                    let _ = write_message(&mut writer, &RoomWireMessage::RoomError {
                                        message: "The host does not allow guests to send songs.".to_string(),
                                    }).await;
                                    continue;
                                }
                                if let Some(previous) = incoming_track.take() {
                                    abandon_guest_track(previous).await;
                                }
                                match begin_guest_track(&config, upload_id, &file_name, file_size, playback).await {
                                    Ok(track) => incoming_track = Some(track),
                                    Err(error) => {
                                        let _ = write_message(&mut writer, &RoomWireMessage::RoomError {
                                            message: format!("Guest song was rejected: {error}"),
                                        }).await;
                                    }
                                }
                            }
                            Ok(RoomWireMessage::GuestTrackChunk { upload_id, data }) => {
                                let result = append_guest_track_chunk(
                                    incoming_track.as_mut(),
                                    upload_id,
                                    &data,
                                ).await;
                                if result.is_ok() {
                                    if let Some(track) = incoming_track.as_mut() {
                                        let start_at = track
                                            .expected_size
                                            .min(GUEST_PLAYBACK_START_BYTES);
                                        if !track.started && track.written >= start_at {
                                            start_guest_track(
                                                app.clone(),
                                                &state,
                                                client_id,
                                                config.port,
                                                track,
                                            );
                                        }
                                    }
                                } else if let Err(error) = result {
                                    if let Some(failed) = incoming_track.take() {
                                        abandon_guest_track(failed).await;
                                    }
                                    let _ = write_message(&mut writer, &RoomWireMessage::RoomError {
                                        message: format!("Guest song upload failed: {error}"),
                                    }).await;
                                }
                            }
                            Ok(RoomWireMessage::GuestTrackComplete { upload_id }) => {
                                let result = match incoming_track.take() {
                                    Some(track) if track.upload_id == upload_id => {
                                        finish_guest_track(
                                            app.clone(),
                                            state.clone(),
                                            client_id,
                                            config.port,
                                            track,
                                        ).await
                                    }
                                    Some(track) => {
                                        abandon_guest_track(track).await;
                                        Err(anyhow!("Upload identifier did not match."))
                                    }
                                    None => Err(anyhow!("No guest song upload is active.")),
                                };
                                if let Err(error) = result {
                                    let _ = write_message(&mut writer, &RoomWireMessage::RoomError {
                                        message: format!("Guest song upload failed: {error}"),
                                    }).await;
                                }
                            }
                            Ok(RoomWireMessage::LibraryRescanRequest)
                                if config.allow_guest_control =>
                            {
                                let _ = app.emit("room://guest-scan-request", ());
                            }
                            _ => {}
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        }
    }

    if let Some(incomplete) = incoming_track {
        abandon_guest_track(incomplete).await;
    }
    if let Ok(mut shared) = state.lock() {
        shared.clients.retain(|client| client.user.id != client_id);
    }
    Ok(())
}

async fn send_guest_track_upload(
    writer: &mut OwnedWriteHalf,
    path: &str,
    playback: RoomPlaybackState,
) -> Result<()> {
    let source_path = Path::new(path);
    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("The song file name is not valid UTF-8."))?
        .to_string();
    let mut file = AsyncFile::open(source_path).await?;
    let file_size = file.metadata().await?.len();
    if file_size > MAX_GUEST_TRACK_BYTES {
        return Err(anyhow!("Guest songs cannot be larger than 2 GB."));
    }

    let upload_id = NEXT_UPLOAD_ID.fetch_add(1, Ordering::SeqCst);
    write_message(
        writer,
        &RoomWireMessage::GuestTrackStart {
            upload_id,
            file_name,
            file_size,
            playback,
        },
    )
    .await?;

    let mut buffer = vec![0_u8; GUEST_TRACK_CHUNK_BYTES];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        write_message(
            writer,
            &RoomWireMessage::GuestTrackChunk {
                upload_id,
                data: BASE64.encode(&buffer[..read]),
            },
        )
        .await?;
    }
    write_message(writer, &RoomWireMessage::GuestTrackComplete { upload_id }).await
}

impl RoomStream {
    fn complete(path: String) -> Result<Self> {
        let total_len = std::fs::metadata(&path)?.len();
        Ok(Self {
            path,
            total_len: AtomicU64::new(total_len),
            available: AtomicU64::new(total_len),
            complete: AtomicBool::new(true),
            changed: Notify::new(),
        })
    }

    fn growing(path: String, total_len: u64) -> Self {
        Self {
            path,
            total_len: AtomicU64::new(total_len),
            available: AtomicU64::new(0),
            complete: AtomicBool::new(false),
            changed: Notify::new(),
        }
    }
}

async fn begin_guest_track(
    config: &RoomConfig,
    upload_id: u64,
    file_name: &str,
    file_size: u64,
    playback: RoomPlaybackState,
) -> Result<IncomingGuestTrack> {
    if file_size > MAX_GUEST_TRACK_BYTES {
        return Err(anyhow!("The file is larger than the 2 GB room limit."));
    }
    let directory = config
        .guest_song_dir
        .as_ref()
        .ok_or_else(|| anyhow!("The host did not configure a guest-song folder."))?;
    let safe_name = safe_guest_file_name(file_name);
    let (path, file) = create_unique_guest_file(directory, &safe_name).await?;
    let path_string = path.to_string_lossy().to_string();
    let token = stream_token(&path_string);
    Ok(IncomingGuestTrack {
        upload_id,
        expected_size: file_size,
        written: 0,
        path,
        file,
        playback,
        stream: Arc::new(RoomStream::growing(path_string, file_size)),
        stream_path: format!("/stream/{token}"),
        host_track_id: -(upload_id.min(i64::MAX as u64) as i64).max(1),
        started: false,
    })
}

async fn append_guest_track_chunk(
    track: Option<&mut IncomingGuestTrack>,
    upload_id: u64,
    data: &str,
) -> Result<()> {
    let track = track.ok_or_else(|| anyhow!("No guest song upload is active."))?;
    if track.upload_id != upload_id {
        return Err(anyhow!("Upload identifier did not match."));
    }
    let maximum_encoded_chunk = GUEST_TRACK_CHUNK_BYTES.div_ceil(3) * 4 + 16;
    if data.len() > maximum_encoded_chunk {
        return Err(anyhow!("The upload chunk was larger than allowed."));
    }
    let bytes = BASE64
        .decode(data)
        .map_err(|_| anyhow!("The upload contained an invalid data chunk."))?;
    let next_size = track.written.saturating_add(bytes.len() as u64);
    if next_size > track.expected_size || next_size > MAX_GUEST_TRACK_BYTES {
        return Err(anyhow!("The upload exceeded its declared size."));
    }
    track.file.write_all(&bytes).await?;
    track.file.flush().await?;
    track.written = next_size;
    track.stream.available.store(next_size, Ordering::Release);
    track.stream.changed.notify_waiters();
    Ok(())
}

fn start_guest_track(
    app: AppHandle,
    state: &Arc<Mutex<RoomSharedState>>,
    client_id: u64,
    port: u16,
    track: &mut IncomingGuestTrack,
) {
    if track.started {
        return;
    }

    let guest_track_id = track.playback.track_id;
    let mut playback = track.playback.clone();
    playback.track_id = Some(track.host_track_id);
    playback.cover_path = None;
    playback.stream_path = Some(track.stream_path.clone());
    let now = chrono::Utc::now().timestamp_millis();
    if playback.playing {
        let elapsed = now.saturating_sub(playback.host_timestamp_ms).max(0);
        playback.position_ms = playback.position_ms.saturating_add(elapsed);
        if let Some(duration) = playback.duration_ms {
            playback.position_ms = playback.position_ms.min(duration);
        }
    }
    playback.host_timestamp_ms = now;

    let token = track.stream_path.trim_start_matches("/stream/").to_string();
    let Ok(mut shared) = state.lock() else {
        return;
    };
    shared.streams.insert(token, track.stream.clone());
    if let Some(guest_track_id) = guest_track_id {
        shared.guest_tracks.insert(
            (client_id, guest_track_id),
            GuestHostedTrack {
                track_id: track.host_track_id,
                stream_path: track.stream_path.clone(),
            },
        );
    }
    shared.playback = Some(playback.clone());
    shared.clients.retain(|client| {
        client
            .tx
            .send(RoomWireMessage::PlaybackState(playback.clone()))
            .is_ok()
    });
    drop(shared);

    track.playback = playback.clone();
    track.started = true;
    let stream_url = format!("http://127.0.0.1:{port}{}", track.stream_path);
    let _ = app.emit(
        "room://guest-track-received",
        RoomGuestTrack {
            playback,
            path: stream_url,
        },
    );
}

async fn finish_guest_track(
    app: AppHandle,
    state: Arc<Mutex<RoomSharedState>>,
    client_id: u64,
    port: u16,
    mut track: IncomingGuestTrack,
) -> Result<()> {
    if track.written != track.expected_size {
        let error = anyhow!(
            "The upload ended at {} of {} bytes.",
            track.written,
            track.expected_size
        );
        abandon_guest_track(track).await;
        return Err(error);
    }
    if let Err(error) = async {
        track.file.flush().await?;
        track.file.sync_all().await
    }
    .await
    {
        abandon_guest_track(track).await;
        return Err(error.into());
    }
    track
        .stream
        .available
        .store(track.expected_size, Ordering::Release);
    if !track.started {
        start_guest_track(app, &state, client_id, port, &mut track);
    }
    track.stream.complete.store(true, Ordering::Release);
    track.stream.changed.notify_waiters();
    Ok(())
}

async fn abandon_guest_track(track: IncomingGuestTrack) {
    track
        .stream
        .total_len
        .store(track.written, Ordering::Release);
    track.stream.complete.store(true, Ordering::Release);
    track.stream.changed.notify_waiters();
    let remove = !track.started;
    let path = track.path.clone();
    drop(track.file);
    if remove {
        let _ = tokio::fs::remove_file(path).await;
    }
}

fn apply_guest_track_stream(
    state: &Arc<Mutex<RoomSharedState>>,
    client_id: u64,
    playback: &mut RoomPlaybackState,
) -> Result<()> {
    let shared = state
        .lock()
        .map_err(|_| anyhow!("Room shared state lock failed"))?;
    let hosted = playback
        .track_id
        .and_then(|track_id| shared.guest_tracks.get(&(client_id, track_id)));
    if let Some(hosted) = hosted {
        playback.track_id = Some(hosted.track_id);
        playback.stream_path = Some(hosted.stream_path.clone());
        playback.cover_path = None;
    } else if let Some(current) = shared.playback.as_ref() {
        if same_track_metadata(playback, current) {
            playback.track_id = current.track_id;
            playback.stream_path = current.stream_path.clone();
            if playback.stream_path.is_some() {
                playback.cover_path = None;
            }
        }
    }
    Ok(())
}

fn broadcast_guest_playback(state: &Arc<Mutex<RoomSharedState>>, playback: &RoomPlaybackState) {
    if let Ok(mut shared) = state.lock() {
        shared.playback = Some(playback.clone());
        shared.clients.retain(|client| {
            client
                .tx
                .send(RoomWireMessage::PlaybackState(playback.clone()))
                .is_ok()
        });
    }
}

fn same_track_metadata(left: &RoomPlaybackState, right: &RoomPlaybackState) -> bool {
    left.title == right.title && left.artist == right.artist && left.album == right.album
}

fn prepare_guest_song_dir(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value.trim());
    if value.trim().is_empty() {
        return Err(anyhow!("Choose where guest songs should be saved."));
    }
    std::fs::create_dir_all(&path)?;
    let path = path.canonicalize()?;
    if !path.is_dir() {
        return Err(anyhow!("The guest-song destination is not a folder."));
    }
    Ok(path)
}

fn safe_guest_file_name(value: &str) -> String {
    let file_name = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("guest-song");
    let cleaned = file_name
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    if cleaned.is_empty() {
        "guest-song".to_string()
    } else {
        cleaned.chars().take(180).collect()
    }
}

async fn create_unique_guest_file(
    directory: &Path,
    file_name: &str,
) -> Result<(PathBuf, AsyncFile)> {
    let source = Path::new(file_name);
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("guest-song");
    let extension = source.extension().and_then(|value| value.to_str());

    for suffix in 0..10_000 {
        let candidate_name = if suffix == 0 {
            file_name.to_string()
        } else if let Some(extension) = extension {
            format!("{stem} ({suffix}).{extension}")
        } else {
            format!("{stem} ({suffix})")
        };
        let candidate = directory.join(candidate_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(anyhow!(
        "Could not create a unique file name for the guest song."
    ))
}

async fn write_message(writer: &mut OwnedWriteHalf, message: &RoomWireMessage) -> Result<()> {
    writer
        .write_all(serde_json::to_string(message)?.as_bytes())
        .await?;
    writer.write_all(b"\n").await?;
    Ok(())
}

async fn handle_stream_request(
    request_line: String,
    headers: Vec<String>,
    mut writer: OwnedWriteHalf,
    state: Arc<Mutex<RoomSharedState>>,
) -> Result<()> {
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .trim_start_matches("/stream/")
        .split('?')
        .next()
        .unwrap_or_default()
        .to_string();
    let stream = {
        let shared = state
            .lock()
            .map_err(|_| anyhow!("Room shared state lock failed"))?;
        shared.streams.get(&path).cloned()
    };

    let Some(stream) = stream else {
        writer
            .write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    };

    let total_len = stream.total_len.load(Ordering::Acquire);
    if total_len == 0 {
        writer
            .write_all(b"HTTP/1.1 416 Range Not Satisfiable\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    }
    let range = parse_range(&headers);
    let (start, end, partial) = if let Some((start, requested_end)) = range {
        if start >= total_len {
            writer
                .write_all(
                    format!(
                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total_len}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await?;
            return Ok(());
        }
        (
            start,
            requested_end
                .unwrap_or_else(|| total_len.saturating_sub(1))
                .min(total_len.saturating_sub(1)),
            true,
        )
    } else {
        (0, total_len.saturating_sub(1), false)
    };
    let content_len = end.saturating_sub(start).saturating_add(1);
    let mime = content_type(Path::new(&stream.path));
    let header = if partial {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {}\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            mime,
            content_len,
            start,
            end,
            total_len
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            mime,
            content_len
        )
    };
    writer.write_all(header.as_bytes()).await?;
    let mut file = AsyncFile::open(&stream.path).await?;
    file.seek(SeekFrom::Start(start)).await?;
    let mut position = start;
    let mut buffer = vec![0_u8; STREAM_WRITE_CHUNK_BYTES];
    while position <= end {
        let changed = stream.changed.notified();
        let available = stream.available.load(Ordering::Acquire);
        if available <= position {
            if stream.complete.load(Ordering::Acquire) {
                break;
            }
            changed.await;
            continue;
        }
        let readable = available
            .saturating_sub(position)
            .min(end.saturating_sub(position).saturating_add(1))
            .min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..readable]).await?;
        if read == 0 {
            if stream.complete.load(Ordering::Acquire) {
                break;
            }
            tokio::task::yield_now().await;
            continue;
        }
        writer.write_all(&buffer[..read]).await?;
        position = position.saturating_add(read as u64);
    }
    writer.flush().await?;
    Ok(())
}

fn stream_token(path: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(b"loavy-stream-v1:");
    hasher.update(path.as_bytes());
    BASE64
        .encode(hasher.finalize())
        .replace(['/', '+', '='], "")
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

fn parse_range(headers: &[String]) -> Option<(u64, Option<u64>)> {
    let range = headers
        .iter()
        .find(|header| header.to_ascii_lowercase().starts_with("range: bytes="))?
        .split_once('=')?
        .1
        .split(',')
        .next()?;
    let (start, end) = range.split_once('-')?;
    let start = start.trim().parse::<u64>().ok()?;
    let end = end.trim();
    let end = if end.is_empty() {
        None
    } else {
        end.parse::<u64>().ok()
    };
    Some((start, end))
}

async fn run_discovery_responder(config: RoomConfig, state: Arc<Mutex<RoomSharedState>>) {
    let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)).await else {
        return;
    };
    let _ = socket.join_multicast_v4(DISCOVERY_GROUP, Ipv4Addr::UNSPECIFIED);
    let mut buffer = [0_u8; 1024];
    loop {
        let Ok((size, remote_addr)) = socket.recv_from(&mut buffer).await else {
            continue;
        };
        if &buffer[..size] != DISCOVERY_QUERY {
            continue;
        }
        let connected_users = state
            .lock()
            .map(|shared| shared.clients.len())
            .unwrap_or_default();
        let announcement = DiscoveryAnnouncement {
            protocol: "loavy-room-v1".to_string(),
            name: config.name.clone(),
            port: config.port,
            password_required: true,
            connected_users,
            max_users: config.max_users,
            allow_guest_control: config.allow_guest_control,
        };
        if let Ok(payload) = serde_json::to_vec(&announcement) {
            let _ = socket.send_to(&payload, remote_addr).await;
        }
    }
}

pub async fn discover_rooms() -> Result<Vec<DiscoveredRoom>> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    socket.set_broadcast(true)?;
    let _ = socket.set_multicast_ttl_v4(1);
    let mut discovery_targets = HashSet::from([Ipv4Addr::BROADCAST, DISCOVERY_GROUP]);
    if let Ok(interfaces) = get_if_addrs() {
        for interface in interfaces {
            let IfAddr::V4(address) = interface.addr else {
                continue;
            };
            if address.ip.is_loopback() {
                continue;
            }
            let broadcast = address.broadcast.unwrap_or_else(|| {
                Ipv4Addr::from(u32::from(address.ip) | !u32::from(address.netmask))
            });
            discovery_targets.insert(broadcast);
        }
    }
    for target in discovery_targets {
        let address = SocketAddr::from((target, DISCOVERY_PORT));
        let _ = socket.send_to(DISCOVERY_QUERY, address).await;
    }

    let deadline = Instant::now() + Duration::from_millis(650);
    let mut found = HashMap::<(String, u16), DiscoveredRoom>::new();
    let mut buffer = [0_u8; 2048];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let received = timeout(remaining, socket.recv_from(&mut buffer)).await;
        let Ok(Ok((size, remote_addr))) = received else {
            break;
        };
        let Ok(announcement) = serde_json::from_slice::<DiscoveryAnnouncement>(&buffer[..size])
        else {
            continue;
        };
        if announcement.protocol != "loavy-room-v1" {
            continue;
        }
        let host = remote_addr.ip().to_string();
        found.insert(
            (host.clone(), announcement.port),
            DiscoveredRoom {
                name: announcement.name,
                host,
                port: announcement.port,
                password_required: announcement.password_required,
                connected_users: announcement.connected_users,
                max_users: announcement.max_users,
                allow_guest_control: announcement.allow_guest_control,
                last_seen_at: chrono::Utc::now().timestamp_millis(),
            },
        );
    }
    let mut rooms = found.into_values().collect::<Vec<_>>();
    rooms.sort_by(|left, right| left.name.cmp(&right.name).then(left.host.cmp(&right.host)));
    Ok(rooms)
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
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '-' | '_'))
    {
        return Err(anyhow!(
            "Room name can only contain letters, numbers, spaces, dashes, and underscores."
        ));
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
    let socket = StdUdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip().to_string())
}

fn network_addresses(port: u16) -> Vec<RoomNetworkAddress> {
    let mut seen = HashSet::new();
    let mut addresses = get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| {
            let IfAddr::V4(address) = interface.addr else {
                return None;
            };
            if address.ip.is_loopback() || !seen.insert(address.ip) {
                return None;
            }
            Some(RoomNetworkAddress {
                interface_name: interface.name,
                address: address.ip.to_string(),
                join_address: format!("{}:{port}", address.ip),
            })
        })
        .collect::<Vec<_>>();
    addresses.sort_by(|left, right| {
        let left_vpn = interface_looks_like_vpn(&left.interface_name);
        let right_vpn = interface_looks_like_vpn(&right.interface_name);
        right_vpn
            .cmp(&left_vpn)
            .then(left.interface_name.cmp(&right.interface_name))
    });
    addresses
}

fn interface_looks_like_vpn(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "vpn",
        "tailscale",
        "zerotier",
        "radmin",
        "hamachi",
        "wireguard",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

fn display_filesystem_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_file_names_cannot_escape_the_destination() {
        let name = safe_guest_file_name(r"..\..\song:bad?.opus");
        assert!(!name.contains(['/', '\\', ':', '?']));
        assert!(name.ends_with(".opus"));
    }

    #[test]
    fn opus_streams_with_an_audio_content_type() {
        assert_eq!(content_type(Path::new("song.opus")), "audio/ogg");
    }

    #[tokio::test]
    async fn growing_stream_sends_bytes_that_arrive_after_playback_starts() {
        let path = std::env::temp_dir().join(format!(
            "loavy-growing-stream-{}-{}.opus",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        tokio::fs::write(&path, b"abc").await.unwrap();

        let stream = Arc::new(RoomStream::growing(path.to_string_lossy().to_string(), 6));
        stream.available.store(3, Ordering::Release);
        let state = Arc::new(Mutex::new(RoomSharedState {
            playback: None,
            clients: Vec::new(),
            streams: HashMap::from([("test".to_string(), stream.clone())]),
            guest_tracks: HashMap::new(),
        }));

        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let connect = tokio::spawn(TcpStream::connect(address));
        let (server, _) = listener.accept().await.unwrap();
        let mut client = connect.await.unwrap().unwrap();
        let (_, writer) = server.into_split();
        let server_task = tokio::spawn(handle_stream_request(
            "GET /stream/test HTTP/1.1".to_string(),
            Vec::new(),
            writer,
            state,
        ));

        let append_path = path.clone();
        let append_stream = stream.clone();
        let append_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let mut file = OpenOptions::new()
                .append(true)
                .open(append_path)
                .await
                .unwrap();
            file.write_all(b"def").await.unwrap();
            file.flush().await.unwrap();
            append_stream.available.store(6, Ordering::Release);
            append_stream.complete.store(true, Ordering::Release);
            append_stream.changed.notify_waiters();
        });

        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        append_task.await.unwrap();
        server_task.await.unwrap().unwrap();
        assert!(response.ends_with(b"abcdef"));
        let _ = tokio::fs::remove_file(path).await;
    }
}
