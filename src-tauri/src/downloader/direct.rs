use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
};

use super::{
    atomic_replace, download_verified_asset, file_sha256, find_executable_on_path,
    hide_console_window, read_bounded, terminate_child, useful_error, DownloadFormat, DownloadMode,
    DownloadOptions, DownloadProgress, DownloadResult, DownloadSource, PinnedAsset, ProcessFailure,
    ToolHealth,
};

const YT_DLP_VERSION: &str = "2026.08.19";
const YT_DLP_DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe";
const YT_DLP_SHA256: &str = "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a";
const PREVIOUS_YT_DLP_VERSION: &str = "2026.07.04";
const PREVIOUS_YT_DLP_SHA256: &str =
    "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8e";
const DENO_VERSION: &str = "2.9.5";
const DENO_DOWNLOAD_URL: &str =
    "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-pc-windows-msvc.zip";
const DENO_ZIP_SHA256: &str = "171efab55ac6b9881fd53ee4c20f8bf3bb1340ffc618483746909014db12216a";
// SHA-256 of deno.exe extracted from the checksum-verified release archive above.
const DENO_EXECUTABLE_SHA256: &str =
    "98f8c2a2d470e4ccb04c935c86ff8050817d877762aec5eaee9e409ccb3b9fd";
const MAX_TOOL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_DENO_ARCHIVE_BYTES: u64 = 96 * 1024 * 1024;
const MAX_DENO_EXECUTABLE_BYTES: u64 = 192 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;
const PROGRESS_PREFIX: &str = "LOAVY_PROGRESS|";
const PHASE_PREFIX: &str = "LOAVY_PHASE|";
const STAGING_OUTPUT_TEMPLATE: &str = "%(autonumber)06d.%(ext)s";
const MAX_TARGET_COMPONENT_BYTES: usize = 120;
const MAX_TARGET_COMPONENTS: usize = 32;
const MAX_RENDERED_TARGET_BYTES: usize = 8 * 1024;
static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);

pub(super) struct DirectToolStatus {
    pub yt_dlp: ToolHealth,
    pub js_runtime: ToolHealth,
}

#[derive(Debug, Clone)]
pub(super) struct JsRuntime {
    pub name: &'static str,
    pub version: String,
    pub executable: PathBuf,
}

impl JsRuntime {
    pub fn yt_dlp_argument(&self) -> String {
        format!("{}:{}", self.name, self.executable.to_string_lossy())
    }
}

#[derive(Debug)]
struct StagedFile {
    source: PathBuf,
    rendered_target: String,
}

#[derive(Debug, PartialEq, Eq)]
enum FinalizedFile {
    Moved(PathBuf),
    AlreadyExists(PathBuf),
}

#[derive(Debug)]
struct StagingDirectory {
    path: PathBuf,
    canonical_destination: PathBuf,
    active: bool,
}

impl StagingDirectory {
    async fn create(destination: &Path) -> Result<Self> {
        let canonical_destination = tokio::fs::canonicalize(destination)
            .await
            .context("Could not validate the download destination.")?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();

        for attempt in 0..32_u64 {
            let sequence = NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed);
            let name = format!(
                ".loavy-direct-{}-{timestamp}-{}",
                std::process::id(),
                sequence.saturating_add(attempt)
            );
            let candidate = canonical_destination.join(name);
            match tokio::fs::create_dir(&candidate).await {
                Ok(()) => {
                    let canonical = match tokio::fs::canonicalize(&candidate).await {
                        Ok(canonical) => canonical,
                        Err(error) => {
                            let _ = tokio::fs::remove_dir_all(&candidate).await;
                            return Err(error)
                                .context("Could not validate the direct-download staging folder.");
                        }
                    };
                    if canonical.parent() != Some(canonical_destination.as_path()) {
                        let _ = tokio::fs::remove_dir_all(&candidate).await;
                        bail!("The direct-download staging folder escaped the destination.");
                    }
                    return Ok(Self {
                        path: canonical,
                        canonical_destination,
                        active: true,
                    });
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(error)
                        .context("Could not create the direct-download staging folder.")
                }
            }
        }

        bail!("Could not allocate a unique direct-download staging folder.")
    }

    async fn cleanup(&mut self) -> Result<()> {
        if self.active {
            tokio::fs::remove_dir_all(&self.path)
                .await
                .context("Could not clean the direct-download staging folder.")?;
            self.active = false;
        }
        Ok(())
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        if self.active {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

fn new_record_prefix() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    hasher.write_u32(std::process::id());
    hasher.write_u64(NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed));
    format!("LOAVY_FILE_{:016x}|", hasher.finish())
}

fn parse_file_record(line: &str, record_prefix: &str) -> Option<(PathBuf, String)> {
    let payload = line.strip_prefix(record_prefix)?;
    let (source, rendered_target) = payload.split_once('|')?;
    if source.trim().is_empty() {
        return None;
    }
    Some((PathBuf::from(source.trim()), rendered_target.to_string()))
}

