mod audio;
mod commands;
mod db;
mod downloader;
mod fetchers;
mod library;
mod models;
mod room;
mod state;

use std::sync::atomic::Ordering;

use state::AppState;
use tauri::{Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            commands::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = AppState::initialize(&app.handle())?;
            let background_mode = state.background_mode.load(Ordering::SeqCst);
            app.manage(state);
            commands::sync_background_tray(&app.handle(), background_mode)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, WindowEvent::CloseRequested { .. })
                && window
                    .state::<AppState>()
                    .background_mode
                    .load(Ordering::SeqCst)
            {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_background_mode,
            commands::select_music_folder,
            commands::list_music_folders,
            commands::remove_music_folder,
            commands::scan_library,
            commands::start_library_scan,
            commands::cancel_library_scan,
            commands::get_scan_state,
            commands::list_tracks,
            commands::set_track_favorite,
            commands::find_room_playback_track,
            commands::list_albums,
            commands::list_artists,
            commands::list_playlists,
            commands::create_playlist,
            commands::add_track_to_playlist,
            commands::list_playlist_tracks,
            commands::set_setting,
            commands::get_setting,
            commands::set_api_key,
            commands::list_fetchers,
            commands::fetch_metadata,
            commands::download_media,
            commands::get_downloader_status,
            commands::cancel_media_download,
            commands::select_download_folder,
            commands::get_default_guest_song_folder,
            commands::select_guest_song_folder,
            commands::reveal_download,
            commands::create_room,
            commands::stop_room,
            commands::get_room_status,
            commands::discover_rooms,
            commands::room_join_probe,
            commands::room_join,
            commands::room_leave,
            commands::get_room_client_status,
            commands::room_send_guest_playback_state,
            commands::room_send_guest_track,
            commands::room_request_host_scan,
            commands::room_broadcast_playback_state,
            commands::room_kick_user
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loavy Player");
}
