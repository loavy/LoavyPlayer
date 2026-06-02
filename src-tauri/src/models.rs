use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub path: String,
    pub file_name: String,
    pub file_ext: String,
    pub file_size: i64,
    pub modified_at: i64,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<i32>,
    pub track_number: Option<i32>,
    pub duration_ms: Option<i64>,
    pub cover_path: Option<String>,
    pub favorite: bool,
    pub date_added: i64,
    pub last_played_at: Option<i64>,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub title: String,
    pub artist: Option<String>,
    pub year: Option<i32>,
    pub cover_path: Option<String>,
    pub track_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub name: String,
    pub track_count: i64,
    pub album_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicFolder {
    pub id: i64,
    pub path: String,
    pub enabled: bool,
    pub created_at: i64,
    pub last_scanned_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub folders_scanned: usize,
    pub files_seen: usize,
    pub tracks_added_or_updated: usize,
    pub tracks_removed: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub running: bool,
    pub folders_scanned: usize,
    pub files_seen: usize,
    pub tracks_added_or_updated: usize,
    pub tracks_removed: usize,
    pub current_path: Option<String>,
    pub cancelled: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanTaskState {
    pub running: bool,
    pub cancel_requested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyUpdate {
    pub provider: String,
    pub key_value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingUpdate {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetcherDescriptor {
    pub id: String,
    pub name: String,
    pub capabilities: Vec<String>,
    pub requires_api_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomCreateRequest {
    pub name: String,
    pub password: String,
    pub max_users: Option<usize>,
    pub allow_guest_queue: bool,
    pub bind_addr: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomJoinRequest {
    pub host: String,
    pub port: u16,
    pub room_name: String,
    pub password: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomStatus {
    pub running: bool,
    pub name: Option<String>,
    pub bind_addr: Option<String>,
    pub port: Option<u16>,
    pub share_addr: Option<String>,
    pub public_addr: Option<String>,
    pub local_join: Option<String>,
    pub public_join: Option<String>,
    pub connected_users: usize,
    pub users: Vec<RoomUser>,
    pub max_users: Option<usize>,
    pub allow_guest_queue: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomUser {
    pub id: u64,
    pub display_name: String,
    pub remote_addr: String,
    pub joined_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomPlaybackState {
    pub track_id: Option<i64>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_path: Option<String>,
    pub duration_ms: Option<i64>,
    pub position_ms: i64,
    pub playing: bool,
    pub host_timestamp_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomJoinResult {
    pub success: bool,
    pub message: String,
    pub playback: Option<RoomPlaybackState>,
}
