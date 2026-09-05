use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, ErrorKind, Read, Write},
    path::{Component, Path, PathBuf},
};

use anyhow::{anyhow, bail, Context, Result};
use walkdir::WalkDir;

use crate::{
    db::Database,
    models::{
        FolderDeleteResult, FolderInspection, FolderRenameResult, LibraryFolderEntry,
        LibraryFolderListing, LibraryTrackCopyConflictAction, LibraryTrackCopyResult, MusicFolder,
        PlaylistFolderCreateResult, Track, TrackDeleteResult,
    },
};

use super::scanner::{index_audio_file, is_audio_file};

const PLAYLISTS_CONTAINER_NAME: &str = "PLAYLISTS";

#[derive(Debug, Clone)]
struct ResolvedRoot {
    folder: MusicFolder,
    logical: PathBuf,
    canonical: PathBuf,
}

#[derive(Debug, Clone)]
struct ResolvedFolder {
    root: ResolvedRoot,
    relative_path: String,
    logical: PathBuf,
    canonical: PathBuf,
}

pub fn list_library_folder(
    db: &Database,
    root_id: i64,
    relative_path: &str,
) -> Result<LibraryFolderListing> {
    let folder = resolve_existing_folder(db, root_id, relative_path, true)?;
    let tracks = db.list_tracks(None)?;
    let mut folders = Vec::new();

    for entry in fs::read_dir(&folder.logical)
        .with_context(|| format!("Could not read folder {}.", folder.logical.display()))?
    {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
            continue;
        }
        let canonical = entry.path().canonicalize()?;
        if !canonical.starts_with(&folder.root.canonical) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = join_relative(&folder.relative_path, &name);
        let direct_track_count = count_tracks(&tracks, &entry.path(), false);
        let indexed_track_count = count_tracks(&tracks, &entry.path(), true);
        folders.push(LibraryFolderEntry {
            root_id,
            relative_path: relative,
            name,
            path: display_path(&entry.path()),
            direct_track_count,
            indexed_track_count,
        });
    }
    folders.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(LibraryFolderListing {
        root_id,
        relative_path: folder.relative_path,
        path: display_path(&folder.logical),
        folders,
    })
}

pub fn create_library_folder(
    db: &Database,
    root_id: i64,
    parent_relative_path: &str,
    name: &str,
) -> Result<LibraryFolderEntry> {
    validate_windows_name(name)?;
    let parent = resolve_existing_folder(db, root_id, parent_relative_path, true)?;
    let destination = parent.logical.join(name);
    ensure_destination_absent(&destination, None)?;
    fs::create_dir(&destination)
        .with_context(|| format!("Could not create folder {}.", destination.display()))?;
    let canonical = match destination.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir(&destination);
            return Err(error).context("Could not validate the newly created folder.");
        }
    };
    if !canonical.starts_with(&parent.root.canonical) {
        let _ = fs::remove_dir(&destination);
        bail!("The new folder escaped the configured music root.");
    }

    Ok(LibraryFolderEntry {
        root_id,
        relative_path: join_relative(&parent.relative_path, name),
        name: name.to_string(),
        path: display_path(&destination),
        direct_track_count: 0,
        indexed_track_count: 0,
    })
}

pub fn list_library_folders_recursive(db: &Database) -> Result<Vec<LibraryFolderEntry>> {
    let tracks = db.list_tracks(None)?;
    let mut entries = Vec::new();

    for configured in db
        .list_music_folders()?
        .into_iter()
        .filter(|folder| folder.enabled)
    {
        let Ok(root) = resolve_root(db, configured.id) else {
            continue;
        };
        let (direct_counts, descendant_counts) = folder_track_counts(&tracks, &root.logical);
        for (relative_path, path) in enumerate_normal_folders(&root)? {
            let key = relative_path_key(&relative_path);
            entries.push(LibraryFolderEntry {
                root_id: root.folder.id,
                relative_path,
                name: folder_display_name(&path),
                path: display_path(&path),
                direct_track_count: direct_counts.get(&key).copied().unwrap_or_default(),
                indexed_track_count: descendant_counts.get(&key).copied().unwrap_or_default(),
            });
        }
    }

    entries.sort_by(|left, right| {
        left.path
            .to_lowercase()
            .cmp(&right.path.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(entries)
}

pub fn copy_track_to_library_folder(
    db: &Database,
    app_data_dir: &Path,
    track_id: i64,
    root_id: i64,
    relative_path: &str,
    conflict_action: LibraryTrackCopyConflictAction,
) -> Result<LibraryTrackCopyResult> {
    let source_track = db.track_by_id(track_id)?;
    let source = validate_local_track_path(db, &source_track)?;
    let source_name = source
        .file_name()
        .and_then(OsStr::to_str)
        .context("The indexed track filename is not valid Unicode.")?;
    let folder = resolve_existing_folder(db, root_id, relative_path, true)?;

    if let Some(existing) = find_identical_file(&source, &folder.logical)? {
        let track = index_existing_file(db, app_data_dir, &existing)?;
        return Ok(LibraryTrackCopyResult::AlreadyPresent {
            folder: library_folder_entry(db, &folder)?,
            track,
        });
    }

    let requested_destination = folder.logical.join(source_name);
    let mut keep_both_index = 2usize;
    let mut destination = requested_destination.clone();

    if path_is_present(&destination)? {
        if conflict_action == LibraryTrackCopyConflictAction::Report {
            let (suggested_file_name, _) =
                next_keep_both_destination(&folder.logical, source_name, keep_both_index)?;
            return Ok(LibraryTrackCopyResult::Conflict {
                folder: library_folder_entry(db, &folder)?,
                existing_path: display_path(&requested_destination),
                suggested_file_name,
            });
        }
        let (file_name, next) =
            next_keep_both_destination(&folder.logical, source_name, keep_both_index)?;
        keep_both_index = next;
        destination = folder.logical.join(file_name);
    }

    loop {
        match copy_file_exclusive(&source, &destination) {
            Ok(()) => break,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if is_normal_file(&destination)? && files_identical(&source, &destination)? {
                    let track = index_existing_file(db, app_data_dir, &destination)?;
                    return Ok(LibraryTrackCopyResult::AlreadyPresent {
                        folder: library_folder_entry(db, &folder)?,
                        track,
                    });
                }
                if conflict_action == LibraryTrackCopyConflictAction::Report {
                    let (suggested_file_name, _) =
                        next_keep_both_destination(&folder.logical, source_name, 2)?;
                    return Ok(LibraryTrackCopyResult::Conflict {
                        folder: library_folder_entry(db, &folder)?,
                        existing_path: display_path(&requested_destination),
                        suggested_file_name,
                    });
                }
                let (file_name, next) =
                    next_keep_both_destination(&folder.logical, source_name, keep_both_index)?;
                keep_both_index = next;
                destination = folder.logical.join(file_name);
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "Could not copy {} into {}.",
                        source.display(),
                        folder.logical.display()
                    )
                })
            }
        }
    }

    match files_identical(&source, &destination) {
        Ok(true) => {}
        Ok(false) => {
            let _ = fs::remove_file(&destination);
            bail!("The copied audio file did not match the source, so it was removed.");
        }
        Err(error) => {
            return match fs::remove_file(&destination) {
                Ok(()) => Err(error.context(
                    "The copied audio file could not be verified, so it was removed.",
                )),
                Err(cleanup_error) => Err(anyhow!(
                    "The copied audio file could not be verified ({error}), and it could not be removed ({cleanup_error}). Run a library scan to reconcile it."
                )),
            }
        }
    }

    let track = match index_audio_file(db, app_data_dir, &destination) {
        Ok(track) => track,
        Err(error) => {
            return match fs::remove_file(&destination) {
                Ok(()) => Err(error.context(
                    "The song was copied but could not be indexed, so the copy was removed.",
                )),
                Err(cleanup_error) => Err(anyhow!(
                    "The song was copied but could not be indexed ({error}), and the incomplete library copy could not be removed ({cleanup_error}). Run a library scan to reconcile it."
                )),
            }
        }
    };

    Ok(LibraryTrackCopyResult::Copied {
        folder: library_folder_entry(db, &folder)?,
        track,
    })
}

