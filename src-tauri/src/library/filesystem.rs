use std::{
    collections::HashSet,
    ffi::OsStr,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    process::Command,
};

use anyhow::{anyhow, bail, Context, Result};
use walkdir::WalkDir;

use crate::{
    db::Database,
    models::{
        FolderDeleteResult, FolderInspection, FolderRenameResult, LibraryFolderEntry,
        LibraryFolderListing, MusicFolder, Track, TrackDeleteResult,
    },
};

#[derive(Debug)]
struct ResolvedRoot {
    folder: MusicFolder,
    logical: PathBuf,
    canonical: PathBuf,
}

#[derive(Debug)]
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
    reveal_path(&folder.logical, false)
}

pub fn reveal_track(db: &Database, track_id: i64) -> Result<()> {
    let track = db.track_by_id(track_id)?;
    let path = validate_local_track_path(db, &track)?;
    reveal_path(&path, true)
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
    let base = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'));
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

#[cfg(target_os = "windows")]
fn components_equal(left: &Component<'_>, right: &Component<'_>) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
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

#[cfg(target_os = "windows")]
fn reveal_path(path: &Path, select_file: bool) -> Result<()> {
    let mut command = Command::new("explorer");
    if select_file {
        command.arg(format!("/select,{}", path.display()));
    } else {
        command.arg(path);
    }
    command
        .spawn()
        .with_context(|| format!("Could not open File Explorer for {}.", path.display()))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn reveal_path(path: &Path, select_file: bool) -> Result<()> {
    let mut command = Command::new("open");
    if select_file {
        command.arg("-R");
    }
    command.arg(path).spawn()?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_path(path: &Path, select_file: bool) -> Result<()> {
    let destination = if select_file {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    Command::new("xdg-open").arg(destination).spawn()?;
    Ok(())
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
        normalize_relative_path, paths_equal_platform, rename_library_folder,
        strip_prefix_platform, validate_windows_name,
    };
    use crate::{
        db::Database,
        models::{Track, TrackLyricsUpdate},
    };

    #[test]
    fn rejects_windows_reserved_and_unsafe_names() {
        for name in [
            "", ".", "..", "CON", "con.txt", "LPT9", "bad:name", "bad?name", "trail.", "trail ",
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
