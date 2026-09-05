use std::sync::atomic::Ordering;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};

use crate::{
    downloader::{self, DownloadResult, DownloaderStatus, MediaDownloadRequest},
    fetchers::{self, FetchContext, FetchRequest},
    library,
    models::{
        Album, ApiKeyUpdate, Artist, DiscoveredRoom, FetcherDescriptor, FolderDeleteResult,
        FolderInspection, FolderRenameResult, LibraryChange, LibraryFolderEntry,
        LibraryFolderListing, LibraryTrackCopyConflictAction, LibraryTrackCopyResult, MusicFolder,
        PlaylistFolderCreateResult, RoomClientStatus, RoomCreateRequest, RoomJoinRequest,
        RoomJoinResult, RoomPlaybackState, RoomStatus, ScanProgress, ScanSummary, ScanTaskState,
        SettingUpdate, Track, TrackDeleteResult, TrackLyrics, TrackLyricsUpdate,
        TrackPlaybackStats,
    },
    state::AppState,
};

type CommandResult<T> = Result<T, String>;

#[tauri::command]
pub async fn import_playlist_image(state: State<'_, AppState>) -> CommandResult<Option<String>> {
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Choose a playlist picture")
        .add_filter("Pictures", &["png", "jpg", "jpeg", "webp"])
        .pick_file().await;
    let Some(selected) = selected else { return Ok(None); };
    crate::playlist_art::import_image(selected.path(), &state.app_data_dir).await
        .map(|path| Some(path.to_string_lossy().into_owned()))
        .map_err(|error| format!("{error:#}"))
}