pub fn create_preferred_playlist_folder(
    db: &Database,
    name: &str,
) -> Result<PlaylistFolderCreateResult> {
    let (folder, created) = prepare_preferred_playlist_folder(db, name)?;
    let entry = library_folder_entry(db, &folder)?;
    if created {
        Ok(PlaylistFolderCreateResult::Created {
            folder: entry,
            copy: None,
        })
    } else {
        Ok(PlaylistFolderCreateResult::AlreadyExists { folder: entry })
    }
}

pub fn create_preferred_playlist_folder_with_track(
    db: &Database,
    app_data_dir: &Path,
    name: &str,
    track_id: i64,
) -> Result<PlaylistFolderCreateResult> {
    let source_track = db.track_by_id(track_id)?;
    validate_local_track_path(db, &source_track)?;
    let (folder, created) = prepare_preferred_playlist_folder(db, name)?;
    if !created {
        return Ok(PlaylistFolderCreateResult::AlreadyExists {
            folder: library_folder_entry(db, &folder)?,
        });
    }

    let copy = match copy_track_to_library_folder(
        db,
        app_data_dir,
        track_id,
        folder.root.folder.id,
        &folder.relative_path,
        LibraryTrackCopyConflictAction::Report,
    ) {
        Ok(copy) => copy,
        Err(error) => {
            let removed = fs::remove_dir(&folder.logical).is_ok();
            return if removed {
                Err(error.context(
                    "The playlist folder was created, but the song could not be added. The empty folder was removed.",
                ))
            } else {
                Err(error.context(
                    "The playlist folder was created, but the song could not be added. The folder was left in place.",
                ))
            };
        }
    };

    Ok(PlaylistFolderCreateResult::Created {
        folder: library_folder_entry(db, &folder)?,
        copy: Some(copy),
    })
}

pub fn rename_library_folder(
    db: &Database,
    root_id: i64,
    relative_path: &str,
    name: &str,
) -> Result<FolderRenameResult> {
    validate_windows_name(name)?;
    let source = resolve_existing_folder(db, root_id, relative_path, false)?;
    ensure_no_nested_configured_root(db, &source)?;
    let current_name = source
        .logical
        .file_name()
        .and_then(OsStr::to_str)
        .context("The folder name is not valid Unicode.")?;
    if current_name == name {
        bail!("The folder already has that name.");
    }
    let parent = source
        .logical
        .parent()
        .context("The configured music root cannot be renamed here.")?;
    let destination = parent.join(name);
    let case_only = current_name.eq_ignore_ascii_case(name);
    ensure_destination_absent(&destination, case_only.then_some(source.logical.as_path()))?;

    let tracks = db.list_tracks(None)?;
    let affected = tracks_beneath(&tracks, &source.logical);
    let updates = affected
        .iter()
        .map(|(track, suffix)| (track.id, display_path(&destination.join(suffix))))
        .collect::<Vec<_>>();

    fs::rename(&source.logical, &destination).with_context(|| {
        format!(
            "Could not rename {} to {}.",
            source.logical.display(),
            destination.display()
        )
    })?;
    if let Err(database_error) = db.rewrite_track_paths(&updates) {
        let rollback = fs::rename(&destination, &source.logical);
        return match rollback {
            Ok(()) => Err(database_error.context(
                "The database update failed; the filesystem rename was rolled back.",
            )),
            Err(rollback_error) => Err(anyhow!(
                "The folder was renamed, but the database update failed ({database_error}) and the filesystem rollback also failed ({rollback_error}). Run a library scan to reconcile it."
            )),
        };
    }

    let parent_relative = parent_relative(&source.relative_path);
    Ok(FolderRenameResult {
        root_id,
        old_relative_path: source.relative_path,
        new_relative_path: join_relative(&parent_relative, name),
        path: display_path(&destination),
        affected_track_ids: affected.into_iter().map(|(track, _)| track.id).collect(),
    })
}

pub fn inspect_library_folder(
    db: &Database,
    root_id: i64,
    relative_path: &str,
) -> Result<FolderInspection> {
    let folder = resolve_existing_folder(db, root_id, relative_path, false)?;
    ensure_no_nested_configured_root(db, &folder)?;
    let tracks = db.list_tracks(None)?;
    let descendant_folder_count = WalkDir::new(&folder.logical)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_dir())
        .count();
    Ok(FolderInspection {
        root_id,
        relative_path: folder.relative_path,
        path: display_path(&folder.logical),
        indexed_track_count: count_tracks(&tracks, &folder.logical, true),
        descendant_folder_count,
    })
}

