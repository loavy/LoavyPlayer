mod audio;
mod commands;
mod db;
mod fetchers;
mod library;
mod models;
mod room;
mod state;

use state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = AppState::initialize(&app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::select_music_folder,
            commands::list_music_folders,
            commands::scan_library,
            commands::start_library_scan,
            commands::cancel_library_scan,
            commands::get_scan_state,
            commands::list_tracks,
            commands::set_track_favorite,
            commands::find_room_playback_track,
            commands::list_albums,
            commands::list_artists,
            commands::set_setting,
            commands::get_setting,
            commands::set_api_key,
            commands::list_fetchers,
            commands::fetch_metadata,
            commands::create_room,
            commands::stop_room,
            commands::get_room_status,
            commands::room_join_probe,
            commands::room_join,
            commands::room_leave,
            commands::get_room_client_status,
            commands::room_send_guest_playback_state,
            commands::room_request_host_scan,
            commands::room_broadcast_playback_state,
            commands::room_kick_user
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loavy Player");
}
