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
    pub total_files: usize,
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
    pub allow_guest_control: bool,
    pub guest_song_dir: Option<String>,
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
    pub allow_guest_control: bool,
    pub guest_song_dir: Option<String>,
    pub network_addresses: Vec<RoomNetworkAddress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomNetworkAddress {
    pub interface_name: String,
    pub address: String,
    pub join_address: String,
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
    pub stream_path: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomClientStatus {
    pub connected: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub room_name: Option<String>,
    pub display_name: Option<String>,
    pub connected_at: Option<i64>,
    pub allow_guest_control: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRoom {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub password_required: bool,
    pub connected_users: usize,
    pub max_users: Option<usize>,
    pub allow_guest_control: bool,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomGuestTrack {
    pub playback: RoomPlaybackState,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub track_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLyrics {
    pub track_id: i64,
    pub plain_text: Option<String>,
    pub synced_text: Option<String>,
    pub source: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLyricsUpdate {
    pub track_id: i64,
    pub plain_text: Option<String>,
    pub synced_text: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPlaybackStats {
    pub track_id: i64,
    pub last_played_at: i64,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderEntry {
    pub root_id: i64,
    pub relative_path: String,
    pub name: String,
    pub path: String,
    pub direct_track_count: usize,
    pub indexed_track_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LibraryTrackCopyConflictAction {
    Report,
    KeepBoth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LibraryTrackCopyResult {
    Copied {
        folder: LibraryFolderEntry,
        track: Track,
    },
    AlreadyPresent {
        folder: LibraryFolderEntry,
        track: Track,
    },
    Conflict {
        folder: LibraryFolderEntry,
        existing_path: String,
        suggested_file_name: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PlaylistFolderCreateResult {
    Created {
        folder: LibraryFolderEntry,
        copy: Option<LibraryTrackCopyResult>,
    },
    AlreadyExists {
        folder: LibraryFolderEntry,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderListing {
    pub root_id: i64,
    pub relative_path: String,
    pub path: String,
    pub folders: Vec<LibraryFolderEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRenameResult {
    pub root_id: i64,
    pub old_relative_path: String,
    pub new_relative_path: String,
    pub path: String,
    pub affected_track_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInspection {
    pub root_id: i64,
    pub relative_path: String,
    pub path: String,
    pub indexed_track_count: usize,
    pub descendant_folder_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDeleteResult {
    pub root_id: i64,
    pub relative_path: String,
    pub path: String,
    pub removed_track_ids: Vec<i64>,
    pub already_missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackDeleteResult {
    pub track_id: i64,
    pub path: String,
    pub already_missing: bool,
    pub cover_removed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChange {
    pub kind: String,
    pub track_ids: Vec<i64>,
    pub root_id: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::{
        LibraryFolderEntry, LibraryTrackCopyConflictAction, LibraryTrackCopyResult,
        PlaylistFolderCreateResult,
    };

    fn folder() -> LibraryFolderEntry {
        LibraryFolderEntry {
            root_id: 1,
            relative_path: "PLAYLISTS/Mix".to_string(),
            name: "Mix".to_string(),
            path: r"C:\Music\PLAYLISTS\Mix".to_string(),
            direct_track_count: 0,
            indexed_track_count: 0,
        }
    }

    #[test]
    fn folder_playlist_results_are_frontend_friendly_discriminated_unions() {
        let conflict = serde_json::to_value(LibraryTrackCopyResult::Conflict {
            folder: folder(),
            existing_path: r"C:\Music\PLAYLISTS\Mix\song.mp3".to_string(),
            suggested_file_name: "song (2).mp3".to_string(),
        })
        .unwrap();
        assert_eq!(conflict["status"], "conflict");
        assert_eq!(conflict["existing_path"], serde_json::Value::Null);
        assert_eq!(conflict["existingPath"], r"C:\Music\PLAYLISTS\Mix\song.mp3");
        assert_eq!(conflict["suggestedFileName"], "song (2).mp3");

        let existing =
            serde_json::to_value(PlaylistFolderCreateResult::AlreadyExists { folder: folder() })
                .unwrap();
        assert_eq!(existing["status"], "alreadyExists");
        assert_eq!(
            serde_json::from_str::<LibraryTrackCopyConflictAction>(r#""keepBoth""#).unwrap(),
            LibraryTrackCopyConflictAction::KeepBoth
        );
    }
}