fn safe_relative_target(rendered: &str, format: DownloadFormat) -> Result<PathBuf> {
    if rendered.len() > MAX_RENDERED_TARGET_BYTES {
        bail!("The resolved filename is unexpectedly long.");
    }

    let raw_components = rendered.split('/').collect::<Vec<_>>();
    if raw_components.len() > MAX_TARGET_COMPONENTS {
        bail!("The resolved folder structure contains too many levels.");
    }

    let mut relative = PathBuf::new();
    let last_index = raw_components.len().saturating_sub(1);
    for (index, raw_component) in raw_components.into_iter().enumerate() {
        let extension_bytes = if index == last_index {
            format.as_str().len() + 1
        } else {
            0
        };
        let max_bytes = MAX_TARGET_COMPONENT_BYTES.saturating_sub(extension_bytes);
        let mut component = sanitize_target_component(raw_component, max_bytes);
        if index == last_index {
            component.push('.');
            component.push_str(format.as_str());
        }
        relative.push(component);
    }
    Ok(relative)
}

fn sanitize_target_component(raw: &str, max_bytes: usize) -> String {
    let mut sanitized = raw
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    sanitized = sanitized
        .trim()
        .trim_end_matches('.')
        .trim_end()
        .to_string();
    if sanitized.is_empty() || matches!(sanitized.as_str(), "." | "..") {
        sanitized = "_".to_string();
    }
    if is_windows_reserved_name(&sanitized) {
        sanitized.insert(0, '_');
    }
    truncate_utf8_bytes(&mut sanitized, max_bytes);
    sanitized = sanitized
        .trim()
        .trim_end_matches('.')
        .trim_end()
        .to_string();
    if sanitized.is_empty() || matches!(sanitized.as_str(), "." | "..") {
        sanitized = "_".to_string();
    }
    if is_windows_reserved_name(&sanitized) {
        sanitized.insert(0, '_');
        truncate_utf8_bytes(&mut sanitized, max_bytes);
    }
    sanitized
}

fn truncate_utf8_bytes(value: &mut String, max_bytes: usize) {
    if value.len() <= max_bytes {
        return;
    }
    let boundary = value
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max_bytes)
        .last()
        .unwrap_or(0);
    value.truncate(boundary);
}

fn is_windows_reserved_name(component: &str) -> bool {
    let basename = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    matches!(
        basename.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || basename
        .strip_prefix("COM")
        .or_else(|| basename.strip_prefix("LPT"))
        .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
}

async fn create_safe_target_parent(
    canonical_destination: &Path,
    relative_parent: &Path,
) -> Result<PathBuf> {
    let mut current = canonical_destination.to_path_buf();
    for component in relative_parent.iter() {
        let candidate = current.join(component);
        match tokio::fs::create_dir(&candidate).await {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error).context("Could not create a download target folder."),
        }
        let canonical = tokio::fs::canonicalize(&candidate)
            .await
            .context("Could not validate a download target folder.")?;
        if !canonical.starts_with(canonical_destination) {
            bail!("A resolved download folder escaped the selected destination.");
        }
        if !tokio::fs::metadata(&canonical)
            .await
            .context("Could not inspect a download target folder.")?
            .is_dir()
        {
            bail!("A resolved download folder is not a directory.");
        }
        current = canonical;
    }
    Ok(current)
}

async fn finalize_staged_file(
    staging: &StagingDirectory,
    staged_file: StagedFile,
    format: DownloadFormat,
) -> Result<FinalizedFile> {
    let canonical_source = tokio::fs::canonicalize(&staged_file.source)
        .await
        .context("Could not validate a staged audio file.")?;
    if canonical_source.parent() != Some(staging.path.as_path()) {
        bail!("A staged audio file escaped its isolated download folder.");
    }
    let source_metadata = tokio::fs::metadata(&canonical_source)
        .await
        .context("Could not inspect a staged audio file.")?;
    if !source_metadata.is_file() {
        bail!("A staged download was not a regular file.");
    }
    let source_extension = canonical_source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if !source_extension.eq_ignore_ascii_case(format.as_str()) {
        bail!("A staged download had an unexpected audio extension.");
    }

    let relative_target = safe_relative_target(&staged_file.rendered_target, format)?;
    let filename = relative_target
        .file_name()
        .context("The resolved filename was empty.")?;
    let relative_parent = relative_target.parent().unwrap_or_else(|| Path::new(""));
    let canonical_parent =
        create_safe_target_parent(&staging.canonical_destination, relative_parent).await?;
    if !canonical_parent.starts_with(&staging.canonical_destination) {
        bail!("The resolved download target escaped the selected destination.");
    }
    let target = canonical_parent.join(filename);

    match tokio::fs::symlink_metadata(&target).await {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                bail!("The resolved download target already exists but is not a regular file.");
            }
            let canonical_existing = tokio::fs::canonicalize(&target)
                .await
                .context("Could not validate an existing download target.")?;
            if !canonical_existing.starts_with(&staging.canonical_destination) {
                bail!("An existing download target escaped the selected destination.");
            }
            return Ok(FinalizedFile::AlreadyExists(target));
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("Could not inspect the download target."),
    }

    tokio::fs::rename(&canonical_source, &target)
        .await
        .context("Could not move a staged audio file into the selected destination.")?;
    let canonical_target = tokio::fs::canonicalize(&target)
        .await
        .context("Could not validate the completed download target.")?;
    if !canonical_target.starts_with(&staging.canonical_destination) {
        bail!("A completed download escaped the selected destination.");
    }
    Ok(FinalizedFile::Moved(target))
}