pub fn delete_library_folder_to_trash(
    db: &Database,
    app_data_dir: &Path,
    root_id: i64,
    relative_path: &str,
) -> Result<FolderDeleteResult> {
    let normalized = normalize_relative_path(relative_path)?;
    if normalized.is_empty() {
        bail!("A configured music root cannot be deleted here. Remove it in Settings instead.");
    }
    let root = resolve_root(db, root_id)?;
    let logical = join_normalized(&root.logical, &normalized);
    let tracks = db.list_tracks(None)?;
    let affected = tracks_beneath(&tracks, &logical);
    let removed_track_ids = affected
        .iter()
        .map(|(track, _)| track.id)
        .collect::<Vec<_>>();

    let already_missing = match fs::symlink_metadata(&logical) {
        Ok(metadata) => {
            if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
                bail!("The selected library path is not a normal folder.");
            }
            let canonical = logical
                .canonicalize()
                .context("Could not validate the folder before deletion.")?;
            if !canonical.starts_with(&root.canonical) {
                bail!("The selected folder escapes the configured music root.");
            }
            let resolved = ResolvedFolder {
                root,
                relative_path: normalized.clone(),
                logical: logical.clone(),
                canonical,
            };
            ensure_no_nested_configured_root(db, &resolved)?;
            trash::delete(&logical).with_context(|| {
                format!("Could not move {} to the Recycle Bin.", logical.display())
            })?;
            false
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            ensure_missing_target_is_scoped(&root, &normalized)?;
            ensure_no_nested_configured_root_path(db, root_id, &logical)?;
            true
        }
        Err(error) => return Err(error).context("Could not inspect the folder before deletion."),
    };

    let covers = db.delete_track_records(&removed_track_ids).map_err(|error| {
        if already_missing {
            anyhow!(
                "The folder was already missing, and its stale library records could not be removed: {error}"
            )
        } else {
            anyhow!(
                "The folder was moved to the Recycle Bin, but its library records could not be removed ({error}). Run a library scan to reconcile it."
            )
        }
    })?;
    cleanup_orphan_covers(db, app_data_dir, covers);
    Ok(FolderDeleteResult {
        root_id,
        relative_path: normalized,
        path: display_path(&logical),
        removed_track_ids,
        already_missing,
    })
}

pub fn reveal_library_folder(db: &Database, root_id: i64, relative_path: &str) -> Result<()> {
    let folder = resolve_existing_folder(db, root_id, relative_path, true)?;
    crate::explorer::reveal_existing_path(&folder.logical)
}

pub fn reveal_track(db: &Database, track_id: i64) -> Result<()> {
    let track = db.track_by_id(track_id)?;
    let path = validate_local_track_path(db, &track)?;
    crate::explorer::reveal_existing_path(&path)
}

pub fn delete_track_to_trash(
    db: &Database,
    app_data_dir: &Path,
    track_id: i64,
) -> Result<TrackDeleteResult> {
    let track = db.track_by_id(track_id)?;
    let logical = PathBuf::from(&track.path);
    let already_missing = match fs::symlink_metadata(&logical) {
        Ok(_) => {
            let path = validate_local_track_path(db, &track)?;
            trash::delete(&path).with_context(|| {
                format!("Could not move {} to the Recycle Bin.", path.display())
            })?;
            false
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            validate_missing_track_scope(db, &logical)?;
            true
        }
        Err(error) => return Err(error).context("Could not inspect the track before deletion."),
    };

    let covers = db.delete_track_records(&[track_id]).map_err(|error| {
        if already_missing {
            anyhow!(
                "The track file was already missing, and its stale library record could not be removed: {error}"
            )
        } else {
            anyhow!(
                "The track was moved to the Recycle Bin, but its library record could not be removed ({error}). Run a library scan to reconcile it."
            )
        }
    })?;
    let cover_removed = cleanup_orphan_covers(db, app_data_dir, covers) > 0;
    Ok(TrackDeleteResult {
        track_id,
        path: track.path,
        already_missing,
        cover_removed,
    })
}

fn enumerate_normal_folders(root: &ResolvedRoot) -> Result<Vec<(String, PathBuf)>> {
    let mut folders = vec![(String::new(), root.logical.clone())];
    let walker = WalkDir::new(&root.logical)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            fs::symlink_metadata(entry.path())
                .map(|metadata| !is_reparse_or_symlink(&metadata))
                .unwrap_or(false)
        });

    for entry in walker.filter_map(std::result::Result::ok) {
        if !entry.file_type().is_dir() {
            continue;
        }
        let canonical = match entry.path().canonicalize() {
            Ok(path) if path.starts_with(&root.canonical) => path,
            _ => continue,
        };
        let Some(relative) = strip_prefix_platform(&canonical, &root.canonical) else {
            continue;
        };
        folders.push((
            relative_path_from_path(&relative),
            entry.path().to_path_buf(),
        ));
    }
    Ok(folders)
}

fn folder_track_counts(
    tracks: &[Track],
    root: &Path,
) -> (HashMap<String, usize>, HashMap<String, usize>) {
    let mut direct = HashMap::new();
    let mut descendants = HashMap::new();

    for track in tracks {
        let Some(parent) = Path::new(&track.path).parent() else {
            continue;
        };
        let Some(relative) = strip_prefix_platform(parent, root) else {
            continue;
        };
        let relative = relative_path_from_path(&relative);
        *direct.entry(relative_path_key(&relative)).or_insert(0) += 1;

        let mut ancestor = relative;
        loop {
            *descendants.entry(relative_path_key(&ancestor)).or_insert(0) += 1;
            if ancestor.is_empty() {
                break;
            }
            ancestor = parent_relative(&ancestor);
        }
    }

    (direct, descendants)
}

fn relative_path_from_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(target_os = "windows")]
fn relative_path_key(value: &str) -> String {
    value.to_lowercase()
}

#[cfg(not(target_os = "windows"))]
fn relative_path_key(value: &str) -> String {
    value.to_string()
}

fn folder_display_name(path: &Path) -> String {
    path.file_name()
        .and_then(OsStr::to_str)
        .map(str::to_string)
        .unwrap_or_else(|| display_path(path))
}

fn library_folder_entry(db: &Database, folder: &ResolvedFolder) -> Result<LibraryFolderEntry> {
    let tracks = db.list_tracks(None)?;
    Ok(LibraryFolderEntry {
        root_id: folder.root.folder.id,
        relative_path: folder.relative_path.clone(),
        name: folder_display_name(&folder.logical),
        path: display_path(&folder.logical),
        direct_track_count: count_tracks(&tracks, &folder.logical, false),
        indexed_track_count: count_tracks(&tracks, &folder.logical, true),
    })
}

fn prepare_preferred_playlist_folder(db: &Database, name: &str) -> Result<(ResolvedFolder, bool)> {
    validate_windows_name(name)?;
    let parent = preferred_playlist_parent(db)?;

    if let Some(existing) = find_child_case_insensitive(&parent.logical, name)? {
        return Ok((resolve_playlist_child(parent, existing)?, false));
    }

    let destination = parent.logical.join(name);
    match fs::create_dir(&destination) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            let existing = find_child_case_insensitive(&parent.logical, name)?
                .context("The playlist folder appeared concurrently but could not be found.")?;
            return Ok((resolve_playlist_child(parent, existing)?, false));
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Could not create playlist folder {}.",
                    destination.display()
                )
            })
        }
    }
    let canonical = match destination.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir(&destination);
            return Err(error).context("Could not validate the newly created playlist folder.");
        }
    };
    if !canonical.starts_with(&parent.root.canonical) {
        let _ = fs::remove_dir(&destination);
        bail!("The new playlist folder escaped the configured music root.");
    }

    Ok((
        ResolvedFolder {
            root: parent.root,
            relative_path: join_relative(&parent.relative_path, name),
            logical: destination,
            canonical,
        },
        true,
    ))
}

