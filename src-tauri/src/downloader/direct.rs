use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

use super::{
    executable_on_path, hide_console_window, terminate_child, useful_error, DownloadFormat,
    DownloadMode, DownloadOptions, DownloadProgress, DownloadResult, DownloadSource,
};

const YT_DLP_VERSION: &str = "2026.07.04";
const YT_DLP_DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe";
const YT_DLP_SHA256: &str = "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8e";
const MAX_TOOL_BYTES: u64 = 128 * 1024 * 1024;
const PROGRESS_PREFIX: &str = "LOAVY_PROGRESS|";
const STAGING_OUTPUT_TEMPLATE: &str = "%(autonumber)06d.%(ext)s";
const MAX_TARGET_COMPONENT_BYTES: usize = 120;
const MAX_TARGET_COMPONENTS: usize = 32;
const MAX_RENDERED_TARGET_BYTES: usize = 8 * 1024;
static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);

pub(super) struct ToolStatus {
    pub installed: bool,
    pub version: Option<String>,
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

pub(super) async fn status(app_data_dir: &Path) -> ToolStatus {
    let executable = yt_dlp_path(app_data_dir);
    let version = tool_version(&executable).await;
    ToolStatus {
        installed: version.is_some() && super::spotify::audio_processor_installed(app_data_dir),
        version,
    }
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
    let executable = ensure_yt_dlp(app_data_dir, cancel, report_progress).await?;
    let ffmpeg = super::spotify::ensure_audio_processor(
        app_data_dir,
        cancel,
        DownloadSource::Web,
        report_progress,
    )
    .await?;
    if cancel.load(Ordering::SeqCst) {
        bail!("Download cancelled.");
    }
    let cache_dir = app_data_dir.join("tools").join("yt-dlp-cache");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .context("Could not create the yt-dlp cache folder.")?;
    let mut staging = StagingDirectory::create(destination).await?;

    report_progress(DownloadProgress {
        phase: "starting".to_string(),
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
            "--audio-format",
            format.as_str(),
            "--audio-quality",
            "0",
            "--progress-template",
            "download:LOAVY_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress._percent_str)s|%(info.playlist_index)s|%(info.n_entries)s|%(info.title)s",
            "--print",
        ])
        .arg(&file_record_template)
        .arg("--ffmpeg-location")
        .arg(&ffmpeg)
        .arg("--cache-dir")
        .arg(&cache_dir)
        .args(["--output", STAGING_OUTPUT_TEMPLATE]);

    if executable_on_path(&["node.exe", "node"]) {
        command.args(["--js-runtimes", "node"]);
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
    let mut stderr = child
        .stderr
        .take()
        .context("Could not read yt-dlp errors.")?;
    let stderr_task = tokio::spawn(async move {
        let mut output = String::new();
        let _ = stderr.read_to_string(&mut output).await;
        output
    });

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
        bail!("{detail}");
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
) -> Result<PathBuf>
where
    F: FnMut(DownloadProgress),
{
    let executable = yt_dlp_path(app_data_dir);
    if tool_version(&executable).await.as_deref() == Some(YT_DLP_VERSION) {
        return Ok(executable);
    }
    if executable.exists() {
        tokio::fs::remove_file(&executable)
            .await
            .context("Could not replace the damaged yt-dlp executable.")?;
    }

    let tools_dir = executable
        .parent()
        .context("Could not determine the yt-dlp tools folder.")?;
    tokio::fs::create_dir_all(tools_dir)
        .await
        .context("Could not create the yt-dlp tools folder.")?;

    let partial = executable.with_extension("exe.download");
    let _ = tokio::fs::remove_file(&partial).await;
    let client = reqwest::Client::builder()
        .user_agent(concat!("Loavy-Player/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(180))
        .build()
        .context("Could not prepare the yt-dlp installer.")?;
    let request = client.get(YT_DLP_DOWNLOAD_URL).send();
    tokio::pin!(request);
    let mut response = loop {
        tokio::select! {
            response = &mut request => break response.context("Could not download yt-dlp.")?,
            _ = tokio::time::sleep(Duration::from_millis(150)) => {
                if cancel.load(Ordering::SeqCst) {
                    bail!("Download cancelled.");
                }
            }
        }
    }
    .error_for_status()
    .context("The yt-dlp download was rejected.")?;
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size > MAX_TOOL_BYTES) {
        bail!("The yt-dlp download was unexpectedly large.");
    }

    let mut file = tokio::fs::File::create(&partial)
        .await
        .context("Could not create the yt-dlp executable.")?;
    let mut hasher = Sha256::new();
    let mut bytes_written = 0_u64;

    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk.context("The yt-dlp download was interrupted.")?,
            _ = tokio::time::sleep(Duration::from_millis(150)) => {
                if cancel.load(Ordering::SeqCst) {
                    drop(file);
                    let _ = tokio::fs::remove_file(&partial).await;
                    bail!("Download cancelled.");
                }
                continue;
            }
        };
        let Some(chunk) = chunk else { break };
        bytes_written += chunk.len() as u64;
        if bytes_written > MAX_TOOL_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(&partial).await;
            bail!("The yt-dlp download exceeded the allowed size.");
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .context("Could not write the yt-dlp executable.")?;
        report_progress(DownloadProgress {
            phase: "installing".to_string(),
            percent: total_bytes.map(|total| bytes_written as f64 / total as f64 * 100.0),
            bytes_written,
            total_bytes,
            title: "Installing yt-dlp".to_string(),
            item_index: None,
            item_count: None,
            source: DownloadSource::Web,
        });
    }

    file.flush()
        .await
        .context("Could not finish installing yt-dlp.")?;
    drop(file);
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if !actual_sha256.eq_ignore_ascii_case(YT_DLP_SHA256) {
        let _ = tokio::fs::remove_file(&partial).await;
        bail!("The yt-dlp checksum did not match the pinned release.");
    }
    validate_windows_executable(&partial).await?;
    tokio::fs::rename(&partial, &executable)
        .await
        .context("Could not finish installing yt-dlp.")?;

    if tool_version(&executable).await.as_deref() != Some(YT_DLP_VERSION) {
        let _ = tokio::fs::remove_file(&executable).await;
        bail!("The downloaded yt-dlp executable did not start correctly.");
    }
    Ok(executable)
}

async fn tool_version(executable: &Path) -> Option<String> {
    if !executable.is_file() {
        return None;
    }
    let mut command = Command::new(executable);
    hide_console_window(&mut command);
    tokio::time::timeout(Duration::from_secs(8), command.arg("--version").output())
        .await
        .ok()
        .and_then(Result::ok)
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .filter(|version| !version.is_empty())
}

async fn validate_windows_executable(path: &Path) -> Result<()> {
    let mut file = tokio::fs::File::open(path)
        .await
        .context("Could not validate the yt-dlp executable.")?;
    let mut magic = [0_u8; 2];
    file.read_exact(&mut magic)
        .await
        .context("The yt-dlp download was incomplete.")?;
    if magic != *b"MZ" {
        let _ = tokio::fs::remove_file(path).await;
        bail!("The yt-dlp download was not a valid Windows executable.");
    }
    Ok(())
}

fn yt_dlp_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("tools").join("yt-dlp.exe")
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
    use std::{path::PathBuf, time::SystemTime};

    use super::{
        finalize_staged_file, parse_file_record, parse_progress_line, parse_yt_dlp_errors,
        safe_relative_target, sanitize_target_component, DownloadFormat, FinalizedFile, StagedFile,
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