pub(super) async fn status(app_data_dir: &Path) -> DirectToolStatus {
    let (yt_dlp, js_runtime) =
        tokio::join!(yt_dlp_health(app_data_dir), js_runtime_health(app_data_dir));
    DirectToolStatus { yt_dlp, js_runtime }
}

pub(super) async fn download<F>(
    url: reqwest::Url,
    destination: &Path,
    app_data_dir: &Path,
    options: DownloadOptions<'_>,
    cancel: &AtomicBool,
    report_progress: &mut F,
) -> Result<DownloadResult>
where
    F: FnMut(DownloadProgress),
{
    let DownloadOptions {
        mode,
        format,
        naming,
    } = options;
    let executable = ensure_yt_dlp(app_data_dir, cancel, report_progress, true).await?;
    let ffmpeg = super::spotify::ensure_audio_processor(
        app_data_dir,
        cancel,
        DownloadSource::Web,
        report_progress,
    )
    .await?;
    let js_runtime = if is_youtube_url(&url) {
        Some(ensure_js_runtime(app_data_dir, cancel, report_progress, true).await?)
    } else {
        detect_js_runtime(app_data_dir).await
    };
    if cancel.load(Ordering::SeqCst) {
        bail!("Download cancelled.");
    }
    let cache_dir = app_data_dir.join("tools").join("yt-dlp-cache");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .context("Could not create the yt-dlp cache folder.")?;
    let mut staging = StagingDirectory::create(destination).await?;

    report_progress(DownloadProgress {
        phase: "reading".to_string(),
        percent: None,
        bytes_written: 0,
        total_bytes: None,
        title: match mode {
            DownloadMode::Single => "Reading song information".to_string(),
            DownloadMode::Album => "Reading album information".to_string(),
            DownloadMode::Playlist => "Reading playlist information".to_string(),
        },
        item_index: None,
        item_count: None,
        source: DownloadSource::Web,
    });

    let source_format = match format {
        DownloadFormat::M4a => "bestaudio[ext=m4a]/bestaudio/best",
        DownloadFormat::Mp3 | DownloadFormat::Opus | DownloadFormat::Flac => "bestaudio/best",
    };
    let record_prefix = new_record_prefix();
    let rendered_target_template = naming.yt_dlp_target(mode);
    let file_record_template =
        format!("after_move:{record_prefix}%(filepath)s|{rendered_target_template}");
    let mut command = Command::new(&executable);
    hide_console_window(&mut command);
    command
        .current_dir(&staging.path)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args([
            "--ignore-config",
            "--newline",
            "--progress",
            "--progress-delta",
            "0.25",
            "--no-colors",
            "--windows-filenames",
            "--trim-filenames",
            "180",
            "--continue",
            "--no-overwrites",
            "--format",
        ])
        .arg(source_format)
        .args([
            "--extract-audio",
            "--embed-metadata",
            "--audio-format",
            format.as_str(),
            "--audio-quality",
            "0",
            "--progress-template",
            "download:LOAVY_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress._percent_str)s|%(info.playlist_index)s|%(info.n_entries)s|%(info.title)s",
        ])
        .args([
            "--progress-template",
            "postprocess:LOAVY_PHASE|processing|%(info.playlist_index)s|%(info.n_entries)s|%(info.title)s",
            "--print",
            "before_dl:LOAVY_PHASE|reading|%(info.playlist_index)s|%(info.n_entries)s|%(info.title)s",
            "--print",
            "post_process:LOAVY_PHASE|embedding|%(info.playlist_index)s|%(info.n_entries)s|%(info.title)s",
            "--print",
        ])
        .arg(&file_record_template)
        .arg("--ffmpeg-location")
        .arg(&ffmpeg)
        .arg("--cache-dir")
        .arg(&cache_dir)
        .args(["--output", STAGING_OUTPUT_TEMPLATE]);

    if let Some(runtime) = &js_runtime {
        command.arg("--js-runtimes").arg(runtime.yt_dlp_argument());
    }

    match mode {
        DownloadMode::Single => {
            command.arg("--no-playlist");
        }
        DownloadMode::Album | DownloadMode::Playlist => {
            command.args(["--yes-playlist", "--no-abort-on-error"]);
        }
    }
    command.arg(url.as_str());

    let mut child = command.spawn().context("Could not start yt-dlp.")?;
    let stdout = child
        .stdout
        .take()
        .context("Could not read yt-dlp output.")?;
    let mut stdout_lines = BufReader::new(stdout).lines();
    let stderr = child
        .stderr
        .take()
        .context("Could not read yt-dlp errors.")?;
    let stderr_task = tokio::spawn(read_bounded(stderr, MAX_STDERR_BYTES));

    let mut staged_files = Vec::new();
    loop {
        if cancel.load(Ordering::SeqCst) {
            terminate_child(&mut child).await;
            let _ = stderr_task.await;
            let _ = staging.cleanup().await;
            bail!("Download cancelled.");
        }

        tokio::select! {
            line = stdout_lines.next_line() => {
                match line.context("Could not read yt-dlp progress.")? {
                    Some(line) => {
                        if let Some(progress) = parse_progress_line(&line) {
                            report_progress(progress);
                        } else if let Some(progress) = parse_phase_line(&line) {
                            report_progress(progress);
                        } else if let Some((path, rendered_target)) =
                            parse_file_record(&line, &record_prefix)
                        {
                            let source = if path.is_absolute() {
                                path
                            } else {
                                staging.path.join(path)
                            };
                            staged_files.push(StagedFile {
                                source,
                                rendered_target,
                            });
                        }
                    }
                    None => break,
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        }
    }

    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            terminate_child(&mut child).await;
            let _ = stderr_task.await;
            let _ = staging.cleanup().await;
            bail!("Download cancelled.");
        }
        tokio::select! {
            status = child.wait() => break status.context("Could not finish yt-dlp.")?,
            _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        }
    };
    let stderr_output = stderr_task.await.unwrap_or_default();

    let mut warnings = parse_yt_dlp_errors(&stderr_output);
    if !status.success() && warnings.is_empty() {
        warnings.push(useful_error(
            &stderr_output,
            "One or more playlist items could not be downloaded.",
        ));
    }

    let mut files = Vec::with_capacity(staged_files.len());
    let mut had_existing_collision = false;
    for staged_file in staged_files {
        if cancel.load(Ordering::SeqCst) {
            let _ = staging.cleanup().await;
            bail!("Download cancelled.");
        }
        report_progress(DownloadProgress {
            phase: "saving".to_string(),
            percent: None,
            bytes_written: 0,
            total_bytes: None,
            title: staged_file
                .source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Saving audio")
                .to_string(),
            item_index: None,
            item_count: None,
            source: DownloadSource::Web,
        });
        match finalize_staged_file(&staging, staged_file, format).await {
            Ok(FinalizedFile::Moved(path)) => files.push(path),
            Ok(FinalizedFile::AlreadyExists(path)) => {
                had_existing_collision = true;
                warnings.push(format!(
                    "Skipped {} because a file with that name already exists.",
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("a downloaded track")
                ));
            }
            Err(error) => warnings.push(format!("Could not save a downloaded track: {error:#}")),
        }
    }
    if let Err(error) = staging.cleanup().await {
        warnings.push(error.to_string());
    }

    files.sort();
    files.dedup();
    if files.is_empty() && !had_existing_collision {
        let detail = if status.success() {
            warnings.first().cloned().unwrap_or_else(|| {
                useful_error(&stderr_output, "yt-dlp did not produce an audio file.")
            })
        } else {
            useful_error(&stderr_output, "yt-dlp could not download this URL.")
        };
        return Err(ProcessFailure {
            summary: detail,
            exit_code: status.code(),
            stderr: stderr_output,
        }
        .into());
    }
    let files = files
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    Ok(DownloadResult {
        url: url.to_string(),
        destination: destination.to_string_lossy().to_string(),
        downloaded_count: files.len(),
        failed_count: warnings.len(),
        warnings,
        files,
        mode,
        source: DownloadSource::Web,
        format,
    })
}