fn resolve_playlist_child(parent: ResolvedFolder, existing: PathBuf) -> Result<ResolvedFolder> {
    let metadata = fs::symlink_metadata(&existing)
        .context("Could not inspect the existing playlist folder.")?;
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        bail!("A file or unsafe folder with that playlist name already exists.");
    }
    let canonical = existing
        .canonicalize()
        .context("Could not validate the existing playlist folder.")?;
    if !canonical.starts_with(&parent.root.canonical) {
        bail!("The existing playlist folder escapes the configured music root.");
    }
    let actual_name = existing
        .file_name()
        .and_then(OsStr::to_str)
        .context("The existing playlist folder name is not valid Unicode.")?;
    Ok(ResolvedFolder {
        root: parent.root,
        relative_path: join_relative(&parent.relative_path, actual_name),
        logical: existing,
        canonical,
    })
}

fn preferred_playlist_parent(db: &Database) -> Result<ResolvedFolder> {
    let mut roots = Vec::new();
    for configured in db
        .list_music_folders()?
        .into_iter()
        .filter(|folder| folder.enabled)
    {
        if let Ok(root) = resolve_root(db, configured.id) {
            roots.push(root);
        }
    }

    for root in &roots {
        if root
            .logical
            .file_name()
            .and_then(OsStr::to_str)
            .map(|name| windows_names_equal(name, PLAYLISTS_CONTAINER_NAME))
            .unwrap_or(false)
        {
            return Ok(ResolvedFolder {
                root: root.clone(),
                relative_path: String::new(),
                logical: root.logical.clone(),
                canonical: root.canonical.clone(),
            });
        }

        if let Some(container) =
            find_child_case_insensitive(&root.logical, PLAYLISTS_CONTAINER_NAME)?
        {
            let metadata = fs::symlink_metadata(&container)?;
            if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
                continue;
            }
            let canonical = container
                .canonicalize()
                .context("Could not validate the PLAYLISTS folder.")?;
            if !canonical.starts_with(&root.canonical) {
                continue;
            }
            let actual_name = container
                .file_name()
                .and_then(OsStr::to_str)
                .context("The PLAYLISTS folder name is not valid Unicode.")?;
            return Ok(ResolvedFolder {
                root: root.clone(),
                relative_path: actual_name.to_string(),
                logical: container,
                canonical,
            });
        }
    }

    let root = roots
        .into_iter()
        .next()
        .context("Add an available music folder in Settings before creating a playlist.")?;
    Ok(ResolvedFolder {
        relative_path: String::new(),
        logical: root.logical.clone(),
        canonical: root.canonical.clone(),
        root,
    })
}

fn find_child_case_insensitive(parent: &Path, name: &str) -> Result<Option<PathBuf>> {
    for entry in fs::read_dir(parent)
        .with_context(|| format!("Could not read folder {}.", parent.display()))?
    {
        let entry = entry?;
        if windows_names_equal(&entry.file_name().to_string_lossy(), name) {
            return Ok(Some(entry.path()));
        }
    }
    Ok(None)
}

fn find_identical_file(source: &Path, folder: &Path) -> Result<Option<PathBuf>> {
    let source_size = fs::metadata(source)?.len();
    for entry in fs::read_dir(folder)
        .with_context(|| format!("Could not read folder {}.", folder.display()))?
    {
        let entry = entry?;
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !metadata.is_file()
            || is_reparse_or_symlink(&metadata)
            || !is_audio_file(&entry.path())
            || metadata.len() != source_size
        {
            continue;
        }
        if matches!(files_identical(source, &entry.path()), Ok(true)) {
            return Ok(Some(entry.path()));
        }
    }
    Ok(None)
}

fn index_existing_file(db: &Database, app_data_dir: &Path, path: &Path) -> Result<Track> {
    if !is_normal_file(path)? {
        bail!("The existing playlist song is not a normal local file.");
    }
    let path_string = display_path(path);
    if let Some(track) = db.track_by_path(&path_string)? {
        return Ok(track);
    }
    if let Some(track) = db
        .list_tracks(None)?
        .into_iter()
        .find(|track| paths_equal_platform(Path::new(&track.path), path))
    {
        return Ok(track);
    }
    index_audio_file(db, app_data_dir, path)
}

fn is_normal_file(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.is_file() && !is_reparse_or_symlink(&metadata)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).context("Could not inspect the existing playlist song."),
    }
}

fn path_is_present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).context("Could not inspect the playlist destination."),
    }
}

fn next_keep_both_destination(
    folder: &Path,
    original_name: &str,
    start: usize,
) -> Result<(String, usize)> {
    for index in start..100_000 {
        let candidate = keep_both_file_name(original_name, index)?;
        if !path_is_present(&folder.join(&candidate))? {
            return Ok((candidate, index + 1));
        }
    }
    bail!("Could not find an available filename for the playlist copy.")
}

fn keep_both_file_name(original_name: &str, index: usize) -> Result<String> {
    let original = Path::new(original_name);
    let stem = original
        .file_stem()
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("Track");
    let extension = original.extension().and_then(OsStr::to_str);
    let suffix = format!(" ({index})");
    let extension_suffix = extension
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let reserved = suffix.encode_utf16().count() + extension_suffix.encode_utf16().count();
    if reserved >= 255 {
        bail!("The audio file extension is too long to create a safe copy.");
    }
    let available_stem_units = 255 - reserved;
    let mut safe_stem = String::new();
    let mut used_units = 0usize;
    for character in stem.chars() {
        let units = character.len_utf16();
        if used_units + units > available_stem_units {
            break;
        }
        safe_stem.push(character);
        used_units += units;
    }
    if safe_stem.is_empty() {
        safe_stem.push_str("Track");
    }
    let candidate = format!("{safe_stem}{suffix}{extension_suffix}");
    validate_windows_name(&candidate)?;
    Ok(candidate)
}

