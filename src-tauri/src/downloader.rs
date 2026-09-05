mod direct;
mod spotify;

use std::{
    fmt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};

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
    pub ffmpeg_installed: bool,
    pub ffmpeg_version: Option<String>,
    pub js_runtime_installed: bool,
    pub js_runtime_version: Option<String>,
    pub js_runtime_name: Option<String>,
    pub yt_dlp: ToolHealth,
    pub ffmpeg: ToolHealth,
    pub js_runtime: ToolHealth,
    pub spotdl: ToolHealth,
    pub running: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolHealthState {
    Ready,
    Missing,
    Corrupt,
    UpdateAvailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolHealth {
    pub state: ToolHealthState,
    pub version: Option<String>,
    pub expected_version: Option<String>,
    pub provider: Option<String>,
    pub detail: Option<String>,
}

impl ToolHealth {
    pub(crate) fn ready(version: Option<String>, expected_version: Option<&str>) -> Self {
        Self {
            state: ToolHealthState::Ready,
            version,
            expected_version: expected_version.map(ToOwned::to_owned),
            provider: None,
            detail: None,
        }
    }

    pub(crate) fn missing(expected_version: Option<&str>) -> Self {
        Self {
            state: ToolHealthState::Missing,
            version: None,
            expected_version: expected_version.map(ToOwned::to_owned),
            provider: None,
            detail: None,
        }
    }

    pub(crate) fn corrupt(
        version: Option<String>,
        expected_version: Option<&str>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            state: ToolHealthState::Corrupt,
            version,
            expected_version: expected_version.map(ToOwned::to_owned),
            provider: None,
            detail: Some(detail.into()),
        }
    }

    pub(crate) fn update_available(version: String, expected_version: &str) -> Self {
        Self {
            state: ToolHealthState::UpdateAvailable,
            version: Some(version),
            expected_version: Some(expected_version.to_string()),
            provider: None,
            detail: Some("A newer tested build is ready to install.".to_string()),
        }
    }

    pub(crate) fn with_provider(mut self, provider: impl Into<String>) -> Self {
        self.provider = Some(provider.into());
        self
    }

    pub(crate) fn usable(&self) -> bool {
        matches!(
            self.state,
            ToolHealthState::Ready | ToolHealthState::UpdateAvailable
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadDiagnostic {
    pub loavy_version: String,
    pub yt_dlp_version: Option<String>,
    pub ffmpeg_version: Option<String>,
    pub js_runtime: Option<String>,
    pub source: DownloadSource,
    pub requested_format: DownloadFormat,
    pub exit_code: Option<i32>,
    pub reason: String,
    pub relevant_stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFailure {
    pub message: String,
    pub category: String,
    pub retryable: bool,
    pub diagnostic: DownloadDiagnostic,
}

impl fmt::Display for DownloadFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for DownloadFailure {}

#[derive(Debug)]
pub(crate) struct ProcessFailure {
    pub summary: String,
    pub exit_code: Option<i32>,
    pub stderr: String,
}

impl fmt::Display for ProcessFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.summary)
    }
}

impl std::error::Error for ProcessFailure {}

pub async fn downloader_status(app_data_dir: &Path) -> DownloaderStatus {
    let (direct_status, spotify_status) =
        tokio::join!(direct::status(app_data_dir), spotify::status(app_data_dir));

    let installed = direct_status.yt_dlp.usable()
        && direct_status.js_runtime.usable()
        && spotify_status.ffmpeg.usable();
    let spotdl_installed = spotify_status.spotdl.usable()
        && spotify_status.ffmpeg.usable()
        && direct_status.js_runtime.usable();

    DownloaderStatus {
        installed,
        version: direct_status.yt_dlp.version.clone(),
        spotdl_installed,
        spotdl_version: spotify_status.spotdl.version.clone(),
        ffmpeg_installed: spotify_status.ffmpeg.usable(),
        ffmpeg_version: spotify_status.ffmpeg.version.clone(),
        js_runtime_installed: direct_status.js_runtime.usable(),
        js_runtime_version: direct_status.js_runtime.version.clone(),
        js_runtime_name: direct_status.js_runtime.provider.clone(),
        yt_dlp: direct_status.yt_dlp,
        ffmpeg: spotify_status.ffmpeg,
        js_runtime: direct_status.js_runtime,
        spotdl: spotify_status.spotdl,
        running: false,
    }
}

pub async fn download_media<F>(
    request: MediaDownloadRequest,
    app_data_dir: &Path,
    default_destination: &Path,
    cancel: Arc<AtomicBool>,
    mut report_progress: F,
) -> std::result::Result<DownloadResult, DownloadFailure>
where
    F: FnMut(DownloadProgress),
{
    let source = request.source;
    let format = request.format;
    let destination_hint = request
        .destination_dir
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .map(PathBuf::from)
        .unwrap_or_else(|| default_destination.to_path_buf());
    let result = download_media_inner(
        request,
        app_data_dir,
        default_destination,
        cancel,
        &mut report_progress,
    )
    .await;

    match result {
        Ok(download) => Ok(download),
        Err(error) => {
            Err(
                build_download_failure(error, app_data_dir, &destination_hint, source, format)
                    .await,
            )
        }
    }
}

async fn download_media_inner<F>(
    request: MediaDownloadRequest,
    app_data_dir: &Path,
    default_destination: &Path,
    cancel: Arc<AtomicBool>,
    report_progress: &mut F,
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
        .map(str::trim)
        .map(PathBuf::from)
        .unwrap_or_else(|| default_destination.to_path_buf());
    // Subprocesses change their working directory. Resolve a typed relative
    // destination once so manifests and saved paths refer to the same folder.
    let destination =
        std::path::absolute(&destination).context("Could not resolve the destination folder.")?;
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
                report_progress,
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
                report_progress,
            )
            .await
        }
    }
}

