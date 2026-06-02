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
use crate::room::RoomManager;

pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub db_path: PathBuf,
    pub app_data_dir: PathBuf,
    pub scan_running: Arc<AtomicBool>,
    pub scan_cancel: Arc<AtomicBool>,
    pub room: RoomManager,
}

impl AppState {
    pub fn initialize(app: &AppHandle) -> Result<Self> {
        let app_data_dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&app_data_dir)?;
        std::fs::create_dir_all(app_data_dir.join("covers"))?;
        std::fs::create_dir_all(app_data_dir.join("fetch-cache"))?;

        let db_path = app_data_dir.join("loavy-player.sqlite3");
        let database = Database::open(&db_path)?;
        Ok(Self {
            db: Arc::new(Mutex::new(database)),
            db_path,
            app_data_dir,
            scan_running: Arc::new(AtomicBool::new(false)),
            scan_cancel: Arc::new(AtomicBool::new(false)),
            room: RoomManager::new(),
        })
    }

    pub fn try_start_scan(&self) -> bool {
        self.scan_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

}
