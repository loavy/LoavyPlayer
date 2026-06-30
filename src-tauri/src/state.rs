use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use anyhow::Result;
use tauri::{AppHandle, Manager};

use crate::db::Database;
use crate::room::{RoomClientManager, RoomManager};

pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub db_path: PathBuf,
    pub app_data_dir: PathBuf,
    pub scan_running: Arc<AtomicBool>,
    pub scan_cancel: Arc<AtomicBool>,
    pub download_running: Arc<AtomicBool>,
    pub download_cancel: Arc<AtomicBool>,
    pub background_mode: Arc<AtomicBool>,
    pub room: RoomManager,
    pub room_client: RoomClientManager,
}

impl AppState {
    pub fn initialize(app: &AppHandle) -> Result<Self> {
        let app_data_dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&app_data_dir)?;
        std::fs::create_dir_all(app_data_dir.join("covers"))?;
        std::fs::create_dir_all(app_data_dir.join("fetch-cache"))?;

        let db_path = app_data_dir.join("loavy-player.sqlite3");
        let database = Database::open(&db_path)?;
        let background_mode = database.get_setting("backgroundMode")?.as_deref() == Some("true");
        Ok(Self {
            db: Arc::new(Mutex::new(database)),
            db_path,
            app_data_dir,
            scan_running: Arc::new(AtomicBool::new(false)),
            scan_cancel: Arc::new(AtomicBool::new(false)),
            download_running: Arc::new(AtomicBool::new(false)),
            download_cancel: Arc::new(AtomicBool::new(false)),
            background_mode: Arc::new(AtomicBool::new(background_mode)),
            room: RoomManager::new(),
            room_client: RoomClientManager::new(),
        })
    }

    pub fn try_start_scan(&self) -> bool {
        self.scan_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn try_start_download(&self) -> bool {
        self.download_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}