pub async fn repair_downloader_tools<F>(
    app_data_dir: &Path,
    cancel: Arc<AtomicBool>,
    mut report_progress: F,
) -> Result<DownloaderStatus>
where
    F: FnMut(DownloadProgress),
{
    direct::repair_tools(app_data_dir, &cancel, &mut report_progress).await?;
    spotify::repair_tools(app_data_dir, &cancel, &mut report_progress).await?;
    Ok(downloader_status(app_data_dir).await)
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

pub(crate) fn find_executable_on_path(names: &[&str]) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).find_map(|path| {
                names
                    .iter()
                    .map(|name| path.join(name))
                    .find(|candidate| candidate.is_file())
            })
        })
        .unwrap_or(None)
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

pub(crate) struct PinnedAsset<'a> {
    pub url: &'a str,
    pub sha256: &'a str,
    pub max_bytes: u64,
    pub partial: &'a Path,
    pub title: &'a str,
    pub source: DownloadSource,
}

pub(crate) async fn download_verified_asset<F>(
    asset: PinnedAsset<'_>,
    cancel: &AtomicBool,
    report_progress: &mut F,
) -> Result<()>
where
    F: FnMut(DownloadProgress),
{
    if cancel.load(Ordering::SeqCst) {
        bail!("Download cancelled.");
    }
    if let Some(parent) = asset.partial.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("Could not create the folder for {}.", asset.title))?;
    }
    let _ = tokio::fs::remove_file(asset.partial).await;

    let result = async {
        let client = reqwest::Client::builder()
            .user_agent(concat!("Loavy-Player/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(300))
            .build()
            .with_context(|| format!("Could not prepare {}.", asset.title))?;
        let request = client.get(asset.url).send();
        tokio::pin!(request);
        let mut response = loop {
            tokio::select! {
                response = &mut request => {
                    break response.with_context(|| format!("Could not download {}.", asset.title))?;
                }
                _ = tokio::time::sleep(Duration::from_millis(150)) => {
                    if cancel.load(Ordering::SeqCst) {
                        bail!("Download cancelled.");
                    }
                }
            }
        }
        .error_for_status()
        .with_context(|| format!("The {} download was rejected.", asset.title))?;

        let total_bytes = response.content_length();
        if total_bytes.is_some_and(|size| size > asset.max_bytes) {
            bail!("The {} download was unexpectedly large.", asset.title);
        }

        let mut file = tokio::fs::File::create(asset.partial)
            .await
            .with_context(|| format!("Could not create the file for {}.", asset.title))?;
        let mut hasher = Sha256::new();
        let mut bytes_written = 0_u64;
        loop {
            if cancel.load(Ordering::SeqCst) {
                bail!("Download cancelled.");
            }
            let chunk = tokio::select! {
                chunk = response.chunk() => {
                    chunk.with_context(|| format!("The {} download was interrupted.", asset.title))?
                }
                _ = tokio::time::sleep(Duration::from_millis(150)) => {
                    if cancel.load(Ordering::SeqCst) {
                        bail!("Download cancelled.");
                    }
                    continue;
                }
            };
            let Some(chunk) = chunk else { break };
            bytes_written = bytes_written.saturating_add(chunk.len() as u64);
            if bytes_written > asset.max_bytes {
                bail!("The {} download exceeded the allowed size.", asset.title);
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .with_context(|| format!("Could not write {}.", asset.title))?;
            report_progress(DownloadProgress {
                phase: "preparing".to_string(),
                percent: total_bytes
                    .filter(|total| *total > 0)
                    .map(|total| bytes_written as f64 / total as f64 * 100.0),
                bytes_written,
                total_bytes,
                title: asset.title.to_string(),
                item_index: None,
                item_count: None,
                source: asset.source,
            });
        }

        file.flush()
            .await
            .with_context(|| format!("Could not finish writing {}.", asset.title))?;
        file.sync_all()
            .await
            .with_context(|| format!("Could not commit {} to disk.", asset.title))?;
        drop(file);

        let actual_sha256 = format!("{:x}", hasher.finalize());
        if !actual_sha256.eq_ignore_ascii_case(asset.sha256) {
            bail!(
                "The {} checksum did not match the trusted release.",
                asset.title
            );
        }
        Ok(())
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(asset.partial).await;
    }
    result
}

pub(crate) async fn file_sha256(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("Could not open {} for verification.", path.display()))?;
    let mut hasher = Sha256::new();
    // This buffer lives across awaits. Keep it on the heap: tool health checks
    // join several hash futures, and Tauri constructs their parent command
    // future on the UI thread's small Windows stack before scheduling it.
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .with_context(|| format!("Could not verify {}.", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) async fn atomic_replace(partial: &Path, destination: &Path) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };

        let partial = partial
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        tokio::task::spawn_blocking(move || unsafe {
            MoveFileExW(
                PCWSTR(partial.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(anyhow::Error::from)
        })
        .await
        .context("The verified tool replacement task did not finish.")??;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        tokio::fs::rename(partial, destination)
            .await
            .context("Could not atomically install the verified tool.")
    }
}

pub(crate) async fn read_bounded<R>(mut reader: R, limit: usize) -> String
where
    R: AsyncRead + Unpin,
{
    let mut retained = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let Ok(read) = reader.read(&mut buffer).await else {
            break;
        };
        if read == 0 {
            break;
        }
        retained.extend_from_slice(&buffer[..read]);
        if retained.len() > limit {
            let excess = retained.len() - limit;
            retained.drain(..excess);
        }
    }
    String::from_utf8_lossy(&retained).into_owned()
}

async fn build_download_failure(
    error: anyhow::Error,
    app_data_dir: &Path,
    destination: &Path,
    source: DownloadSource,
    requested_format: DownloadFormat,
) -> DownloadFailure {
    let process = error.downcast_ref::<ProcessFailure>();
    let exit_code = process.and_then(|failure| failure.exit_code);
    let raw_stderr = process
        .map(|failure| failure.stderr.as_str())
        .unwrap_or_default();
    let raw_reason = format!("{error:#}");
    let reason = sanitize_diagnostic_text(&raw_reason, app_data_dir, destination, 4 * 1024);
    let relevant_stderr =
        sanitize_diagnostic_text(raw_stderr, app_data_dir, destination, 24 * 1024);
    let combined = format!("{reason}\n{relevant_stderr}").to_ascii_lowercase();
    let (category, message, retryable) = classify_download_failure(&combined, &reason);
    let status = downloader_status(app_data_dir).await;
    let js_runtime = status.js_runtime_name.as_ref().map(|name| {
        status
            .js_runtime_version
            .as_ref()
            .map(|version| format!("{name} {version}"))
            .unwrap_or_else(|| name.clone())
    });

    DownloadFailure {
        message,
        category: category.to_string(),
        retryable,
        diagnostic: DownloadDiagnostic {
            loavy_version: env!("CARGO_PKG_VERSION").to_string(),
            yt_dlp_version: status.version,
            ffmpeg_version: status.ffmpeg_version,
            js_runtime,
            source,
            requested_format,
            exit_code,
            reason,
            relevant_stderr,
        },
    }
}

fn classify_download_failure(combined: &str, reason: &str) -> (&'static str, String, bool) {
    if combined.contains("download cancelled") {
        return ("cancelled", "Download cancelled.".to_string(), false);
    }
    if [
        "no supported javascript runtime",
        "javascript runtime is unavailable",
        "challenge solving failed",
        "n challenge",
        "only images are available",
    ]
    .iter()
    .any(|marker| combined.contains(marker))
    {
        return (
            "jsRuntime",
            "YouTube extraction failed because a JavaScript runtime is unavailable or could not solve the current challenge.".to_string(),
            true,
        );
    }
    if [
        "private video",
        "members-only",
        "login required",
        "sign in to confirm",
        "requires authentication",
        "age-restricted",
    ]
    .iter()
    .any(|marker| combined.contains(marker))
    {
        return (
            "authentication",
            "This media is private, age-restricted, or requires authentication. Loavy only downloads public supported media.".to_string(),
            false,
        );
    }
    if combined.contains("requested format is not available")
        || combined.contains("requested audio format is unavailable")
    {
        return (
            "format",
            "The requested audio format is unavailable for this media.".to_string(),
            false,
        );
    }
    if combined.contains("not available in your country")
        || combined.contains("geo restricted")
        || combined.contains("region-blocked")
    {
        return (
            "region",
            "This media is not available in the current region.".to_string(),
            false,
        );
    }
    if [
        "timed out",
        "temporary failure",
        "connection reset",
        "connection aborted",
        "network is unreachable",
        "http error 429",
        "http error 500",
        "http error 502",
        "http error 503",
        "http error 504",
    ]
    .iter()
    .any(|marker| combined.contains(marker))
    {
        return (
            "network",
            "The download was interrupted by a temporary network or service error.".to_string(),
            true,
        );
    }
    if [
        "unable to extract",
        "unsupported youtube response",
        "please update to the latest version",
        "player response",
        "signature extraction failed",
    ]
    .iter()
    .any(|marker| combined.contains(marker))
    {
        return (
            "extractor",
            "The installed yt-dlp build no longer supports this media response. Repair the downloader tools and try again.".to_string(),
            true,
        );
    }
    if combined.contains("checksum did not match")
        || combined.contains("could not prepare")
        || combined.contains("did not start correctly")
    {
        return (
            "tools",
            "The downloader tools could not be prepared safely. Use Repair tools and try again."
                .to_string(),
            true,
        );
    }

    let friendly = reason
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().trim_start_matches("ERROR: "))
        .filter(|line| !line.is_empty())
        .unwrap_or("The downloader could not finish this request.");
    ("other", truncate_text(friendly, 320), false)
}