async fn ensure_yt_dlp<F>(
    app_data_dir: &Path,
    cancel: &AtomicBool,
    report_progress: &mut F,
    allow_trusted_fallback: bool,
) -> Result<PathBuf>
where
    F: FnMut(DownloadProgress),
{
    let executable = yt_dlp_path(app_data_dir);
    let trusted_existing = trusted_yt_dlp_build(&executable).await;
    if trusted_existing.as_deref() == Some(YT_DLP_VERSION) {
        return Ok(executable);
    }
    match install_yt_dlp(&executable, cancel, report_progress).await {
        Ok(()) => Ok(executable),
        Err(_error) if allow_trusted_fallback && trusted_existing.is_some() => Ok(executable),
        Err(error) => Err(error),
    }
}

async fn install_yt_dlp<F>(
    executable: &Path,
    cancel: &AtomicBool,
    report_progress: &mut F,
) -> Result<()>
where
    F: FnMut(DownloadProgress),
{
    let partial = executable.with_extension("exe.download");
    let result = async {
        download_verified_asset(
            PinnedAsset {
                url: YT_DLP_DOWNLOAD_URL,
                sha256: YT_DLP_SHA256,
                max_bytes: MAX_TOOL_BYTES,
                partial: &partial,
                title: "Preparing yt-dlp",
                source: DownloadSource::Web,
            },
            cancel,
            report_progress,
        )
        .await?;
        validate_windows_executable(&partial, "yt-dlp").await?;
        if tool_version(&partial).await.as_deref() != Some(YT_DLP_VERSION) {
            bail!("The downloaded yt-dlp executable did not start with the expected version.");
        }
        atomic_replace(&partial, executable)
            .await
            .context("Could not atomically install yt-dlp.")?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
    }
    result
}