fn copy_file_exclusive(source: &Path, destination: &Path) -> io::Result<()> {
    let source_file = File::open(source)?;
    let mut source_reader = BufReader::new(source_file);
    let mut destination_file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
    {
        Ok(file) => file,
        Err(error) => return Err(error),
    };

    let result = (|| {
        io::copy(&mut source_reader, &mut destination_file)?;
        destination_file.flush()?;
        destination_file.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        drop(destination_file);
        let _ = fs::remove_file(destination);
    }
    result
}

fn files_identical(left: &Path, right: &Path) -> Result<bool> {
    if paths_equal_platform(left, right) {
        return Ok(true);
    }
    if fs::metadata(left)?.len() != fs::metadata(right)?.len() {
        return Ok(false);
    }

    let mut left = BufReader::new(File::open(left)?);
    let mut right = BufReader::new(File::open(right)?);
    let mut left_buffer = [0u8; 64 * 1024];
    let mut right_buffer = [0u8; 64 * 1024];
    loop {
        let left_read = left.read(&mut left_buffer)?;
        let right_read = right.read(&mut right_buffer)?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn resolve_root(db: &Database, root_id: i64) -> Result<ResolvedRoot> {
    let folder = db.music_folder(root_id)?;
    if !folder.enabled {
        bail!("The selected music root is disabled.");
    }
    let logical = PathBuf::from(&folder.path);
    if !logical.is_absolute() {
        bail!("The configured music root is not an absolute path.");
    }
    let metadata = fs::metadata(&logical).with_context(|| {
        format!(
            "The configured music root {} is unavailable.",
            logical.display()
        )
    })?;
    if !metadata.is_dir() {
        bail!("The configured music root is not a folder.");
    }
    let canonical = logical
        .canonicalize()
        .context("Could not validate the configured music root.")?;
    Ok(ResolvedRoot {
        folder,
        logical,
        canonical,
    })
}

fn resolve_existing_folder(
    db: &Database,
    root_id: i64,
    relative_path: &str,
    allow_root: bool,
) -> Result<ResolvedFolder> {
    let root = resolve_root(db, root_id)?;
    let relative_path = normalize_relative_path(relative_path)?;
    if !allow_root && relative_path.is_empty() {
        bail!("A configured music root cannot be changed here.");
    }
    let logical = join_normalized(&root.logical, &relative_path);
    let metadata = fs::symlink_metadata(&logical)
        .with_context(|| format!("Folder {} was not found.", logical.display()))?;
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        bail!("The selected library path is not a normal folder.");
    }
    let canonical = logical
        .canonicalize()
        .context("Could not validate the selected library folder.")?;
    if !canonical.starts_with(&root.canonical) {
        bail!("The selected folder escapes the configured music root.");
    }
    Ok(ResolvedFolder {
        root,
        relative_path,
        logical,
        canonical,
    })
}

fn validate_local_track_path(db: &Database, track: &Track) -> Result<PathBuf> {
    let logical = PathBuf::from(&track.path);
    let metadata = fs::symlink_metadata(&logical)
        .with_context(|| format!("Track file {} was not found.", logical.display()))?;
    if !metadata.is_file() || is_reparse_or_symlink(&metadata) {
        bail!("The indexed track is not a normal local file.");
    }
    let canonical = logical
        .canonicalize()
        .context("Could not validate the indexed track path.")?;
    let roots = db.list_music_folders()?;
    for root in roots.into_iter().filter(|root| root.enabled) {
        let root_path = PathBuf::from(root.path);
        if let Ok(root_canonical) = root_path.canonicalize() {
            if canonical.starts_with(root_canonical) {
                return Ok(logical);
            }
        }
    }
    bail!("The indexed track is outside the configured music roots.")
}

fn validate_missing_track_scope(db: &Database, track_path: &Path) -> Result<()> {
    for root in db
        .list_music_folders()?
        .into_iter()
        .filter(|root| root.enabled)
    {
        if strip_prefix_platform(track_path, Path::new(&root.path)).is_some() {
            return Ok(());
        }
    }
    bail!("The indexed track is outside the configured music roots.")
}

fn ensure_missing_target_is_scoped(root: &ResolvedRoot, relative_path: &str) -> Result<()> {
    let parent_relative = parent_relative(relative_path);
    let parent = join_normalized(&root.logical, &parent_relative);
    let canonical_parent = parent
        .canonicalize()
        .context("Could not validate the missing folder's parent.")?;
    if !canonical_parent.starts_with(&root.canonical) {
        bail!("The selected folder escapes the configured music root.");
    }
    Ok(())
}

fn ensure_no_nested_configured_root(db: &Database, target: &ResolvedFolder) -> Result<()> {
    for candidate in db.list_music_folders()? {
        if candidate.id == target.root.folder.id {
            continue;
        }
        let candidate_path = PathBuf::from(&candidate.path);
        let inside = candidate_path
            .canonicalize()
            .ok()
            .map(|path| path == target.canonical || path.starts_with(&target.canonical))
            .unwrap_or_else(|| strip_prefix_platform(&candidate_path, &target.logical).is_some());
        if inside {
            bail!(
                "This folder contains another configured music root. Remove that root in Settings first."
            );
        }
    }
    Ok(())
}

fn ensure_no_nested_configured_root_path(db: &Database, root_id: i64, target: &Path) -> Result<()> {
    for candidate in db.list_music_folders()? {
        if candidate.id != root_id
            && strip_prefix_platform(Path::new(&candidate.path), target).is_some()
        {
            bail!(
                "This folder contains another configured music root. Remove that root in Settings first."
            );
        }
    }
    Ok(())
}

fn ensure_destination_absent(destination: &Path, same_entry: Option<&Path>) -> Result<()> {
    match fs::symlink_metadata(destination) {
        Ok(_) => {
            if same_entry
                .map(|source| paths_equal_platform(source, destination))
                .unwrap_or(false)
            {
                return Ok(());
            }
            bail!("A file or folder with that name already exists.")
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("Could not check the destination folder name."),
    }
}

fn normalize_relative_path(value: &str) -> Result<String> {
    let value = value;
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.starts_with('/')
        || value.starts_with('\\')
        || value.ends_with('/')
        || value.ends_with('\\')
    {
        bail!("Folder path must be relative to its configured music root.");
    }
    let normalized = value.replace('\\', "/");
    let mut safe = Vec::new();
    for segment in normalized.split('/') {
        if segment.is_empty() {
            bail!("Folder path contains an empty segment.");
        }
        validate_windows_name(segment)?;
        let path = Path::new(segment);
        if path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            bail!("Folder path contains path traversal.");
        }
        safe.push(segment);
    }
    Ok(safe.join("/"))
}

fn validate_windows_name(name: &str) -> Result<()> {
    if name.is_empty() || name == "." || name == ".." {
        bail!("Folder name is required.");
    }
    if name.encode_utf16().count() > 255 {
        bail!("Folder name is too long.");
    }
    if name.ends_with(' ') || name.ends_with('.') {
        bail!("Windows folder names cannot end with a space or period.");
    }
    if name
        .chars()
        .any(|character| character.is_control() || r#"<>:"/\|?*"#.contains(character))
    {
        bail!("Folder name contains characters that Windows does not allow.");
    }
    let base = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches(' ')
        .to_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || base
            .strip_prefix("COM")
            .or_else(|| base.strip_prefix("LPT"))
            .map(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
            .unwrap_or(false);
    if reserved {
        bail!("That name is reserved by Windows.");
    }
    Ok(())
}

fn join_normalized(root: &Path, relative_path: &str) -> PathBuf {
    relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn parent_relative(relative_path: &str) -> String {
    relative_path
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

fn tracks_beneath<'a>(tracks: &'a [Track], folder: &Path) -> Vec<(&'a Track, PathBuf)> {
    tracks
        .iter()
        .filter_map(|track| {
            let path = Path::new(&track.path);
            let parent = path.parent()?;
            strip_prefix_platform(parent, folder).map(|parent_suffix| {
                let suffix = parent_suffix.join(path.file_name().unwrap_or_default());
                (track, suffix)
            })
        })
        .collect()
}

fn count_tracks(tracks: &[Track], folder: &Path, recursive: bool) -> usize {
    tracks
        .iter()
        .filter(|track| {
            let Some(parent) = Path::new(&track.path).parent() else {
                return false;
            };
            if recursive {
                strip_prefix_platform(parent, folder).is_some()
            } else {
                paths_equal_platform(parent, folder)
            }
        })
        .count()
}

fn strip_prefix_platform(path: &Path, base: &Path) -> Option<PathBuf> {
    let path_components = path.components().collect::<Vec<_>>();
    let base_components = base.components().collect::<Vec<_>>();
    if base_components.len() > path_components.len() {
        return None;
    }
    if !path_components
        .iter()
        .zip(base_components.iter())
        .all(|(left, right)| components_equal(left, right))
    {
        return None;
    }
    Some(
        path_components[base_components.len()..]
            .iter()
            .fold(PathBuf::new(), |path, component| {
                path.join(component.as_os_str())
            }),
    )
}

fn paths_equal_platform(left: &Path, right: &Path) -> bool {
    let left = left.components().collect::<Vec<_>>();
    let right = right.components().collect::<Vec<_>>();
    left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(left, right)| components_equal(left, right))
}

fn windows_names_equal(left: &str, right: &str) -> bool {
    left.to_lowercase() == right.to_lowercase()
}

#[cfg(target_os = "windows")]
fn components_equal(left: &Component<'_>, right: &Component<'_>) -> bool {
    left.as_os_str().to_string_lossy().to_lowercase()
        == right.as_os_str().to_string_lossy().to_lowercase()
}

#[cfg(not(target_os = "windows"))]
fn components_equal(left: &Component<'_>, right: &Component<'_>) -> bool {
    left == right
}

#[cfg(target_os = "windows")]
fn is_reparse_or_symlink(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn is_reparse_or_symlink(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn cleanup_orphan_covers(db: &Database, app_data_dir: &Path, covers: Vec<Option<String>>) -> usize {
    let cover_root = app_data_dir.join("covers");
    let Ok(canonical_root) = cover_root.canonicalize() else {
        return 0;
    };
    let mut removed = 0;
    let mut seen = HashSet::new();
    for cover in covers.into_iter().flatten() {
        if !seen.insert(cover.clone()) || db.cover_reference_count(&cover).unwrap_or(1) != 0 {
            continue;
        }
        let path = PathBuf::from(cover);
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if canonical.starts_with(&canonical_root)
            && canonical.is_file()
            && fs::remove_file(canonical).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{path}")
    } else if let Some(path) = value.strip_prefix(r"\\?\") {
        path.to_string()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        copy_track_to_library_folder, create_preferred_playlist_folder,
        create_preferred_playlist_folder_with_track, keep_both_file_name,
        list_library_folders_recursive, normalize_relative_path, paths_equal_platform,
        rename_library_folder, strip_prefix_platform, validate_windows_name,
    };
    use crate::{
        db::Database,
        library::scanner::index_audio_file,
        models::{
            LibraryTrackCopyConflictAction, LibraryTrackCopyResult, PlaylistFolderCreateResult,
            Track, TrackLyricsUpdate,
        },
    };

    fn temporary_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "loavy-filesystem-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn write_test_wav(path: &Path, seed: u8) {
        let sample_count = 128u32;
        let data_size = sample_count * 2;
        let mut bytes = Vec::with_capacity((44 + data_size) as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8_000u32.to_le_bytes());
        bytes.extend_from_slice(&16_000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for index in 0..sample_count {
            let sample = ((index as i16).wrapping_mul(seed as i16 + 1)).to_le_bytes();
            bytes.extend_from_slice(&sample);
        }
        fs::write(path, bytes).unwrap();
    }

    fn add_root(db: &Database, root: &Path) -> i64 {
        let root = root.to_string_lossy().to_string();
        db.add_music_folder(&root, 1).unwrap();
        db.list_music_folders()
            .unwrap()
            .into_iter()
            .find(|folder| folder.path == root)
            .unwrap()
            .id
    }

    #[test]
    fn rejects_windows_reserved_and_unsafe_names() {
        for name in [
            "",
            ".",
            "..",
            "CON",
            "con.txt",
            "CON .txt",
            "LPT9",
            "COM¹.txt",
            "bad:name",
            "bad?name",
            "trail.",
            "trail ",
        ] {
            assert!(validate_windows_name(name).is_err(), "accepted {name:?}");
        }
        assert!(validate_windows_name("Álbuns 2026").is_ok());
        assert!(validate_windows_name("COM10").is_ok());
    }

    #[test]
    fn normalizes_only_safe_relative_paths() {
        assert_eq!(normalize_relative_path("").unwrap(), "");
        assert_eq!(normalize_relative_path(r"Rock\Live").unwrap(), "Rock/Live");
        for path in [
            "../outside",
            "/rooted",
            r"C:\rooted",
            "one//two",
            "one/../two",
        ] {
            assert!(normalize_relative_path(path).is_err(), "accepted {path:?}");
        }
    }

    #[test]
    fn path_prefix_checks_component_boundaries() {
        let base = Path::new(r"C:\Music");
        assert_eq!(
            strip_prefix_platform(Path::new(r"C:\Music\Rock"), base),
            Some(PathBuf::from("Rock"))
        );
        assert!(strip_prefix_platform(Path::new(r"C:\Music2\Rock"), base).is_none());
        assert!(paths_equal_platform(base, Path::new(r"C:\Music")));
    }

    #[test]
    fn recursively_lists_real_folders_with_indexed_descendant_counts() {
        let directory = temporary_directory("recursive-listing");
        let root = directory.join("Music");
        let road = root.join("PLAYLISTS").join("Road trip");
        let nested = road.join("Live");
        let empty = root.join("Empty");
        let app_data = directory.join("AppData");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&empty).unwrap();
        fs::create_dir_all(app_data.join("covers")).unwrap();
        let root_track = root.join("root.wav");
        let road_track = road.join("road.wav");
        let nested_track = nested.join("nested.wav");
        write_test_wav(&root_track, 1);
        write_test_wav(&road_track, 2);
        write_test_wav(&nested_track, 3);

        let db = Database::open(directory.join("test.sqlite3")).unwrap();
        let root_id = add_root(&db, &root);
        index_audio_file(&db, &app_data, &root_track).unwrap();
        index_audio_file(&db, &app_data, &road_track).unwrap();
        index_audio_file(&db, &app_data, &nested_track).unwrap();

        let entries = list_library_folders_recursive(&db).unwrap();
        let entry = |relative_path: &str| {
            entries
                .iter()
                .find(|entry| entry.root_id == root_id && entry.relative_path == relative_path)
                .unwrap()
        };
        assert_eq!(entry("").direct_track_count, 1);
        assert_eq!(entry("").indexed_track_count, 3);
        assert_eq!(entry("PLAYLISTS").direct_track_count, 0);
        assert_eq!(entry("PLAYLISTS").indexed_track_count, 2);
        assert_eq!(entry("PLAYLISTS/Road trip").direct_track_count, 1);
        assert_eq!(entry("PLAYLISTS/Road trip").indexed_track_count, 2);
        assert_eq!(entry("PLAYLISTS/Road trip/Live").indexed_track_count, 1);
        assert_eq!(entry("Empty").indexed_track_count, 0);

        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn copies_bytes_reports_conflicts_and_keeps_both_without_overwriting() {
        let directory = temporary_directory("playlist-copy");
        let root = directory.join("Music");
        let source_folder = root.join("Source");
        let target = root.join("PLAYLISTS").join("Favorites");
        let conflict_target = root.join("PLAYLISTS").join("Conflicts");
        let identical_target = root.join("PLAYLISTS").join("Already there");
        let app_data = directory.join("AppData");
        fs::create_dir_all(&source_folder).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&conflict_target).unwrap();
        fs::create_dir_all(&identical_target).unwrap();
        fs::create_dir_all(app_data.join("covers")).unwrap();
        let source = source_folder.join("Canção (live).wav");
        write_test_wav(&source, 7);

        let db = Database::open(directory.join("test.sqlite3")).unwrap();
        let root_id = add_root(&db, &root);
        let source_track = index_audio_file(&db, &app_data, &source).unwrap();
        let source_bytes = fs::read(&source).unwrap();

        let copied = copy_track_to_library_folder(
            &db,
            &app_data,
            source_track.id,
            root_id,
            "PLAYLISTS/Favorites",
            LibraryTrackCopyConflictAction::Report,
        )
        .unwrap();
        let copied_path = match copied {
            LibraryTrackCopyResult::Copied { folder, track } => {
                assert_eq!(folder.direct_track_count, 1);
                PathBuf::from(track.path)
            }
            other => panic!("expected copied result, got {other:?}"),
        };
        assert_eq!(fs::read(&copied_path).unwrap(), source_bytes);
        assert_eq!(fs::read(&source).unwrap(), source_bytes);

        assert!(matches!(
            copy_track_to_library_folder(
                &db,
                &app_data,
                source_track.id,
                root_id,
                "PLAYLISTS/Favorites",
                LibraryTrackCopyConflictAction::Report,
            )
            .unwrap(),
            LibraryTrackCopyResult::AlreadyPresent { .. }
        ));

        let conflicting = conflict_target.join("Canção (live).wav");
        write_test_wav(&conflicting, 19);
        let conflicting_bytes = fs::read(&conflicting).unwrap();
        let conflict = copy_track_to_library_folder(
            &db,
            &app_data,
            source_track.id,
            root_id,
            "PLAYLISTS/Conflicts",
            LibraryTrackCopyConflictAction::Report,
        )
        .unwrap();
        match conflict {
            LibraryTrackCopyResult::Conflict {
                existing_path,
                suggested_file_name,
                ..
            } => {
                assert_eq!(PathBuf::from(existing_path), conflicting);
                assert_eq!(suggested_file_name, "Canção (live) (2).wav");
            }
            other => panic!("expected conflict result, got {other:?}"),
        }
        assert_eq!(fs::read(&conflicting).unwrap(), conflicting_bytes);

        let kept = copy_track_to_library_folder(
            &db,
            &app_data,
            source_track.id,
            root_id,
            "PLAYLISTS/Conflicts",
            LibraryTrackCopyConflictAction::KeepBoth,
        )
        .unwrap();
        let kept_path = match kept {
            LibraryTrackCopyResult::Copied { track, .. } => PathBuf::from(track.path),
            other => panic!("expected kept copy, got {other:?}"),
        };
        assert_eq!(
            kept_path.file_name().unwrap().to_string_lossy(),
            "Canção (live) (2).wav"
        );
        assert_eq!(fs::read(&kept_path).unwrap(), source_bytes);
        assert_eq!(fs::read(&conflicting).unwrap(), conflicting_bytes);

        let differently_named_identical = identical_target.join("same bytes.wav");
        fs::write(&differently_named_identical, &source_bytes).unwrap();
        let already_present = copy_track_to_library_folder(
            &db,
            &app_data,
            source_track.id,
            root_id,
            "PLAYLISTS/Already there",
            LibraryTrackCopyConflictAction::Report,
        )
        .unwrap();
        match already_present {
            LibraryTrackCopyResult::AlreadyPresent { track, .. } => {
                assert_eq!(PathBuf::from(track.path), differently_named_identical)
            }
            other => panic!("expected byte-identical no-op, got {other:?}"),
        }
        assert!(!identical_target.join("Canção (live).wav").exists());
        assert!(copy_track_to_library_folder(
            &db,
            &app_data,
            source_track.id,
            root_id,
            "../outside",
            LibraryTrackCopyConflictAction::Report,
        )
        .is_err());

        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn creates_in_existing_playlists_container_and_reports_existing_folder() {
        let directory = temporary_directory("preferred-playlists");
        let first_root = directory.join("A Music");
        let second_root = directory.join("B Music");
        let playlists = second_root.join("playlists");
        let source_folder = first_root.join("Source");
        let app_data = directory.join("AppData");
        fs::create_dir_all(&source_folder).unwrap();
        fs::create_dir_all(&playlists).unwrap();
        fs::create_dir_all(app_data.join("covers")).unwrap();
        let source = source_folder.join("origem.wav");
        write_test_wav(&source, 11);

        let db = Database::open(directory.join("test.sqlite3")).unwrap();
        add_root(&db, &first_root);
        let second_root_id = add_root(&db, &second_root);
        let source_track = index_audio_file(&db, &app_data, &source).unwrap();

        let created = create_preferred_playlist_folder_with_track(
            &db,
            &app_data,
            "Viagem São Paulo",
            source_track.id,
        )
        .unwrap();
        match created {
            PlaylistFolderCreateResult::Created { folder, copy } => {
                assert_eq!(folder.root_id, second_root_id);
                assert_eq!(folder.relative_path, "playlists/Viagem São Paulo");
                assert_eq!(folder.direct_track_count, 1);
                assert!(matches!(copy, Some(LibraryTrackCopyResult::Copied { .. })));
            }
            other => panic!("expected created folder, got {other:?}"),
        }
        assert!(playlists
            .join("Viagem São Paulo")
            .join("origem.wav")
            .exists());

        match create_preferred_playlist_folder(&db, "VIAGEM SÃO PAULO").unwrap() {
            PlaylistFolderCreateResult::AlreadyExists { folder } => {
                assert_eq!(folder.relative_path, "playlists/Viagem São Paulo");
                assert_eq!(folder.indexed_track_count, 1);
            }
            other => panic!("expected existing folder, got {other:?}"),
        }
        for invalid in ["CON", "bad:name", "trail."] {
            assert!(create_preferred_playlist_folder(&db, invalid).is_err());
        }

        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn preferred_playlist_creation_falls_back_to_a_configured_root() {
        let directory = temporary_directory("playlist-root-fallback");
        let root = directory.join("Music");
        fs::create_dir_all(&root).unwrap();
        let db = Database::open(directory.join("test.sqlite3")).unwrap();
        let root_id = add_root(&db, &root);

        match create_preferred_playlist_folder(&db, "Fresh mix").unwrap() {
            PlaylistFolderCreateResult::Created { folder, copy } => {
                assert_eq!(folder.root_id, root_id);
                assert_eq!(folder.relative_path, "Fresh mix");
                assert!(copy.is_none());
            }
            other => panic!("expected created folder, got {other:?}"),
        }
        assert!(root.join("Fresh mix").is_dir());
        fs::write(root.join("Taken name"), b"not a folder").unwrap();
        assert!(create_preferred_playlist_folder(&db, "Taken name").is_err());

        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_targeted_index_removes_a_new_empty_playlist_folder() {
        let directory = temporary_directory("playlist-index-rollback");
        let root = directory.join("Music");
        let playlists = root.join("PLAYLISTS");
        let source_folder = root.join("Source");
        let app_data = directory.join("AppData");
        fs::create_dir_all(&playlists).unwrap();
        fs::create_dir_all(&source_folder).unwrap();
        fs::create_dir_all(app_data.join("covers")).unwrap();
        let source = source_folder.join("broken.mp3");
        fs::write(&source, b"not valid audio").unwrap();

        let db = Database::open(directory.join("test.sqlite3")).unwrap();
        add_root(&db, &root);
        db.upsert_track(&Track {
            id: 0,
            path: source.to_string_lossy().to_string(),
            file_name: "broken.mp3".to_string(),
            file_ext: "mp3".to_string(),
            file_size: 15,
            modified_at: 1,
            title: Some("Broken".to_string()),
            artist: None,
            album: None,
            album_artist: None,
            genre: None,
            year: None,
            track_number: None,
            duration_ms: None,
            cover_path: None,
            favorite: false,
            date_added: 1,
            last_played_at: None,
            play_count: 0,
        })
        .unwrap();
        let source_string = source.to_string_lossy().to_string();
        let source_track = db.track_by_path(&source_string).unwrap().unwrap();

        assert!(create_preferred_playlist_folder_with_track(
            &db,
            &app_data,
            "Broken mix",
            source_track.id,
        )
        .is_err());
        assert!(!playlists.join("Broken mix").exists());
        assert!(source.exists());

        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn generated_keep_both_names_remain_windows_safe() {
        let original = format!("{}.wav", "🎵".repeat(200));
        let candidate = keep_both_file_name(&original, 2).unwrap();
        assert!(candidate.encode_utf16().count() <= 255);
        assert!(candidate.ends_with(" (2).wav"));
        validate_windows_name(&candidate).unwrap();
    }

    #[test]
    fn folder_rename_rewrites_paths_without_replacing_track_identity() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("loavy-filesystem-{}-{nonce}", std::process::id()));
        let root = directory.join("Music");
        let old_folder = root.join("Old");
        fs::create_dir_all(&old_folder).unwrap();
        let old_track_path = old_folder.join("song.mp3");
        fs::write(&old_track_path, b"test audio placeholder").unwrap();
        let db = Database::open(directory.join("test.sqlite3")).unwrap();
        db.add_music_folder(&root.to_string_lossy(), 1).unwrap();
        db.upsert_track(&Track {
            id: 0,
            path: old_track_path.to_string_lossy().to_string(),
            file_name: "song.mp3".to_string(),
            file_ext: "mp3".to_string(),
            file_size: 22,
            modified_at: 1,
            title: Some("Song".to_string()),
            artist: None,
            album: None,
            album_artist: None,
            genre: None,
            year: None,
            track_number: None,
            duration_ms: None,
            cover_path: None,
            favorite: true,
            date_added: 1,
            last_played_at: Some(2),
            play_count: 3,
        })
        .unwrap();
        let track = db.list_tracks(None).unwrap().remove(0);
        let playlist = db.create_playlist("Keep IDs", 1).unwrap();
        db.add_track_to_playlist(playlist.id, track.id).unwrap();
        db.save_track_lyrics(
            TrackLyricsUpdate {
                track_id: track.id,
                plain_text: Some("lyrics".to_string()),
                synced_text: None,
                source: Some("manual".to_string()),
            },
            1,
        )
        .unwrap();
        let root_id = db.list_music_folders().unwrap()[0].id;

        let result = rename_library_folder(&db, root_id, "Old", "New").unwrap();
        assert_eq!(result.affected_track_ids, vec![track.id]);
        let renamed = db.track_by_id(track.id).unwrap();
        assert_eq!(
            renamed.path,
            root.join("New").join("song.mp3").to_string_lossy()
        );
        assert!(renamed.favorite);
        assert_eq!(renamed.play_count, 3);
        assert_eq!(
            db.list_playlist_tracks(playlist.id).unwrap()[0].id,
            track.id
        );
        assert!(db.get_track_lyrics(track.id).unwrap().is_some());

        drop(db);
        fs::remove_dir_all(directory).unwrap();
    }
}