fn sanitize_diagnostic_text(
    value: &str,
    app_data_dir: &Path,
    destination: &Path,
    limit: usize,
) -> String {
    let mut sanitized = strip_ansi(value);
    for (path, replacement) in [
        (Some(app_data_dir.to_path_buf()), "<Loavy app data>"),
        (Some(destination.to_path_buf()), "<destination>"),
        (
            std::env::var_os("USERPROFILE").map(PathBuf::from),
            "<user profile>",
        ),
    ] {
        if let Some(path) = path {
            let path = path.to_string_lossy();
            if !path.is_empty() {
                sanitized = sanitized.replace(path.as_ref(), replacement);
            }
        }
    }
    sanitized = redact_url_queries(&sanitized);
    let sanitized = sanitized
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("authorization:")
                || lower.contains("cookie:")
                || lower.contains("access_token=")
                || lower.contains("refresh_token=")
                || lower.contains("api_key=")
            {
                "[redacted sensitive diagnostic line]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    truncate_text(&sanitized, limit)
}

fn redact_url_queries(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(offset) = match (rest.find("http://"), rest.find("https://")) {
        (Some(http), Some(https)) => Some(http.min(https)),
        (Some(offset), None) | (None, Some(offset)) => Some(offset),
        (None, None) => None,
    } {
        output.push_str(&rest[..offset]);
        let candidate = &rest[offset..];
        let end = candidate
            .char_indices()
            .find(|(_, character)| {
                character.is_whitespace() || matches!(character, '"' | '\'' | '<' | '>')
            })
            .map(|(index, _)| index)
            .unwrap_or(candidate.len());
        let (token, after) = candidate.split_at(end);
        let trimmed = token.trim_end_matches([',', ';', ')', ']']);
        let punctuation = &token[trimmed.len()..];
        if let Ok(mut url) = reqwest::Url::parse(trimmed) {
            url.set_query(None);
            url.set_fragment(None);
            output.push_str(url.as_str().trim_end_matches('/'));
            output.push_str(punctuation);
        } else {
            output.push_str(trimmed.split(['?', '#']).next().unwrap_or(trimmed));
            output.push_str(punctuation);
        }
        rest = after;
    }
    output.push_str(rest);
    output
}

fn truncate_text(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut start = value.len() - limit;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    format!("...{}", &value[start..])
}

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
        classify_download_failure, is_spotify_url, read_bounded, redact_url_queries,
        sanitize_diagnostic_text, strip_ansi, useful_error, validate_spotify_entity, DownloadMode,
        DownloadNaming, MediaDownloadRequest, DEFAULT_FILENAME_TEMPLATE, DEFAULT_FOLDER_TEMPLATE,
        MAX_NAMING_TEMPLATE_CHARS,
    };
    use tokio::io::AsyncWriteExt;

    #[test]
    fn downloader_futures_fit_the_windows_ui_thread_stack() {
        // Tauri constructs command futures on the Windows UI thread before
        // scheduling them. Nested joins must not duplicate large inline buffers.
        let path = std::path::Path::new("unused-test-path");
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let request: MediaDownloadRequest = serde_json::from_value(serde_json::json!({
            "url": "https://example.com/test.mp3", "mode": "single"
        }))
        .unwrap();
        fn future_size<F: std::future::Future>(_: impl FnOnce() -> F) -> usize {
            std::mem::size_of::<F>()
        }
        let sizes = [
            ("status", future_size(|| super::downloader_status(path))),
            (
                "download",
                future_size(|| super::download_media(request, path, path, cancel.clone(), |_| {})),
            ),
            (
                "repair",
                future_size(|| super::repair_downloader_tools(path, cancel.clone(), |_| {})),
            ),
        ];
        assert!(
            sizes.iter().all(|(_, size)| *size < 64 * 1024),
            "Downloader futures are too large for UI-thread dispatch: {sizes:?}"
        );
    }

    /// Opt-in check with real managed yt-dlp/FFmpeg and locally generated audio.
    /// The data directory must be an isolated test folder, not the user's app data.
    #[tokio::test]
    #[ignore = "requires managed tools; set LOAVY_DOWNLOADER_TEST_DATA to an isolated folder"]
    async fn native_downloader_converts_local_audio_and_saves_each_format() {
        use tokio::io::AsyncReadExt;
        let data = std::path::PathBuf::from(std::env::var("LOAVY_DOWNLOADER_TEST_DATA").unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&32036_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&16000_u32.to_le_bytes());
        wav.extend_from_slice(&32000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&32000_u32.to_le_bytes());
        wav.resize(32044, 0);
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = [0; 4096];
                let _ = stream.read(&mut request).await;
                let header = format!("HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", wav.len());
                let _ = stream.write_all(header.as_bytes()).await;
                let _ = stream.write_all(&wav).await;
            }
        });
        let destination = data.join(format!(
            "Saved Music {}",
            chrono::Utc::now().timestamp_millis()
        ));
        for format in [
            super::DownloadFormat::M4a,
            super::DownloadFormat::Mp3,
            super::DownloadFormat::Opus,
            super::DownloadFormat::Flac,
        ] {
            let request = MediaDownloadRequest {
                url: format!("http://{address}/test.wav"),
                destination_dir: Some(destination.to_string_lossy().into_owned()),
                mode: DownloadMode::Single,
                source: super::DownloadSource::Web,
                format,
                filename_template: "Native smoke test".into(),
                folder_template: "Test Album".into(),
                apply_folder_to_single: true,
            };
            let result = super::download_media_inner(
                request,
                &data,
                &destination,
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                &mut |_| {},
            )
            .await
            .unwrap();
            assert_eq!(result.downloaded_count, 1, "{result:?}");
            assert_eq!(result.failed_count, 0, "{result:?}");
            let expected = destination
                .join("Test Album")
                .join(format!("Native smoke test.{}", format.as_str()));
            assert_eq!(
                std::fs::canonicalize(&result.files[0]).unwrap(),
                std::fs::canonicalize(&expected).unwrap()
            );
            assert!(std::fs::metadata(&expected).unwrap().len() > 44);
            lofty::probe::Probe::open(&expected)
                .unwrap()
                .read()
                .unwrap();
        }
        server.abort();
        assert!(std::fs::read_dir(&destination).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".loavy-direct-")));
    }

    #[tokio::test]
    async fn cancelled_tool_setup_does_not_create_files_or_start_network_requests() {
        let partial =
            std::env::temp_dir().join(format!("loavy-cancelled-{}.download", std::process::id()));
        let cancel = std::sync::atomic::AtomicBool::new(true);
        let error = super::download_verified_asset(
            super::PinnedAsset {
                url: "http://127.0.0.1:1/should-not-be-requested",
                sha256: "unused",
                max_bytes: 1,
                partial: &partial,
                title: "test tool",
                source: super::DownloadSource::Web,
            },
            &cancel,
            &mut |_| panic!("Cancelled setup should not report progress"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "Download cancelled.");
        assert!(!partial.exists());
    }

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
        let naming =
            DownloadNaming::new("{artist} - {title}", "{album_artist}/{album}", false).unwrap();

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

    #[test]
    fn redacts_paths_secrets_and_url_queries_from_diagnostics() {
        let app_data = std::path::Path::new(r"C:\Users\Example\AppData\Roaming\Loavy");
        let destination = std::path::Path::new(r"D:\Private Music");
        let raw = concat!(
            r"failed at C:\Users\Example\AppData\Roaming\Loavy\tools\yt-dlp.exe ",
            r"saving D:\Private Music\Song.m4a ",
            "https://example.test/watch?id=secret#private then http://other.test/a?token=secret\n",
            "Authorization: Bearer very-secret"
        );

        let sanitized = sanitize_diagnostic_text(raw, app_data, destination, 16 * 1024);
        assert!(sanitized.contains("<Loavy app data>"));
        assert!(sanitized.contains("<destination>"));
        assert!(sanitized.contains("https://example.test/watch"));
        assert!(sanitized.contains("http://other.test/a"));
        for secret in ["very-secret", "id=secret", "token=secret", "Private Music"] {
            assert!(!sanitized.contains(secret));
        }
    }

    #[test]
    fn redacts_the_earliest_url_regardless_of_scheme() {
        assert_eq!(
            redact_url_queries("https://first.test/a?secret=1 then http://second.test/b?secret=2"),
            "https://first.test/a then http://second.test/b"
        );
    }

    #[test]
    fn classifies_actionable_download_failures() {
        let (category, _, retryable) = classify_download_failure(
            "no supported javascript runtime could be found",
            "runtime failed",
        );
        assert_eq!(category, "jsRuntime");
        assert!(retryable);

        let (category, _, retryable) =
            classify_download_failure("sign in to confirm your age", "login required");
        assert_eq!(category, "authentication");
        assert!(!retryable);

        let (category, _, retryable) =
            classify_download_failure("http error 503", "temporary service failure");
        assert_eq!(category, "network");
        assert!(retryable);
    }

    #[tokio::test]
    async fn bounded_reader_retains_only_the_recent_tail() {
        let (mut writer, reader) = tokio::io::duplex(32);
        writer.write_all(b"0123456789").await.unwrap();
        drop(writer);

        assert_eq!(read_bounded(reader, 4).await, "6789");
    }
}