async fn trusted_yt_dlp_build(executable: &Path) -> Option<String> {
    // Hash first: never launch an executable from the managed tools directory
    // until it matches a release that Loavy explicitly trusts.
    let hash = file_sha256(executable).await.ok()?;
    let expected_version = if hash.eq_ignore_ascii_case(YT_DLP_SHA256) {
        YT_DLP_VERSION
    } else if hash.eq_ignore_ascii_case(PREVIOUS_YT_DLP_SHA256) {
        PREVIOUS_YT_DLP_VERSION
    } else {
        return None;
    };
    let version = tool_version(executable).await?;
    (version == expected_version).then_some(version)
}

async fn yt_dlp_health(app_data_dir: &Path) -> ToolHealth {
    let executable = yt_dlp_path(app_data_dir);
    if !executable.is_file() {
        return ToolHealth::missing(Some(YT_DLP_VERSION));
    }
    match trusted_yt_dlp_build(&executable).await {
        Some(version) if version == YT_DLP_VERSION => {
            ToolHealth::ready(Some(version), Some(YT_DLP_VERSION))
        }
        Some(version) => ToolHealth::update_available(version, YT_DLP_VERSION),
        None => ToolHealth::corrupt(
            None,
            Some(YT_DLP_VERSION),
            "The executable version or checksum is not a trusted Loavy build.",
        ),
    }
}

pub(super) async fn repair_tools<F>(
    app_data_dir: &Path,
    cancel: &AtomicBool,
    report_progress: &mut F,
) -> Result<()>
where
    F: FnMut(DownloadProgress),
{
    ensure_yt_dlp(app_data_dir, cancel, report_progress, false).await?;
    ensure_managed_deno(app_data_dir, cancel, report_progress).await?;
    Ok(())
}

pub(super) async fn ensure_js_runtime<F>(
    app_data_dir: &Path,
    cancel: &AtomicBool,
    report_progress: &mut F,
    allow_external: bool,
) -> Result<JsRuntime>
where
    F: FnMut(DownloadProgress),
{
    if allow_external {
        if let Some(runtime) = detect_js_runtime(app_data_dir).await {
            return Ok(runtime);
        }
    } else if let Some(runtime) = managed_deno_runtime(app_data_dir).await {
        return Ok(runtime);
    }
    ensure_managed_deno(app_data_dir, cancel, report_progress).await
}

async fn ensure_managed_deno<F>(
    app_data_dir: &Path,
    cancel: &AtomicBool,
    report_progress: &mut F,
) -> Result<JsRuntime>
where
    F: FnMut(DownloadProgress),
{
    if let Some(runtime) = managed_deno_runtime(app_data_dir).await {
        return Ok(runtime);
    }

    let executable = deno_path(app_data_dir);
    let archive = executable.with_extension("zip.download");
    let partial = executable.with_extension("exe.download");
    let result = async {
        download_verified_asset(
            PinnedAsset {
                url: DENO_DOWNLOAD_URL,
                sha256: DENO_ZIP_SHA256,
                max_bytes: MAX_DENO_ARCHIVE_BYTES,
                partial: &archive,
                title: "Preparing the JavaScript runtime",
                source: DownloadSource::Web,
            },
            cancel,
            report_progress,
        )
        .await?;

        let archive_for_task = archive.clone();
        let partial_for_task = partial.clone();
        tokio::task::spawn_blocking(move || {
            extract_deno_executable(&archive_for_task, &partial_for_task)
        })
        .await
        .context("The JavaScript runtime extraction task did not finish.")??;
        validate_windows_executable(&partial, "JavaScript runtime").await?;
        let executable_hash = file_sha256(&partial).await?;
        if !executable_hash.eq_ignore_ascii_case(DENO_EXECUTABLE_SHA256) {
            bail!("The extracted JavaScript runtime checksum did not match the trusted release.");
        }
        let version = deno_version(&partial)
            .await
            .context("The downloaded JavaScript runtime did not start correctly.")?;
        if version != DENO_VERSION {
            bail!("The downloaded JavaScript runtime version could not be verified.");
        }
        atomic_replace(&partial, &executable)
            .await
            .context("Could not atomically install the JavaScript runtime.")?;
        Ok(JsRuntime {
            name: "deno",
            version,
            executable,
        })
    }
    .await;
    let _ = tokio::fs::remove_file(&archive).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
    }
    result
}

