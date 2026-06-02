use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::UNIX_EPOCH,
};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use lofty::{
    file::{AudioFile, TaggedFileExt},
    picture::PictureType,
    prelude::ItemKey,
    probe::Probe,
    tag::Accessor,
};
use sha1::{Digest, Sha1};
use walkdir::WalkDir;

use crate::{
    db::Database,
    models::{MusicFolder, ScanProgress, ScanSummary, Track},
};

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "ogg", "m4a"];

pub fn scan_library(db: &Database, app_data_dir: &Path) -> Result<ScanSummary> {
    scan_library_with_progress(db, app_data_dir, Arc::new(AtomicBool::new(false)), |_| {})
}

pub fn scan_library_with_progress(
    db: &Database,
    app_data_dir: &Path,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(ScanProgress),
) -> Result<ScanSummary> {
    let folders = db.list_music_folders()?;
    let mut summary = ScanSummary {
        folders_scanned: 0,
        files_seen: 0,
        tracks_added_or_updated: 0,
        tracks_removed: 0,
        errors: Vec::new(),
    };

    for folder in folders.into_iter().filter(|folder| folder.enabled) {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        scan_folder(db, app_data_dir, &folder, &mut summary, cancel.clone(), &mut on_progress)?;
    }

    if !cancel.load(Ordering::SeqCst) {
        summary.tracks_removed = db.remove_missing_tracks()?;
    }
    on_progress(progress_from_summary(&summary, None, false, cancel.load(Ordering::SeqCst)));
    Ok(summary)
}

fn scan_folder(
    db: &Database,
    app_data_dir: &Path,
    folder: &MusicFolder,
    summary: &mut ScanSummary,
    cancel: Arc<AtomicBool>,
    on_progress: &mut impl FnMut(ScanProgress),
) -> Result<()> {
    let root = PathBuf::from(&folder.path);
    if !root.exists() {
        summary.errors.push(format!("Folder does not exist: {}", folder.path));
        return Ok(());
    }

    let now = chrono::Utc::now().timestamp_millis();
    summary.folders_scanned += 1;

    for entry in WalkDir::new(&root).follow_links(false).into_iter().filter_map(Result::ok) {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if !is_audio_file(path) {
            continue;
        }

        let current_path = Some(path.to_string_lossy().to_string());
        summary.files_seen += 1;

        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(err) => {
                summary.errors.push(format!("{}: {err}", path.display()));
                continue;
            }
        };
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default();
        let path_string = path.to_string_lossy().to_string();
        if db
            .track_file_signature(&path_string)?
            .map(|(file_size, previous_modified_at)| {
                file_size == metadata.len() as i64 && previous_modified_at == modified_at
            })
            .unwrap_or(false)
        {
            if summary.files_seen % 50 == 0 {
                on_progress(progress_from_summary(summary, current_path, true, false));
            }
            continue;
        }

        match read_track(path, app_data_dir, now, metadata, modified_at) {
            Ok(track) => {
                db.upsert_track(&track)?;
                summary.tracks_added_or_updated += 1;
            }
            Err(err) => summary.errors.push(format!("{}: {err}", path.display())),
        }
        if summary.files_seen % 10 == 0 {
            on_progress(progress_from_summary(summary, current_path, true, false));
        }
    }

    if !cancel.load(Ordering::SeqCst) {
        db.mark_folder_scanned(&folder.path, now)?;
    }
    Ok(())
}

fn progress_from_summary(
    summary: &ScanSummary,
    current_path: Option<String>,
    running: bool,
    cancelled: bool,
) -> ScanProgress {
    ScanProgress {
        running,
        folders_scanned: summary.folders_scanned,
        files_seen: summary.files_seen,
        tracks_added_or_updated: summary.tracks_added_or_updated,
        tracks_removed: summary.tracks_removed,
        current_path,
        cancelled,
        errors: summary.errors.iter().rev().take(5).cloned().collect(),
    }
}

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn read_track(
    path: &Path,
    app_data_dir: &Path,
    now: i64,
    metadata: fs::Metadata,
    modified_at: i64,
) -> Result<Track> {
    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_string();
    let file_ext = path.extension().and_then(|s| s.to_str()).unwrap_or_default().to_ascii_lowercase();

    let tagged = Probe::open(path)
        .with_context(|| format!("open audio file {}", path.display()))?
        .read()
        .with_context(|| format!("read tags {}", path.display()))?;

    let properties = tagged.properties();
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let title = tag.and_then(|tag| tag.title().map(|value| value.to_string()));
    let artist = tag.and_then(|tag| tag.artist().map(|value| value.to_string()));
    let album = tag.and_then(|tag| tag.album().map(|value| value.to_string()));
    let album_artist = tag.and_then(|tag| tag.get_string(&ItemKey::AlbumArtist).map(|value| value.to_string()));
    let genre = tag.and_then(|tag| tag.genre().map(|value| value.to_string()));
    let year = tag.and_then(|tag| tag.year()).map(|value| value as i32);
    let track_number = tag.and_then(|tag| tag.track()).map(|value| value as i32);
    let cover_path = tag.and_then(|tag| extract_cover(path, app_data_dir, tag).ok().flatten());

    Ok(Track {
        id: 0,
        path: path.to_string_lossy().to_string(),
        file_name,
        file_ext,
        file_size: metadata.len() as i64,
        modified_at,
        title,
        artist,
        album,
        album_artist,
        genre,
        year,
        track_number,
        duration_ms: Some(properties.duration().as_millis() as i64),
        cover_path,
        favorite: false,
        date_added: now,
        last_played_at: None,
        play_count: 0,
    })
}

fn extract_cover(path: &Path, app_data_dir: &Path, tag: &lofty::tag::Tag) -> Result<Option<String>> {
    let picture = tag
        .pictures()
        .iter()
        .find(|picture| picture.pic_type() == PictureType::CoverFront)
        .or_else(|| tag.pictures().first());

    let Some(picture) = picture else {
        return Ok(None);
    };

    let mut hasher = Sha1::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(picture.data());
    let digest = BASE64.encode(hasher.finalize()).replace(['/', '+', '='], "");
    let ext = picture
        .mime_type()
        .and_then(|mime| mime.as_str().split('/').last())
        .unwrap_or("jpg");
    let cover_path = app_data_dir.join("covers").join(format!("{digest}.{ext}"));

    if !cover_path.exists() {
        fs::write(&cover_path, picture.data())?;
    }

    Ok(Some(cover_path.to_string_lossy().to_string()))
}