const BACKGROUND_TRAY_ID: &str = "loavy-background";
const TRAY_OPEN_ID: &str = "tray-open";
const TRAY_QUIT_ID: &str = "tray-quit";
pub(crate) const MINI_PLAYER_LABEL: &str = "mini-player";
const MAX_LYRICS_FILE_BYTES: u64 = 2 * 1024 * 1024;

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn open_mini_player(app: AppHandle) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window(MINI_PLAYER_LABEL) {
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    } else {
        WebviewWindowBuilder::new(
            &app,
            MINI_PLAYER_LABEL,
            WebviewUrl::App("index.html?window=mini-player".into()),
        )
        .title("Loavy Mini Player")
        .inner_size(420.0, 230.0)
        .min_inner_size(360.0, 190.0)
        .resizable(true)
        .build()
        .map_err(|error| format!("Could not create the Mini Player window: {error}"))?;
    }

    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_mini_player_always_on_top(app: AppHandle, enabled: bool) -> CommandResult<()> {
    let window = app
        .get_webview_window(MINI_PLAYER_LABEL)
        .ok_or_else(|| "The Mini Player window is not open.".to_string())?;
    window
        .set_always_on_top(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn show_full_player(app: AppHandle) -> CommandResult<()> {
    show_main_window(&app);
    if let Some(window) = app.get_webview_window(MINI_PLAYER_LABEL) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
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
            TRAY_QUIT_ID => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("app://backgrounding", ());
                }
                app.exit(0);
            }
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
pub async fn list_playlist_folders(
    state: State<'_, AppState>,
) -> CommandResult<Vec<LibraryFolderEntry>> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<LibraryFolderEntry>> {
        let db = crate::db::Database::open(db_path)?;
        library::filesystem::list_library_folders_recursive(&db)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn copy_track_to_library_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    track_id: i64,
    root_id: i64,
    relative_path: String,
    conflict_action: LibraryTrackCopyConflictAction,
) -> CommandResult<LibraryTrackCopyResult> {
    let db_path = state.db_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<LibraryTrackCopyResult> {
        let db = crate::db::Database::open(db_path)?;
        library::filesystem::copy_track_to_library_folder(
            &db,
            &app_data_dir,
            track_id,
            root_id,
            &relative_path,
            conflict_action,
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;

    if let LibraryTrackCopyResult::Copied { folder, track }
    | LibraryTrackCopyResult::AlreadyPresent { folder, track } = &result
    {
        emit_library_change(
            &app,
            "playlist-track-copied",
            vec![track.id],
            Some(folder.root_id),
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn create_playlist_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> CommandResult<PlaylistFolderCreateResult> {
    let db_path = state.db_path.clone();
    let result =
        tokio::task::spawn_blocking(move || -> anyhow::Result<PlaylistFolderCreateResult> {
            let db = crate::db::Database::open(db_path)?;
            library::filesystem::create_preferred_playlist_folder(&db, &name)
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    if let PlaylistFolderCreateResult::Created { folder, .. } = &result {
        emit_library_change(
            &app,
            "playlist-folder-created",
            Vec::new(),
            Some(folder.root_id),
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn create_playlist_folder_with_track(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    track_id: i64,
) -> CommandResult<PlaylistFolderCreateResult> {
    let db_path = state.db_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    let result =
        tokio::task::spawn_blocking(move || -> anyhow::Result<PlaylistFolderCreateResult> {
            let db = crate::db::Database::open(db_path)?;
            library::filesystem::create_preferred_playlist_folder_with_track(
                &db,
                &app_data_dir,
                &name,
                track_id,
            )
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    if let PlaylistFolderCreateResult::Created { folder, copy } = &result {
        let track_ids = match copy {
            Some(LibraryTrackCopyResult::Copied { track, .. })
            | Some(LibraryTrackCopyResult::AlreadyPresent { track, .. }) => vec![track.id],
            _ => Vec::new(),
        };
        emit_library_change(
            &app,
            "playlist-folder-created",
            track_ids,
            Some(folder.root_id),
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn get_track_lyrics(
    state: State<'_, AppState>,
    track_id: i64,
) -> CommandResult<Option<TrackLyrics>> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.get_track_lyrics(track_id).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_track_lyrics(
    state: State<'_, AppState>,
    request: TrackLyricsUpdate,
) -> CommandResult<TrackLyrics> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.save_track_lyrics(request, chrono::Utc::now().timestamp_millis())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn delete_track_lyrics(state: State<'_, AppState>, track_id: i64) -> CommandResult<()> {
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.delete_track_lyrics(track_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn import_track_lyrics(
    state: State<'_, AppState>,
    track_id: i64,
) -> CommandResult<Option<TrackLyrics>> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .add_filter("Lyrics", &["lrc", "txt"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "lrc" && extension != "txt" {
        return Err("Lyrics imports must be .lrc or .txt files.".to_string());
    }
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("Could not inspect the lyrics file: {error}"))?;
    if !metadata.is_file() {
        return Err("The selected lyrics path is not a file.".to_string());
    }
    if metadata.len() > MAX_LYRICS_FILE_BYTES {
        return Err("Lyrics files cannot exceed 2 MB.".to_string());
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("Could not read the lyrics file: {error}"))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| "The lyrics file must use UTF-8 text encoding.".to_string())?;
    let text = text.trim_start_matches('\u{feff}').trim().to_string();
    if text.is_empty() {
        return Err("The lyrics file is empty.".to_string());
    }
    let synced = extension == "lrc" || contains_lrc_timestamp(&text);
    let request = TrackLyricsUpdate {
        track_id,
        plain_text: if synced {
            let plain = plain_text_from_lrc(&text);
            (!plain.is_empty()).then_some(plain)
        } else {
            Some(text.clone())
        },
        synced_text: synced.then_some(text),
        source: Some("local-file".to_string()),
    };
    let db = state.db.lock().map_err(|err| err.to_string())?;
    db.save_track_lyrics(request, chrono::Utc::now().timestamp_millis())
        .map(Some)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn mark_track_played(
    app: AppHandle,
    state: State<'_, AppState>,
    track_id: i64,
) -> CommandResult<TrackPlaybackStats> {
    let stats = {
        let db = state.db.lock().map_err(|err| err.to_string())?;
        db.mark_track_played(track_id, chrono::Utc::now().timestamp_millis())
            .map_err(|err| err.to_string())?
    };
    emit_library_change(&app, "track-played", vec![track_id], None);
    Ok(stats)
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
    match &result {
        Ok(download) => {
            let _ = app.emit("download://completed", download);
        }
        Err(error) => {
            let _ = app.emit("download://failed", error);
        }
    }
    result.map_err(|error| serde_json::to_string(&error).unwrap_or_else(|_| error.to_string()))
}

#[tauri::command]
pub async fn get_downloader_status(state: State<'_, AppState>) -> CommandResult<DownloaderStatus> {
    let mut status = downloader::downloader_status(&state.app_data_dir).await;
    // Tool health checks launch subprocesses and can take a few seconds. Read the
    // volatile job flag afterward so a just-finished download is never reported
    // as still running.
    status.running = state.download_running.load(Ordering::SeqCst);
    Ok(status)
}

#[tauri::command]
pub async fn repair_downloader_tools(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<DownloaderStatus> {
    if !state.try_start_download() {
        return Err("A download or tool repair is already running.".to_string());
    }

    state.download_cancel.store(false, Ordering::SeqCst);
    let progress_app = app.clone();
    let result = downloader::repair_downloader_tools(
        &state.app_data_dir,
        state.download_cancel.clone(),
        move |progress| {
            let _ = progress_app.emit("download://progress", progress);
        },
    )
    .await;
    state.download_running.store(false, Ordering::SeqCst);
    state.download_cancel.store(false, Ordering::SeqCst);

    result
        .map(|mut status| {
            status.running = false;
            status
        })
        .map_err(|error| error.to_string())
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
pub async fn list_library_folder(
    state: State<'_, AppState>,
    root_id: i64,
    relative_path: String,
) -> CommandResult<LibraryFolderListing> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<LibraryFolderListing> {
        let db = crate::db::Database::open(db_path)?;
        library::filesystem::list_library_folder(&db, root_id, &relative_path)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn create_library_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    root_id: i64,
    parent_relative_path: String,
    name: String,
) -> CommandResult<LibraryFolderEntry> {
    let db_path = state.db_path.clone();
    let entry = tokio::task::spawn_blocking(move || -> anyhow::Result<LibraryFolderEntry> {
        let db = crate::db::Database::open(db_path)?;
        library::filesystem::create_library_folder(&db, root_id, &parent_relative_path, &name)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;
    emit_library_change(&app, "folder-created", Vec::new(), Some(root_id));
    Ok(entry)
}

#[tauri::command]
pub async fn rename_library_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    root_id: i64,
    relative_path: String,
    name: String,
) -> CommandResult<FolderRenameResult> {
    let db_path = state.db_path.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<FolderRenameResult> {
        let db = crate::db::Database::open(db_path)?;
        library::filesystem::rename_library_folder(&db, root_id, &relative_path, &name)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;
    emit_library_change(
        &app,
        "folder-renamed",
        result.affected_track_ids.clone(),
        Some(root_id),
    );
    Ok(result)
}

#[tauri::command]
pub async fn inspect_library_folder(
    state: State<'_, AppState>,
    root_id: i64,
    relative_path: String,
) -> CommandResult<FolderInspection> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<FolderInspection> {
        let db = crate::db::Database::open(db_path)?;
        library::filesystem::inspect_library_folder(&db, root_id, &relative_path)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn delete_library_folder_to_trash(
    app: AppHandle,
    state: State<'_, AppState>,
    root_id: i64,
    relative_path: String,
) -> CommandResult<FolderDeleteResult> {
    let db_path = state.db_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<FolderDeleteResult> {
        let db = crate::db::Database::open(db_path)?;
        library::filesystem::delete_library_folder_to_trash(
            &db,
            &app_data_dir,
            root_id,
            &relative_path,
        )
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;
    emit_library_change(
        &app,
        "folder-deleted",
        result.removed_track_ids.clone(),
        Some(root_id),
    );
    Ok(result)
}

#[tauri::command]
pub async fn reveal_library_folder(
    state: State<'_, AppState>,
    root_id: i64,
    relative_path: String,
) -> CommandResult<()> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db = crate::db::Database::open(db_path)?;
        library::filesystem::reveal_library_folder(&db, root_id, &relative_path)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn reveal_track(state: State<'_, AppState>, track_id: i64) -> CommandResult<()> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db = crate::db::Database::open(db_path)?;
        library::filesystem::reveal_track(&db, track_id)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn delete_track_to_trash(
    app: AppHandle,
    state: State<'_, AppState>,
    track_id: i64,
) -> CommandResult<TrackDeleteResult> {
    let db_path = state.db_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<TrackDeleteResult> {
        let db = crate::db::Database::open(db_path)?;
        library::filesystem::delete_track_to_trash(&db, &app_data_dir, track_id)
    })
    .await
    .map_err(|err| err.to_string())?
    .map_err(|err| err.to_string())?;
    emit_library_change(&app, "track-deleted", vec![track_id], None);
    Ok(result)
}

#[tauri::command]
pub fn reveal_download(path: String) -> CommandResult<()> {
    let path = std::path::PathBuf::from(path);
    crate::explorer::reveal_existing_path(&path).map_err(|error| error.to_string())
}

fn emit_library_change(app: &AppHandle, kind: &str, track_ids: Vec<i64>, root_id: Option<i64>) {
    let _ = app.emit(
        "library://changed",
        LibraryChange {
            kind: kind.to_string(),
            track_ids,
            root_id,
        },
    );
}

fn contains_lrc_timestamp(value: &str) -> bool {
    value.lines().any(|line| {
        line.trim_start()
            .strip_prefix('[')
            .and_then(|line| line.split_once(']'))
            .map(|(tag, _)| is_lrc_timestamp(tag))
            .unwrap_or(false)
    })
}

fn is_lrc_timestamp(tag: &str) -> bool {
    let Some((minutes, seconds)) = tag.split_once(':') else {
        return false;
    };
    !minutes.is_empty()
        && minutes.len() <= 3
        && minutes.chars().all(|character| character.is_ascii_digit())
        && seconds
            .parse::<f64>()
            .map(|seconds| (0.0..60.0).contains(&seconds))
            .unwrap_or(false)
}

fn plain_text_from_lrc(value: &str) -> String {
    value
        .lines()
        .filter_map(|line| {
            let mut remaining = line.trim();
            let mut timestamped = false;
            let mut metadata_only = false;
            while let Some(rest) = remaining.strip_prefix('[') {
                let Some((tag, next)) = rest.split_once(']') else {
                    break;
                };
                if is_lrc_timestamp(tag) {
                    timestamped = true;
                } else if tag.contains(':') {
                    metadata_only = true;
                } else {
                    break;
                }
                remaining = next.trim_start();
            }
            let remaining = remaining.trim();
            (!remaining.is_empty() && (timestamped || !metadata_only))
                .then(|| remaining.to_string())
        })
        .collect::<Vec<_>>()
        .join("\n")
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