fn extract_deno_executable(archive: &Path, destination: &Path) -> Result<()> {
    let file =
        std::fs::File::open(archive).context("Could not open the JavaScript runtime archive.")?;
    let mut archive = zip::ZipArchive::new(file)
        .context("The JavaScript runtime archive is not a valid ZIP file.")?;
    let matching_entries = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index_raw(index)
                .ok()
                .map(|entry| entry.name().replace('\\', "/"))
        })
        .filter(|name| name == "deno.exe")
        .count();
    if matching_entries != 1 {
        bail!("The JavaScript runtime archive did not contain exactly one deno.exe file.");
    }
    let mut entry = archive
        .by_name("deno.exe")
        .context("The JavaScript runtime executable was missing from its archive.")?;
    if entry.is_dir() || entry.size() == 0 || entry.size() > MAX_DENO_EXECUTABLE_BYTES {
        bail!("The JavaScript runtime archive contained an invalid executable.");
    }
    if entry.enclosed_name().as_deref() != Some(Path::new("deno.exe")) {
        bail!("The JavaScript runtime archive contained an unsafe path.");
    }
    let mut output = std::fs::File::create(destination)
        .context("Could not create the JavaScript runtime executable.")?;
    let copied = std::io::copy(
        &mut entry.by_ref().take(MAX_DENO_EXECUTABLE_BYTES + 1),
        &mut output,
    )
    .context("Could not extract the JavaScript runtime executable.")?;
    if copied == 0 || copied > MAX_DENO_EXECUTABLE_BYTES {
        bail!("The extracted JavaScript runtime was unexpectedly large.");
    }
    output
        .flush()
        .context("Could not finish extracting the JavaScript runtime.")?;
    output
        .sync_all()
        .context("Could not commit the JavaScript runtime to disk.")?;
    Ok(())
}

async fn managed_deno_runtime(app_data_dir: &Path) -> Option<JsRuntime> {
    let executable = deno_path(app_data_dir);
    if !file_sha256(&executable)
        .await
        .is_ok_and(|hash| hash.eq_ignore_ascii_case(DENO_EXECUTABLE_SHA256))
    {
        return None;
    }
    let version = deno_version(&executable).await?;
    (version == DENO_VERSION).then_some(JsRuntime {
        name: "deno",
        version,
        executable,
    })
}

pub(super) async fn detect_js_runtime(app_data_dir: &Path) -> Option<JsRuntime> {
    if let Some(runtime) = managed_deno_runtime(app_data_dir).await {
        return Some(runtime);
    }
    if let Some(executable) = find_executable_on_path(&["deno.exe", "deno"]) {
        if let Some(version) = deno_version(&executable).await {
            if version_at_least(&version, 2, 3) {
                return Some(JsRuntime {
                    name: "deno",
                    version,
                    executable,
                });
            }
        }
    }
    if let Some(executable) = find_executable_on_path(&["node.exe", "node"]) {
        if let Some(version) = node_version(&executable).await {
            if version_at_least(&version, 22, 0) {
                return Some(JsRuntime {
                    name: "node",
                    version,
                    executable,
                });
            }
        }
    }
    None
}

async fn js_runtime_health(app_data_dir: &Path) -> ToolHealth {
    if let Some(runtime) = detect_js_runtime(app_data_dir).await {
        return ToolHealth::ready(Some(runtime.version), Some(DENO_VERSION))
            .with_provider(runtime.name);
    }
    if deno_path(app_data_dir).is_file() {
        ToolHealth::corrupt(
            None,
            Some(DENO_VERSION),
            "The managed Deno executable failed its checksum or version verification.",
        )
        .with_provider("deno")
    } else {
        ToolHealth::missing(Some(DENO_VERSION)).with_provider("deno")
    }
}

async fn deno_version(executable: &Path) -> Option<String> {
    command_version(executable, &["--version"])
        .await?
        .lines()
        .next()?
        .trim()
        .strip_prefix("deno ")
        .map(str::to_string)
}

async fn node_version(executable: &Path) -> Option<String> {
    command_version(executable, &["--version"])
        .await?
        .lines()
        .next()?
        .trim()
        .strip_prefix('v')
        .map(str::to_string)
}

async fn command_version(executable: &Path, arguments: &[&str]) -> Option<String> {
    if !executable.is_file() {
        return None;
    }
    let mut command = Command::new(executable);
    command.kill_on_drop(true).stdin(Stdio::null());
    hide_console_window(&mut command);
    tokio::time::timeout(Duration::from_secs(8), command.args(arguments).output())
        .await
        .ok()
        .and_then(Result::ok)
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .filter(|version| !version.trim().is_empty())
}

fn version_at_least(version: &str, minimum_major: u64, minimum_minor: u64) -> bool {
    let mut parts = version
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok());
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    (major, minor) >= (minimum_major, minimum_minor)
}

fn is_youtube_url(url: &reqwest::Url) -> bool {
    url.host_str().is_some_and(|host| {
        let host = host.trim_start_matches("www.").to_ascii_lowercase();
        host == "youtube.com" || host.ends_with(".youtube.com") || host == "youtu.be"
    })
}

async fn tool_version(executable: &Path) -> Option<String> {
    command_version(executable, &["--version"])
        .await
        .map(|version| version.trim().to_string())
        .filter(|version| !version.is_empty())
}

async fn validate_windows_executable(path: &Path, title: &str) -> Result<()> {
    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("Could not validate {title}."))?;
    let mut magic = [0_u8; 2];
    file.read_exact(&mut magic)
        .await
        .with_context(|| format!("The {title} download was incomplete."))?;
    if magic != *b"MZ" {
        bail!("The {title} download was not a valid Windows executable.");
    }
    Ok(())
}

