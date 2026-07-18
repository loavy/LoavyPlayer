mod direct;
mod spotify;

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadSource {
    Spotify,
    #[default]
    Web,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadMode {
    Single,
    Album,
    Playlist,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadFormat {
    #[default]
    M4a,
    Mp3,
    Opus,
    Flac,
}

impl DownloadFormat {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::M4a => "m4a",
            Self::Mp3 => "mp3",
            Self::Opus => "opus",
            Self::Flac => "flac",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDownloadRequest {
    pub url: String,
    pub destination_dir: Option<String>,
    pub mode: DownloadMode,
    #[serde(default)]
    pub source: DownloadSource,
    #[serde(default)]
    pub format: DownloadFormat,
    #[serde(default = "default_filename_template")]
    pub filename_template: String,
    #[serde(default = "default_folder_template")]
    pub folder_template: String,
    #[serde(default)]
    pub apply_folder_to_single: bool,
}

const DEFAULT_FILENAME_TEMPLATE: &str = "{artist} - {title}";
const DEFAULT_FOLDER_TEMPLATE: &str = "{album_artist}/{album}";
const MAX_NAMING_TEMPLATE_CHARS: usize = 512;

fn default_filename_template() -> String {
    DEFAULT_FILENAME_TEMPLATE.to_string()
}

fn default_folder_template() -> String {
    DEFAULT_FOLDER_TEMPLATE.to_string()
}

#[derive(Debug, Clone, Copy)]
enum TemplateDialect {
    Spotdl,
    YtDlp,
}

#[derive(Debug, Clone, Copy)]
enum TemplateKind {
    Filename,
    Folder,
}

/// Validated output templates translated for both download engines.
///
/// Keeping the friendly syntax out of subprocess arguments also prevents a
/// caller from injecting native spotDL or yt-dlp template expressions.
#[derive(Debug, Clone)]
pub(crate) struct DownloadNaming {
    spotdl_filename: String,
    spotdl_folder: String,
    yt_dlp_filename: String,
    yt_dlp_folder: String,
    apply_folder_to_single: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct DownloadOptions<'a> {
    mode: DownloadMode,
    format: DownloadFormat,
    naming: &'a DownloadNaming,
}

impl DownloadNaming {
    fn new(filename: &str, folder: &str, apply_folder_to_single: bool) -> Result<Self> {
        validate_template_shape(filename, TemplateKind::Filename)?;
        validate_template_shape(folder, TemplateKind::Folder)?;

        // Forward slashes work as output-template separators in both tools and
        // make a backslash entered on Windows behave consistently.
        let folder = folder.replace('\\', "/");
        Ok(Self {
            spotdl_filename: translate_template(filename, TemplateDialect::Spotdl)?,
            spotdl_folder: translate_template(&folder, TemplateDialect::Spotdl)?,
            yt_dlp_filename: translate_template(filename, TemplateDialect::YtDlp)?,
            yt_dlp_folder: translate_template(&folder, TemplateDialect::YtDlp)?,
            apply_folder_to_single,
        })
    }

    pub(crate) fn spotdl_output(&self, mode: DownloadMode) -> String {
        // A Spotify playlist is already a user-defined collection. Keep all of
        // its tracks together in the selected destination instead of splitting
        // them into each track's album-artist/album hierarchy.
        if mode == DownloadMode::Playlist {
            return format!("{}.{{output-ext}}", self.spotdl_filename);
        }
        self.output(
            mode,
            &self.spotdl_folder,
            &self.spotdl_filename,
            "{output-ext}",
        )
    }

    /// yt-dlp only renders this extensionless target. The direct downloader
    /// validates the resolved value and appends the selected extension itself.
    pub(crate) fn yt_dlp_target(&self, mode: DownloadMode) -> String {
        let use_folder = !self.yt_dlp_folder.is_empty()
            && (mode != DownloadMode::Single || self.apply_folder_to_single);
        if use_folder {
            format!("{}/{}", self.yt_dlp_folder, self.yt_dlp_filename)
        } else {
            self.yt_dlp_filename.clone()
        }
    }

    fn output(&self, mode: DownloadMode, folder: &str, filename: &str, extension: &str) -> String {
        let use_folder =
            !folder.is_empty() && (mode != DownloadMode::Single || self.apply_folder_to_single);
        if use_folder {
            format!("{folder}/{filename}.{extension}")
        } else {
            format!("{filename}.{extension}")
        }
    }
}

fn validate_template_shape(template: &str, kind: TemplateKind) -> Result<()> {
    let label = match kind {
        TemplateKind::Filename => "filename",
        TemplateKind::Folder => "folder",
    };
    if template.chars().count() > MAX_NAMING_TEMPLATE_CHARS {
        bail!("The {label} template is too long (maximum {MAX_NAMING_TEMPLATE_CHARS} characters).");
    }
    if template.chars().any(char::is_control) {
        bail!("The {label} template cannot contain control characters.");
    }
    // A colon can turn a value such as `C` followed by a literal `:` into a
    // drive-relative Windows path after metadata expansion. It is not valid in
    // a Windows file or folder name in any case.
    if template.contains(':') {
        bail!("The {label} template cannot contain a colon.");
    }
    // Direct-download completion records use `|` after an unpredictable
    // per-run prefix. Keeping it out of literals makes the record boundary
    // unambiguous even before the resolved value is sanitized in Rust.
    if template.contains('|') {
        bail!("The {label} template cannot contain a vertical bar.");
    }

    match kind {
        TemplateKind::Filename => {
            if template.trim().is_empty() {
                bail!("The filename template cannot be empty.");
            }
            if template.contains(['/', '\\']) {
                bail!("The filename template cannot contain path separators.");
            }
        }
        TemplateKind::Folder => validate_folder_shape(template)?,
    }
    Ok(())
}

fn validate_folder_shape(template: &str) -> Result<()> {
    if template.is_empty() {
        return Ok(());
    }
    if template.trim().is_empty() {
        bail!("The folder template cannot contain only whitespace.");
    }

    let bytes = template.as_bytes();
    let has_drive_prefix = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if template.starts_with(['/', '\\']) || has_drive_prefix || Path::new(template).is_absolute() {
        bail!("The folder template must be a relative path.");
    }

    for component in template.split(['/', '\\']) {
        if component.is_empty() {
            bail!("The folder template cannot contain empty path segments.");
        }
        if matches!(component.trim(), "." | "..") {
            bail!("The folder template cannot contain path traversal segments.");
        }
    }
    Ok(())
}

fn translate_template(template: &str, dialect: TemplateDialect) -> Result<String> {
    let characters = template.chars().collect::<Vec<_>>();
    let mut translated = String::with_capacity(template.len());
    let mut index = 0;

    while index < characters.len() {
        match characters[index] {
            '{' => {
                let close = characters[index + 1..]
                    .iter()
                    .position(|character| *character == '}')
                    .map(|offset| index + offset + 1)
                    .context("A naming token is missing its closing brace.")?;
                let token = characters[index + 1..close].iter().collect::<String>();
                translated.push_str(translate_token(&token, dialect)?);
                index = close + 1;
            }
            '}' => bail!("A naming token is missing its opening brace."),
            '%' if matches!(dialect, TemplateDialect::YtDlp) => {
                // A literal percent must be doubled in a yt-dlp output template.
                translated.push_str("%%");
                index += 1;
            }
            character => {
                translated.push(character);
                index += 1;
            }
        }
    }

    Ok(translated)
}

fn translate_token(token: &str, dialect: TemplateDialect) -> Result<&'static str> {
    let translated = match (dialect, token) {
        (TemplateDialect::Spotdl, "title") => "{title}",
        (TemplateDialect::Spotdl, "artist") => "{artist}",
        (TemplateDialect::Spotdl, "artists") => "{artists}",
        (TemplateDialect::Spotdl, "album") => "{album}",
        (TemplateDialect::Spotdl, "album_artist") => "{album-artist}",
        (TemplateDialect::Spotdl, "track") => "{track-number}",
        (TemplateDialect::Spotdl, "total_tracks") => "{tracks-count}",
        (TemplateDialect::Spotdl, "disc") => "{disc-number}",
        (TemplateDialect::Spotdl, "total_discs") => "{disc-count}",
        (TemplateDialect::Spotdl, "year") => "{year}",
        (TemplateDialect::Spotdl, "date") => "{original-date}",
        (TemplateDialect::Spotdl, "isrc") => "{isrc}",
        (TemplateDialect::Spotdl, "playlist") => "{list-name}",
        (TemplateDialect::Spotdl, "position") => "{list-position}",
        // `S` asks yt-dlp to sanitize each resolved metadata value as one
        // filename component before it is joined with our validated literal
        // separators. Non-empty fallbacks prevent a missing leading token from
        // turning the following `/` into a rooted path.
        (TemplateDialect::YtDlp, "title") => "%(track,title|Unknown Title)S",
        (TemplateDialect::YtDlp, "artist" | "artists") => "%(artist,uploader|Unknown Artist)S",
        (TemplateDialect::YtDlp, "album") => "%(album,playlist_title|Unknown Album)S",
        (TemplateDialect::YtDlp, "album_artist") => {
            "%(album_artist,artist,uploader|Unknown Album Artist)S"
        }
        (TemplateDialect::YtDlp, "track") => "%(track_number,playlist_index|0)S",
        (TemplateDialect::YtDlp, "total_tracks") => "%(track_count,playlist_count,n_entries|0)S",
        (TemplateDialect::YtDlp, "disc") => "%(disc_number|0)S",
        (TemplateDialect::YtDlp, "total_discs") => "%(disc_count|0)S",
        (TemplateDialect::YtDlp, "year") => {
            "%(release_year,release_date>%Y,upload_date>%Y|Unknown Year)S"
        }
        (TemplateDialect::YtDlp, "date") => "%(release_date,upload_date|Unknown Date)S",
        (TemplateDialect::YtDlp, "isrc") => "%(isrc|Unknown ISRC)S",
        (TemplateDialect::YtDlp, "playlist") => "%(playlist_title,playlist|Downloads)S",
        (TemplateDialect::YtDlp, "position") => "%(playlist_index,track_number|0)S",
        _ => bail!("Unknown naming token: {{{token}}}."),
    };
    Ok(translated)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub phase: String,
    pub percent: Option<f64>,
    pub bytes_written: u64,
    pub total_bytes: Option<u64>,
    pub title: String,
    pub item_index: Option<u64>,
    pub item_count: Option<u64>,
    pub source: DownloadSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub url: String,
    pub destination: String,
    pub files: Vec<String>,
    pub downloaded_count: usize,
    pub failed_count: usize,
    pub warnings: Vec<String>,
    pub mode: DownloadMode,
    pub source: DownloadSource,
    pub format: DownloadFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloaderStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub spotdl_installed: bool,
    pub spotdl_version: Option<String>,
    pub running: bool,
}

pub async fn downloader_status(app_data_dir: &Path) -> DownloaderStatus {
    let (direct_status, spotify_status) =
        tokio::join!(direct::status(app_data_dir), spotify::status(app_data_dir));

    DownloaderStatus {
        installed: direct_status.installed,
        version: direct_status.version,
        spotdl_installed: spotify_status.installed,
        spotdl_version: spotify_status.version,
        running: false,
    }
}

pub async fn download_media<F>(
    request: MediaDownloadRequest,
    app_data_dir: &Path,
    default_destination: &Path,
    cancel: Arc<AtomicBool>,
    mut report_progress: F,
) -> Result<DownloadResult>
where
    F: FnMut(DownloadProgress),
{
    let naming = DownloadNaming::new(
        &request.filename_template,
        &request.folder_template,
        request.apply_folder_to_single,
    )?;
    let mut parsed = reqwest::Url::parse(request.url.trim()).context("Invalid media URL.")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        bail!("Only HTTP and HTTPS media URLs are supported.");
    }

    let spotify_url = is_spotify_url(&parsed);
    match request.source {
        DownloadSource::Spotify if !spotify_url => {
            bail!("Enter an open.spotify.com track, album, or playlist link.")
        }
        DownloadSource::Web if spotify_url => {
            bail!("Use the Spotify tab for Spotify links.")
        }
        _ => {}
    }

    let mode = if request.source == DownloadSource::Spotify {
        validate_spotify_entity(&parsed)?.unwrap_or(request.mode)
    } else {
        request.mode
    };

    if request.source == DownloadSource::Spotify {
        // Share links often carry a per-user tracking query. spotDL only needs the
        // public entity URL, so keep that data out of subprocess logs and caches.
        parsed.set_query(None);
        parsed.set_fragment(None);
    }

    let destination = request
        .destination_dir
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_destination.to_path_buf());
    tokio::fs::create_dir_all(&destination)
        .await
        .context("Could not create the destination folder.")?;

    if cancel.load(Ordering::SeqCst) {
        bail!("Download cancelled.");
    }

    let options = DownloadOptions {
        mode,
        format: request.format,
        naming: &naming,
    };

    match request.source {
        DownloadSource::Spotify => {
            spotify::download(
                parsed,
                &destination,
                app_data_dir,
                options,
                &cancel,
                &mut report_progress,
            )
            .await
        }
        DownloadSource::Web => {
            direct::download(
                parsed,
                &destination,
                app_data_dir,
                options,
                &cancel,
                &mut report_progress,
            )
            .await
        }
    }
}

