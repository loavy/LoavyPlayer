use std::sync::atomic::Ordering;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};

use crate::{
    downloader::{self, DownloadResult, DownloaderStatus, MediaDownloadRequest},
    fetchers::{self, FetchContext, FetchRequest},
    library,
    models::{
        Album, ApiKeyUpdate, Artist, DiscoveredRoom, FetcherDescriptor, MusicFolder, Playlist,
        RoomClientStatus, RoomCreateRequest, RoomJoinRequest, RoomJoinResult, RoomPlaybackState,
        RoomStatus, ScanProgress, ScanSummary, ScanTaskState, SettingUpdate, Track,
    },
    state::AppState,
};

type CommandResult<T> = Result<T, String>;

const BACKGROUND_TRAY_ID: &str = "loavy-background";
const TRAY_OPEN_ID: &str = "tray-open";
const TRAY_QUIT_ID: &str = "tray-quit";

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn sync_background_tray(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(BACKGROUND_TRAY_ID) {
        return tray.set_visible(enabled);
    }

    if !enabled {
        return Ok(());
    }

    let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open Loavy Player", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit Loavy Player", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id(BACKGROUND_TRAY_ID)
        .tooltip("Loavy Player")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_OPEN_ID => show_main_window(app),
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[tauri::command]
pub fn set_background_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> CommandResult<()> {
    let previous = state.background_mode.load(Ordering::SeqCst);
    sync_background_tray(&app, enabled).map_err(|err| err.to_string())?;

    if let Err(error) = state
        .db
        .lock()
        .map_err(|err| err.to_string())?
        .set_setting("backgroundMode", if enabled { "true" } else { "false" })
    {
        let _ = sync_background_tray(&app, previous);
        return Err(error.to_string());
    }

    state.background_mode.store(enabled, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn select_music_folder(state: State<'_, AppState>) -> CommandResult<Option<MusicFolder>> {
    let Some(path) = rfd::AsyncFileDialog::new().pick_folder().await else {
        return Ok(None);
    };

    let path = path.path().to_string_lossy().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    {
        let db = state.db.lock().map_err(|err| err.to_string())?;
        db.add_music_folder(&path, now)
            .map_err(|err| err.to_string())?;
    }

    let db = state.db.lock().map_err(|err| err.to_string())?;
    let folders = db.list_music_folders().map_err(|err| err.to_string())?;
    Ok(folders.into_iter().find(|folder| folder.path == path))
}

#[tauri::command]
pub async fn list_music_folders(state: State<'_, AppState>) -> CommandResult<Vec<MusicFolder>> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.list_music_folders().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn remove_music_folder(state: State<'_, AppState>, folder_id: i64) -> CommandResult<()> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.remove_music_folder(folder_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn scan_library(state: State<'_, AppState>) -> CommandResult<ScanSummary> {
    let app_data_dir = state.app_data_dir.clone();
    let db_path = state.db_path.clone();

    tokio::task::spawn_blocking(move || {
        let db = crate::db::Database::open(db_path).map_err(|err| err.to_string())?;
        library::scan_library(&db, &app_data_dir).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn start_library_scan(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    if !state.try_start_scan() {
        return Err("A library scan is already running.".to_string());
    }

    state.scan_cancel.store(false, Ordering::SeqCst);
    let app_data_dir = state.app_data_dir.clone();
    let db_path = state.db_path.clone();
    let cancel = state.scan_cancel.clone();
    let running = state.scan_running.clone();
    let cancel_for_cleanup = state.scan_cancel.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<ScanSummary, String> {
            let db = crate::db::Database::open(db_path).map_err(|err| err.to_string())?;
            library::scan_library_with_progress(&db, &app_data_dir, cancel.clone(), |progress| {
                let _ = app.emit("library://scan-progress", progress);
            })
            .map_err(|err| err.to_string())
        })();

        let was_cancelled = cancel_for_cleanup.load(Ordering::SeqCst);
        running.store(false, Ordering::SeqCst);
        cancel_for_cleanup.store(false, Ordering::SeqCst);

        match result {
            Ok(summary) => {
                let progress = ScanProgress {
                    running: false,
                    folders_scanned: summary.folders_scanned,
                    total_files: summary.files_seen,
                    files_seen: summary.files_seen,
                    tracks_added_or_updated: summary.tracks_added_or_updated,
                    tracks_removed: summary.tracks_removed,
                    current_path: None,
                    cancelled: was_cancelled,
                    errors: summary.errors,
                };
                let _ = app.emit("library://scan-finished", progress);
            }
            Err(error) => {
                let _ = app.emit("library://scan-error", error);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_library_scan(state: State<'_, AppState>) -> CommandResult<()> {
    state.scan_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn get_scan_state(state: State<'_, AppState>) -> CommandResult<ScanTaskState> {
    Ok(ScanTaskState {
        running: state.scan_running.load(Ordering::SeqCst),
        cancel_requested: state.scan_cancel.load(Ordering::SeqCst),
    })
}

#[tauri::command]
pub async fn list_tracks(
    state: State<'_, AppState>,
    query: Option<String>,
) -> CommandResult<Vec<Track>> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.list_tracks(query.as_deref())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn set_track_favorite(
    state: State<'_, AppState>,
    track_id: i64,
    favorite: bool,
) -> CommandResult<()> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.set_track_favorite(track_id, favorite)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn find_room_playback_track(
    state: State<'_, AppState>,
    playback: RoomPlaybackState,
) -> CommandResult<Option<Track>> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.find_track_for_room_playback(&playback)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_albums(state: State<'_, AppState>) -> CommandResult<Vec<Album>> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.list_albums().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_artists(state: State<'_, AppState>) -> CommandResult<Vec<Artist>> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.list_artists().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_playlists(state: State<'_, AppState>) -> CommandResult<Vec<Playlist>> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.list_playlists().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn create_playlist(state: State<'_, AppState>, name: String) -> CommandResult<Playlist> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.create_playlist(&name, chrono::Utc::now().timestamp_millis())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn add_track_to_playlist(
    state: State<'_, AppState>,
    playlist_id: i64,
    track_id: i64,
) -> CommandResult<()> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.add_track_to_playlist(playlist_id, track_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_playlist_tracks(
    state: State<'_, AppState>,
    playlist_id: i64,
) -> CommandResult<Vec<Track>> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.list_playlist_tracks(playlist_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn set_setting(state: State<'_, AppState>, update: SettingUpdate) -> CommandResult<()> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.set_setting(&update.key, &update.value)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_setting(state: State<'_, AppState>, key: String) -> CommandResult<Option<String>> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.get_setting(&key).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn set_api_key(state: State<'_, AppState>, update: ApiKeyUpdate) -> CommandResult<()> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.set_api_key(&update.provider, &update.key_value)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_fetchers() -> CommandResult<Vec<FetcherDescriptor>> {
    Ok(fetchers::descriptors())
}

#[tauri::command]
pub async fn download_media(
    app: AppHandle,
    state: State<'_, AppState>,
    request: MediaDownloadRequest,
) -> CommandResult<DownloadResult> {
    if !state.try_start_download() {
        return Err("A download is already running.".to_string());
    }

    state.download_cancel.store(false, Ordering::SeqCst);
    let default_destination = app
        .path()
        .download_dir()
        .unwrap_or_else(|_| state.app_data_dir.join("downloads"))
        .join("Loavy Player");
    let progress_app = app.clone();
    let cancel = state.download_cancel.clone();

    let result = downloader::download_media(
        request,
        &state.app_data_dir,
        &default_destination,
        cancel,
        move |progress| {
            let _ = progress_app.emit("download://progress", progress);
        },
    )
    .await;

    state.download_running.store(false, Ordering::SeqCst);
    state.download_cancel.store(false, Ordering::SeqCst);
    result.map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_downloader_status(state: State<'_, AppState>) -> CommandResult<DownloaderStatus> {
    Ok(downloader::downloader_status(
        &state.app_data_dir,
        state.download_running.load(Ordering::SeqCst),
    )
    .await)
}

#[tauri::command]
pub async fn cancel_media_download(state: State<'_, AppState>) -> CommandResult<()> {
    state.download_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn select_download_folder(app: AppHandle) -> CommandResult<Option<String>> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Ok(download_dir) = app.path().download_dir() {
        dialog = dialog.set_directory(download_dir);
    }

    Ok(dialog
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().to_string()))
}

#[tauri::command]
pub fn get_default_guest_song_folder(app: AppHandle) -> CommandResult<Option<String>> {
    Ok(app
        .path()
        .audio_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn select_guest_song_folder(app: AppHandle) -> CommandResult<Option<String>> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Ok(music_dir) = app.path().audio_dir() {
        dialog = dialog.set_directory(music_dir);
    }

    Ok(dialog
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().to_string()))
}

#[tauri::command]
pub fn reveal_download(path: String) -> CommandResult<()> {
    let path = std::path::PathBuf::from(path);
    if !path.exists() {
        return Err("The download location no longer exists.".to_string());
    }

    reveal_file(&path).map_err(|err| err.to_string())
}

#[cfg(target_os = "windows")]
fn reveal_file(path: &std::path::Path) -> std::io::Result<()> {
    let mut command = std::process::Command::new("explorer");
    if path.is_file() {
        command.arg("/select,");
    }
    command.arg(path).spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn reveal_file(path: &std::path::Path) -> std::io::Result<()> {
    let mut command = std::process::Command::new("open");
    if path.is_file() {
        command.arg("-R");
    }
    command.arg(path).spawn()?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_file(path: &std::path::Path) -> std::io::Result<()> {
    let folder = path.parent().unwrap_or(path);
    std::process::Command::new("xdg-open").arg(folder).spawn()?;
    Ok(())
}

#[tauri::command]
pub async fn fetch_metadata(
    state: State<'_, AppState>,
    provider_id: String,
    request: FetchRequest,
) -> CommandResult<serde_json::Value> {
    let offline_mode = {
        let db = state.db.lock().map_err(|err| err.to_string())?;
        db.get_setting("offlineMode")
            .map_err(|err| err.to_string())?
            .map(|value| value == "true")
            .unwrap_or(false)
    };

    fetchers::fetch_with_provider(
        &provider_id,
        request,
        FetchContext {
            api_key: None,
            offline_mode,
        },
    )
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn create_room(
    app: AppHandle,
    state: State<'_, AppState>,
    request: RoomCreateRequest,
) -> CommandResult<RoomStatus> {
    state
        .room
        .start(app, request)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn stop_room(state: State<'_, AppState>) -> CommandResult<()> {
    state.room.stop().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_room_status(state: State<'_, AppState>) -> CommandResult<RoomStatus> {
    state.room.status().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn discover_rooms() -> CommandResult<Vec<DiscoveredRoom>> {
    crate::room::discover_rooms()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn room_join_probe(request: RoomJoinRequest) -> CommandResult<RoomJoinResult> {
    crate::room::join_probe(request)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn room_join(
    app: AppHandle,
    state: State<'_, AppState>,
    request: RoomJoinRequest,
) -> CommandResult<RoomJoinResult> {
    state
        .room_client
        .join(app, request)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn room_leave(state: State<'_, AppState>) -> CommandResult<()> {
    state.room_client.leave().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_room_client_status(state: State<'_, AppState>) -> CommandResult<RoomClientStatus> {
    state.room_client.status().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn room_send_guest_playback_state(
    state: State<'_, AppState>,
    playback: RoomPlaybackState,
) -> CommandResult<()> {
    state
        .room_client
        .send_guest_playback(playback)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn room_send_guest_track(
    state: State<'_, AppState>,
    playback: RoomPlaybackState,
    path: String,
) -> CommandResult<()> {
    state
        .room_client
        .send_guest_track(playback, path)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn room_request_host_scan(state: State<'_, AppState>) -> CommandResult<()> {
    state
        .room_client
        .request_host_scan()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn room_broadcast_playback_state(
    state: State<'_, AppState>,
    mut playback: RoomPlaybackState,
) -> CommandResult<()> {
    let stream_path = if let Some(track_id) = playback.track_id {
        let db = state.db.lock().map_err(|err| err.to_string())?;
        db.track_path(track_id).map_err(|err| err.to_string())?
    } else {
        None
    };
    state
        .room
        .broadcast_playback(&mut playback, stream_path)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn room_kick_user(state: State<'_, AppState>, user_id: u64) -> CommandResult<()> {
    state.room.kick_user(user_id).map_err(|err| err.to_string())
}