fn yt_dlp_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("tools").join("yt-dlp.exe")
}

fn deno_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("tools").join("deno").join("deno.exe")
}

fn parse_progress_line(line: &str) -> Option<DownloadProgress> {
    let payload = line.strip_prefix(PROGRESS_PREFIX)?;
    let fields = payload.splitn(6, '|').collect::<Vec<_>>();
    if fields.len() != 6 {
        return None;
    }

    Some(DownloadProgress {
        phase: "downloading".to_string(),
        percent: parse_percent(fields[2]),
        bytes_written: parse_u64(fields[0]).unwrap_or(0),
        total_bytes: parse_u64(fields[1]),
        title: unavailable_to_default(fields[5], "Downloading"),
        item_index: parse_u64(fields[3]),
        item_count: parse_u64(fields[4]),
        source: DownloadSource::Web,
    })
}

fn parse_phase_line(line: &str) -> Option<DownloadProgress> {
    let payload = line.strip_prefix(PHASE_PREFIX)?;
    let fields = payload.splitn(4, '|').collect::<Vec<_>>();
    if fields.len() != 4 {
        return None;
    }
    let phase = match fields[0].trim() {
        "reading" => "reading",
        "processing" => "processing",
        "embedding" => "embedding",
        "saving" => "saving",
        _ => return None,
    };
    Some(DownloadProgress {
        phase: phase.to_string(),
        percent: None,
        bytes_written: 0,
        total_bytes: None,
        title: unavailable_to_default(fields[3], "Processing audio"),
        item_index: parse_u64(fields[1]),
        item_count: parse_u64(fields[2]),
        source: DownloadSource::Web,
    })
}

fn parse_u64(value: &str) -> Option<u64> {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("NA") || value.eq_ignore_ascii_case("none") {
        None
    } else {
        value.parse().ok()
    }
}

fn parse_percent(value: &str) -> Option<f64> {
    value.trim().trim_end_matches('%').trim().parse().ok()
}

fn unavailable_to_default(value: &str, default: &str) -> String {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("NA") {
        default.to_string()
    } else {
        value.to_string()
    }
}

fn parse_yt_dlp_errors(stderr: &str) -> Vec<String> {
    let mut errors = stderr
        .lines()
        .filter_map(|line| {
            line.find("ERROR:")
                .map(|index| line[index..].trim().to_string())
        })
        .take(20)
        .collect::<Vec<_>>();
    errors.sort();
    errors.dedup();
    errors
}

#[cfg(test)]
mod tests {
    use std::{io::Write as _, path::PathBuf, time::SystemTime};

    use super::{
        extract_deno_executable, finalize_staged_file, is_youtube_url, parse_file_record,
        parse_phase_line, parse_progress_line, parse_yt_dlp_errors, safe_relative_target,
        sanitize_target_component, version_at_least, DownloadFormat, FinalizedFile, StagedFile,
        StagingDirectory, MAX_TARGET_COMPONENT_BYTES,
    };

    fn temporary_test_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "loavy-downloader-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn parses_yt_dlp_progress() {
        let progress =
            parse_progress_line("LOAVY_PROGRESS|524288|1048576| 50.0%|2|12|Example song")
                .expect("progress");