fn is_spotify_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("open.spotify.com"))
}

fn validate_spotify_entity(url: &reqwest::Url) -> Result<Option<DownloadMode>> {
    let segments = url
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.trim().is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for (index, segment) in segments.iter().enumerate() {
        match segment.to_ascii_lowercase().as_str() {
            "track" | "album" | "playlist" if segments.get(index + 1).is_none() => {
                bail!("The Spotify link is missing its track, album, or playlist identifier.")
            }
            "track" => return Ok(Some(DownloadMode::Single)),
            "album" => return Ok(Some(DownloadMode::Album)),
            "playlist" => return Ok(Some(DownloadMode::Playlist)),
            "artist" => {
                bail!(
                    "Artist discographies are not supported. Use a track, album, or playlist link."
                )
            }
            "episode" | "show" | "audiobook" => {
                bail!("Only Spotify music tracks, albums, and playlists are supported.")
            }
            _ => {}
        }
    }

    bail!("The Spotify link must point to a track, album, or playlist.")
}

pub(crate) fn executable_on_path(names: &[&str]) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .any(|path| names.iter().any(|name| path.join(name).is_file()))
        })
        .unwrap_or(false)
}

pub(crate) async fn terminate_child(child: &mut Child) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = child.id() {
        let mut command = Command::new("taskkill");
        hide_console_window(&mut command);
        let _ = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await;
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[cfg(target_os = "windows")]
pub(crate) fn hide_console_window(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn hide_console_window(_command: &mut Command) {}

pub(crate) fn useful_error(stderr: &str, fallback: &str) -> String {
    let lines = stderr
        .lines()
        .map(strip_ansi)
        .filter(|line| !line.trim().is_empty())
        .filter(|line| !line.contains("LOAVY|INFO|"))
        .collect::<Vec<_>>();
    let message = lines
        .iter()
        .rev()
        .take(6)
        .rev()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n");

    if message.is_empty() {
        fallback.to_string()
    } else {
        message
    }
}

pub(crate) fn strip_ansi(value: &str) -> String {
    let mut cleaned = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else if character != '\r' {
            cleaned.push(character);
        }
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::{
        is_spotify_url, strip_ansi, useful_error, validate_spotify_entity, DownloadMode,
        DownloadNaming, MediaDownloadRequest, DEFAULT_FILENAME_TEMPLATE, DEFAULT_FOLDER_TEMPLATE,
        MAX_NAMING_TEMPLATE_CHARS,
    };

    #[test]
    fn naming_fields_have_backwards_compatible_defaults() {
        let request: MediaDownloadRequest = serde_json::from_value(serde_json::json!({
            "url": "https://example.com/song",
            "destinationDir": null,
            "mode": "single"
        }))
        .unwrap();

        assert_eq!(request.filename_template, "{artist} - {title}");
        assert_eq!(request.folder_template, "{album_artist}/{album}");
        assert!(!request.apply_folder_to_single);

        let serialized = serde_json::to_value(request).unwrap();
        assert_eq!(
            serialized["filenameTemplate"],
            serde_json::json!(DEFAULT_FILENAME_TEMPLATE)
        );
        assert_eq!(
            serialized["folderTemplate"],
            serde_json::json!(DEFAULT_FOLDER_TEMPLATE)
        );
        assert_eq!(serialized["applyFolderToSingle"], serde_json::json!(false));
    }

    #[test]
    fn maps_every_friendly_token_to_spotdl() {
        let filename = "{title}_{artist}_{artists}_{album}_{album_artist}_{track}_{total_tracks}_{disc}_{total_discs}_{year}_{date}_{isrc}_{playlist}_{position}";
        let naming = DownloadNaming::new(filename, "Collection", false).unwrap();

        assert_eq!(
            naming.spotdl_output(DownloadMode::Playlist),
            "{title}_{artist}_{artists}_{album}_{album-artist}_{track-number}_{tracks-count}_{disc-number}_{disc-count}_{year}_{original-date}_{isrc}_{list-name}_{list-position}.{output-ext}"
        );
    }

    #[test]
    fn maps_every_friendly_token_to_yt_dlp() {
        let filename = "{title}_{artist}_{artists}_{album}_{album_artist}_{track}_{total_tracks}_{disc}_{total_discs}_{year}_{date}_{isrc}_{playlist}_{position}";
        let naming = DownloadNaming::new(filename, "Collection", false).unwrap();

        assert_eq!(
            naming.yt_dlp_target(DownloadMode::Playlist),
            "Collection/%(track,title|Unknown Title)S_%(artist,uploader|Unknown Artist)S_%(artist,uploader|Unknown Artist)S_%(album,playlist_title|Unknown Album)S_%(album_artist,artist,uploader|Unknown Album Artist)S_%(track_number,playlist_index|0)S_%(track_count,playlist_count,n_entries|0)S_%(disc_number|0)S_%(disc_count|0)S_%(release_year,release_date>%Y,upload_date>%Y|Unknown Year)S_%(release_date,upload_date|Unknown Date)S_%(isrc|Unknown ISRC)S_%(playlist_title,playlist|Downloads)S_%(playlist_index,track_number|0)S"
        );
    }

    #[test]
    fn default_naming_has_no_track_id_suffix() {
        let naming =
            DownloadNaming::new(DEFAULT_FILENAME_TEMPLATE, DEFAULT_FOLDER_TEMPLATE, false).unwrap();

        assert_eq!(
            naming.spotdl_output(DownloadMode::Single),
            "{artist} - {title}.{output-ext}"
        );
        assert_eq!(
            naming.yt_dlp_target(DownloadMode::Single),
            "%(artist,uploader|Unknown Artist)S - %(track,title|Unknown Title)S"
        );
        assert!(!naming
            .spotdl_output(DownloadMode::Single)
            .contains("track-id"));
        assert!(!naming.yt_dlp_target(DownloadMode::Single).contains("%(id)"));
    }

    #[test]
    fn applies_folder_templates_to_collections_and_optionally_singles() {
        let normal = DownloadNaming::new("{title}", "{artist}\\{album}", false).unwrap();
        assert_eq!(
            normal.spotdl_output(DownloadMode::Single),
            "{title}.{output-ext}"
        );
        assert_eq!(
            normal.spotdl_output(DownloadMode::Album),
            "{artist}/{album}/{title}.{output-ext}"
        );

        let separated = DownloadNaming::new("{title}", "{artist}/{album}", true).unwrap();
        assert_eq!(
            separated.spotdl_output(DownloadMode::Single),
            "{artist}/{album}/{title}.{output-ext}"
        );

        let flat = DownloadNaming::new("{title}", "", true).unwrap();
        assert_eq!(
            flat.spotdl_output(DownloadMode::Playlist),
            "{title}.{output-ext}"
        );
    }

    #[test]
    fn keeps_spotify_playlists_flat_even_with_a_folder_template() {
        let naming = DownloadNaming::new("{artist} - {title}", "{album_artist}/{album}", false)
            .unwrap();

        assert_eq!(
            naming.spotdl_output(DownloadMode::Playlist),
            "{artist} - {title}.{output-ext}"
        );
        assert_eq!(
            naming.spotdl_output(DownloadMode::Album),
            "{album-artist}/{album}/{artist} - {title}.{output-ext}"
        );
    }

    #[test]
    fn rejects_unsafe_or_malformed_filename_templates() {
        for template in [
            "",
            "   ",
            "folder/{title}",
            "folder\\{title}",
            "{id}",
            "{track-id}",
            "{title",
            "title}",
            "title|spoof",
            "bad\ntitle",
        ] {
            assert!(
                DownloadNaming::new(template, "", false).is_err(),
                "template should be rejected: {template:?}"
            );
        }

        let too_long = "x".repeat(MAX_NAMING_TEMPLATE_CHARS + 1);
        assert!(DownloadNaming::new(&too_long, "", false).is_err());
    }

    #[test]
    fn rejects_unsafe_or_malformed_folder_templates() {
        for template in [
            "   ",
            "/absolute",
            "\\absolute",
            "C:\\absolute",
            "safe/../outside",
            "safe/./album",
            "safe//album",
            "safe\\\\album",
            "{unknown}/album",
            "{artist/album",
            "safe|spoof",
            "bad\nfolder",
        ] {
            assert!(
                DownloadNaming::new("{title}", template, false).is_err(),
                "template should be rejected: {template:?}"
            );
        }
    }

    #[test]
    fn escapes_native_yt_dlp_template_syntax_in_literals() {
        let naming = DownloadNaming::new("100% {title} %(id)s", "", false).unwrap();
        assert_eq!(
            naming.yt_dlp_target(DownloadMode::Single),
            "100%% %(track,title|Unknown Title)S %%(id)s"
        );
    }

    #[test]
    fn recognizes_supported_spotify_urls_and_entity_types() {
        let track = reqwest::Url::parse(
            "https://open.spotify.com/intl-pt/track/0VjIjW4GlUZAMYd2vXMi3b?si=private",
        )
        .unwrap();
        let album = reqwest::Url::parse("https://open.spotify.com/album/example").unwrap();
        let playlist = reqwest::Url::parse("https://open.spotify.com/playlist/example").unwrap();

        assert!(is_spotify_url(&track));
        assert_eq!(
            validate_spotify_entity(&track).unwrap(),
            Some(DownloadMode::Single)
        );
        assert_eq!(
            validate_spotify_entity(&album).unwrap(),
            Some(DownloadMode::Album)
        );
        assert_eq!(
            validate_spotify_entity(&playlist).unwrap(),
            Some(DownloadMode::Playlist)
        );
    }

    #[test]
    fn rejects_non_music_spotify_entities() {
        let artist = reqwest::Url::parse("https://open.spotify.com/artist/example").unwrap();
        let show = reqwest::Url::parse("https://open.spotify.com/show/example").unwrap();
        let incomplete = reqwest::Url::parse("https://open.spotify.com/track").unwrap();
        assert!(validate_spotify_entity(&artist).is_err());
        assert!(validate_spotify_entity(&show).is_err());
        assert!(validate_spotify_entity(&incomplete).is_err());
    }

    #[test]
    fn removes_terminal_escape_sequences() {
        assert_eq!(strip_ansi("\u{1b}[32mDone\u{1b}[0m\r"), "Done");
    }

    #[test]
    fn keeps_the_useful_end_of_errors() {
        let error = useful_error("one\ntwo\nthree\nfour\nfive\nsix\nseven\n", "fallback");
        assert_eq!(error, "two\nthree\nfour\nfive\nsix\nseven");
    }
}