        assert_eq!(progress.bytes_written, 524_288);
        assert_eq!(progress.total_bytes, Some(1_048_576));
        assert_eq!(progress.percent, Some(50.0));
        assert_eq!(progress.item_index, Some(2));
        assert_eq!(progress.item_count, Some(12));
        assert_eq!(progress.title, "Example song");
    }

    #[test]
    fn parses_indeterminate_postprocessing_phases() {
        let processing =
            parse_phase_line("LOAVY_PHASE|processing|2|12|Example song").expect("phase");
        assert_eq!(processing.phase, "processing");
        assert_eq!(processing.percent, None);
        assert_eq!(processing.item_index, Some(2));
        assert_eq!(processing.item_count, Some(12));

        assert!(parse_phase_line("LOAVY_PHASE|unknown|2|12|Example song").is_none());
    }

    #[test]
    fn recognizes_youtube_hosts_and_runtime_version_floors() {
        for url in [
            "https://youtube.com/watch?v=example",
            "https://music.youtube.com/watch?v=example",
            "https://youtu.be/example",
        ] {
            assert!(is_youtube_url(&reqwest::Url::parse(url).unwrap()));
        }
        assert!(!is_youtube_url(
            &reqwest::Url::parse("https://notyoutube.com/watch?v=example").unwrap()
        ));
        assert!(version_at_least("2.9.5", 2, 3));
        assert!(!version_at_least("2.2.9", 2, 3));
        assert!(version_at_least("22.0.0", 22, 0));
        assert!(!version_at_least("21.9.0", 22, 0));
    }

    #[test]
    fn deno_archive_extraction_accepts_only_the_exact_safe_entry() {
        let root = temporary_test_directory("deno-zip");
        let valid_archive = root.join("valid.zip");
        let valid_output = root.join("deno.exe");
        {
            let file = std::fs::File::create(&valid_archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("deno.exe", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"MZtest executable").unwrap();
            zip.finish().unwrap();
        }
        extract_deno_executable(&valid_archive, &valid_output).unwrap();
        assert_eq!(std::fs::read(&valid_output).unwrap(), b"MZtest executable");

        let unsafe_archive = root.join("unsafe.zip");
        let unsafe_output = root.join("unsafe.exe");
        {
            let file = std::fs::File::create(&unsafe_archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("../deno.exe", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"MZunsafe").unwrap();
            zip.finish().unwrap();
        }
        assert!(extract_deno_executable(&unsafe_archive, &unsafe_output).is_err());
        assert!(!unsafe_output.exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracts_unique_playlist_errors() {
        let errors = parse_yt_dlp_errors(
            "WARNING: unavailable\nERROR: [site] first item\nERROR: [site] first item\n",
        );
        assert_eq!(errors, vec!["ERROR: [site] first item"]);
    }

    #[test]
    fn parses_authenticated_file_records_without_trimming_the_target() {
        let prefix = "LOAVY_FILE_unpredictable|";
        let parsed = parse_file_record(
            "LOAVY_FILE_unpredictable|000001.m4a|  Artist / Song  ",
            prefix,
        )
        .unwrap();
        assert_eq!(parsed.0, PathBuf::from("000001.m4a"));
        assert_eq!(parsed.1, "  Artist / Song  ");
        assert!(parse_file_record("LOAVY_FILE_spoof|000001.m4a|Song", prefix).is_none());
    }

    #[test]
    fn makes_adversarial_rendered_targets_relative_and_safe() {
        let cases = [
            ("../escape", PathBuf::from("_").join("escape.m4a")),
            ("/rooted", PathBuf::from("_").join("rooted.m4a")),
            ("..\\escape", PathBuf::from(".._escape.m4a")),
            ("C:/escape", PathBuf::from("C_").join("escape.m4a")),
            ("\\\\server\\share", PathBuf::from("__server_share.m4a")),
            ("../../..", PathBuf::from("_").join("_").join("_.m4a")),
            ("", PathBuf::from("_.m4a")),
        ];

        for (rendered, expected) in cases {
            let actual = safe_relative_target(rendered, DownloadFormat::M4a).unwrap();
            assert_eq!(actual, expected, "unexpected target for {rendered:?}");
            assert!(!actual.is_absolute());
        }
    }

    #[test]
    fn sanitizes_windows_invalid_and_reserved_components() {
        assert_eq!(
            safe_relative_target("CON/aux.txt/Lpt9", DownloadFormat::Flac).unwrap(),
            PathBuf::from("_CON").join("_aux.txt").join("_Lpt9.flac")
        );
        assert_eq!(
            safe_relative_target("bad<name>|with?stars*", DownloadFormat::Opus).unwrap(),
            PathBuf::from("bad_name__with_stars_.opus")
        );
        let long = "é".repeat(MAX_TARGET_COMPONENT_BYTES);
        let sanitized = sanitize_target_component(&long, MAX_TARGET_COMPONENT_BYTES);
        assert!(sanitized.len() <= MAX_TARGET_COMPONENT_BYTES);
        assert!(sanitized.is_char_boundary(sanitized.len()));
    }

    #[tokio::test]
    async fn moves_a_staged_file_into_sanitized_custom_folders() {
        let root = temporary_test_directory("move");
        let mut staging = StagingDirectory::create(&root).await.unwrap();
        let source = staging.path.join("000001.m4a");
        tokio::fs::write(&source, b"new audio").await.unwrap();

        let result = finalize_staged_file(
            &staging,
            StagedFile {
                source,
                rendered_target: "Artist/Album/Song".to_string(),
            },
            DownloadFormat::M4a,
        )
        .await
        .unwrap();
        let FinalizedFile::Moved(target) = result else {
            panic!("expected a moved file");
        };
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"new audio");
        assert!(tokio::fs::canonicalize(&target)
            .await
            .unwrap()
            .starts_with(tokio::fs::canonicalize(&root).await.unwrap()));

        staging.cleanup().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_collision_is_not_overwritten_or_reported_as_moved() {
        let root = temporary_test_directory("collision");
        let existing_parent = root.join("Artist");
        tokio::fs::create_dir(&existing_parent).await.unwrap();
        let existing = existing_parent.join("Song.m4a");
        tokio::fs::write(&existing, b"existing audio")
            .await
            .unwrap();

        let mut staging = StagingDirectory::create(&root).await.unwrap();
        let source = staging.path.join("000001.m4a");
        tokio::fs::write(&source, b"new audio").await.unwrap();
        let result = finalize_staged_file(
            &staging,
            StagedFile {
                source,
                rendered_target: "Artist/Song".to_string(),
            },
            DownloadFormat::M4a,
        )
        .await
        .unwrap();

        assert!(matches!(result, FinalizedFile::AlreadyExists(_)));
        assert_eq!(tokio::fs::read(&existing).await.unwrap(), b"existing audio");
        staging.cleanup().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
