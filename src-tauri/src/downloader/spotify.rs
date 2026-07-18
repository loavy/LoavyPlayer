use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
};

use super::{
    executable_on_path, hide_console_window, strip_ansi, terminate_child, useful_error,
    DownloadOptions, DownloadProgress, DownloadResult, DownloadSource,
};

const SPOTDL_VERSION: &str = "4.5.0";
const SPOTDL_DOWNLOAD_URL: &str =
    "https://github.com/spotDL/spotify-downloader/releases/download/v4.5.0/spotdl-4.5.0-win32.exe";
const SPOTDL_SHA256: &str = "55286c6dccf6adc973e0888a34e69db1a45cce67d2fab231feb785605f499bfc";
const SPOTDL_MAX_BYTES: u64 = 64 * 1024 * 1024;

const FFMPEG_DOWNLOAD_URL: &str =
    "https://github.com/eugeneware/ffmpeg-static/releases/download/b4.4/win32-x64";
// Filled from the pinned release asset rather than a mutable latest URL.
const FFMPEG_SHA256: &str = "8d7e6cf86ba7e0462643d3cc3745455adca6c9af5795574d67d125ae238296b2";
const FFMPEG_MAX_BYTES: u64 = 128 * 1024 * 1024;

const LOG_MARKER: &str = "LOAVY|";

pub(super) struct ToolStatus {
    pub installed: bool,
    pub version: Option<String>,
}

#[derive(Default)]
struct SpotdlProgressState {
    total: Option<u64>,
    completed: u64,
}

struct PinnedTool<'a> {
    url: &'a str,
    sha256: &'a str,
    max_bytes: u64,
    destination: &'a Path,
    title: &'a str,
}

pub(super) async fn status(app_data_dir: &Path) -> ToolStatus {
    let executable = spotdl_path(app_data_dir);
    let version = tool_version(&executable, app_data_dir).await;
    ToolStatus {
        installed: version.is_some() && audio_processor_installed(app_data_dir),
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
    let (spotdl, ffmpeg) = ensure_tools(app_data_dir, cancel, report_progress).await?;
    if cancel.load(Ordering::SeqCst) {
        bail!("Download cancelled.");
    }

    report_progress(DownloadProgress {
        phase: "resolving".to_string(),
        percent: None,
        bytes_written: 0,
        total_bytes: None,
        title: "Reading Spotify metadata".to_string(),
        item_index: None,
        item_count: None,
        source: DownloadSource::Spotify,
    });

    let run_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let manifest_name = format!("loavy-download-{run_id}.m3u8");
    let errors_name = format!("loavy-download-{run_id}.errors.txt");
    let manifest_path = destination.join(&manifest_name);
    let errors_path = destination.join(&errors_name);

    let output_template = naming.spotdl_output(mode);

    let mut command = Command::new(&spotdl);
    configure_spotdl_command(&mut command, app_data_dir);
    hide_console_window(&mut command);
    command
        .current_dir(destination)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .arg("download")
        .arg(url.as_str())
        .args([
            "--simple-tui",
            "--log-level",
            "INFO",
            "--log-format",
            "LOAVY|%(levelname)s|%(message)s",
            "--audio",
            "youtube-music",
            "youtube",
            "--lyrics",
            "--format",
            format.as_str(),
            "--bitrate",
            "auto",
            "--ffmpeg",
        ])
        .arg(&ffmpeg)
        .args([
            "--threads",
            "1",
            "--overwrite",
            "skip",
            "--restrict",
            "none",
            "--max-filename-length",
            "180",
            "--output",
            &output_template,
            "--m3u",
            &manifest_name,
            "--save-errors",
            &errors_name,
            "--print-errors",
        ]);

    if executable_on_path(&["node.exe", "node"]) {
        command.args(["--yt-dlp-args", "--js-runtimes node"]);
    }

    let mut child = command
        .spawn()
        .context("Could not start the Spotify downloader.")?;
    let stdout = child
        .stdout
        .take()
        .context("Could not read Spotify downloader output.")?;
    let stderr = child
        .stderr
        .take()
        .context("Could not read Spotify downloader errors.")?;
    let (line_tx, mut line_rx) = mpsc::unbounded_channel();
    let stdout_task = tokio::spawn(forward_lines(stdout, line_tx.clone()));
    let stderr_task = tokio::spawn(forward_lines(stderr, line_tx));

    let mut progress_state = SpotdlProgressState::default();
    let mut recent_output = VecDeque::with_capacity(24);
    let exit_status = loop {
        if cancel.load(Ordering::SeqCst) {
            terminate_child(&mut child).await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            cleanup_run_files(&manifest_path, &errors_path).await;
            bail!("Download cancelled.");
        }

        if let Some(status) = child
            .try_wait()
            .context("Could not check the Spotify downloader.")?
        {
            break status;
        }

        tokio::select! {
            line = line_rx.recv() => {
                if let Some(line) = line {
                    remember_line(&mut recent_output, &line);
                    if let Some(progress) = parse_spotdl_progress(&line, &mut progress_state) {
                        report_progress(progress);
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(120)) => {}
        }
    };

    let _ = stdout_task.await;
    let _ = stderr_task.await;
    while let Ok(line) = line_rx.try_recv() {
        remember_line(&mut recent_output, &line);
        if let Some(progress) = parse_spotdl_progress(&line, &mut progress_state) {
            report_progress(progress);
        }
    }

    let error_file = tokio::fs::read_to_string(&errors_path)
        .await
        .unwrap_or_default();
    let warnings = parse_error_file(&error_file);
    let mut files = read_manifest_paths(&manifest_path, destination).await?;
    cleanup_run_files(&manifest_path, &errors_path).await;

    if !exit_status.success() {
        let output = recent_output.into_iter().collect::<Vec<_>>().join("\n");
        let combined = if error_file.trim().is_empty() {
            output
        } else {
            format!("{output}\n{error_file}")
        };
        bail!(
            "{}",
            useful_error(
                &combined,
                "The Spotify downloader could not finish this link."
            )
        );
    }

    files.retain(|path| path.is_file());
    files.sort();
    files.dedup();
    if files.is_empty() {
        let detail = warnings
            .first()
            .cloned()
            .unwrap_or_else(|| "No matching audio was found for this Spotify link.".to_string());
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
        source: DownloadSource::Spotify,
        format,
    })
}

async fn ensure_tools<F>(
    app_data_dir: &Path,
    cancel: &AtomicBool,
    report_progress: &mut F,
) -> Result<(PathBuf, PathBuf)>
where
    F: FnMut(DownloadProgress),
{
    let root = spotdl_root(app_data_dir);
    tokio::fs::create_dir_all(&root)
        .await
        .context("Could not create the Spotify tools folder.")?;
    tokio::fs::create_dir_all(spotdl_home(app_data_dir))
        .await
        .context("Could not create the Spotify tool data folder.")?;

    let spotdl = spotdl_path(app_data_dir);
    if tool_version(&spotdl, app_data_dir).await.is_none() {
        if spotdl.exists() {
            tokio::fs::remove_file(&spotdl)
                .await
                .context("Could not replace the damaged spotDL executable.")?;
        }
        download_verified_tool(
            PinnedTool {
                url: SPOTDL_DOWNLOAD_URL,
                sha256: SPOTDL_SHA256,
                max_bytes: SPOTDL_MAX_BYTES,
                destination: &spotdl,
                title: "Installing Spotify support",
            },
            DownloadSource::Spotify,
            cancel,
            report_progress,
        )
        .await?;
        let version = tool_version(&spotdl, app_data_dir)
            .await
            .context("The downloaded spotDL executable did not start correctly.")?;
        if version != SPOTDL_VERSION {
            let _ = tokio::fs::remove_file(&spotdl).await;
            bail!("The Spotify downloader version could not be verified.");
        }
    }

    let ffmpeg = ensure_audio_processor(
        app_data_dir,
        cancel,
        DownloadSource::Spotify,
        report_progress,
    )
    .await?;

    Ok((spotdl, ffmpeg))
}

pub(super) async fn ensure_audio_processor<F>(
    app_data_dir: &Path,
    cancel: &AtomicBool,
    source: DownloadSource,
    report_progress: &mut F,
) -> Result<PathBuf>
where
    F: FnMut(DownloadProgress),
{
    tokio::fs::create_dir_all(spotdl_root(app_data_dir))
        .await
        .context("Could not create the audio tools folder.")?;
    let ffmpeg = ffmpeg_path(app_data_dir);
    if !ffmpeg.is_file() {
        download_verified_tool(
            PinnedTool {
                url: FFMPEG_DOWNLOAD_URL,
                sha256: FFMPEG_SHA256,
                max_bytes: FFMPEG_MAX_BYTES,
                destination: &ffmpeg,
                title: "Installing the audio processor",
            },
            source,
            cancel,
            report_progress,
        )
        .await?;
    }
    Ok(ffmpeg)
}

async fn download_verified_tool<F>(
    tool: PinnedTool<'_>,
    source: DownloadSource,
    cancel: &AtomicBool,
    report_progress: &mut F,
) -> Result<()>
where
    F: FnMut(DownloadProgress),
{
    let partial = tool.destination.with_extension("exe.download");
    let _ = tokio::fs::remove_file(&partial).await;
    let client = reqwest::Client::builder()
        .user_agent(concat!("Loavy-Player/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .build()
        .context("Could not prepare the Spotify tool installer.")?;
    let request = client.get(tool.url).send();
    tokio::pin!(request);
    let mut response = loop {
        tokio::select! {
            response = &mut request => {
                break response.with_context(|| format!("Could not download {}.", tool.title))?;
            }
            _ = tokio::time::sleep(Duration::from_millis(150)) => {
                if cancel.load(Ordering::SeqCst) {
                    bail!("Download cancelled.");
                }
            }
        }
    }
    .error_for_status()
    .with_context(|| format!("The {} download was rejected.", tool.title))?;
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size > tool.max_bytes) {
        bail!("The {} download was unexpectedly large.", tool.title);
    }

    let mut file = tokio::fs::File::create(&partial)
        .await
        .with_context(|| format!("Could not create the file for {}.", tool.title))?;
    let mut hasher = Sha256::new();
    let mut bytes_written = 0_u64;

    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk.with_context(|| format!("The {} download was interrupted.", tool.title))?,
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
        if bytes_written > tool.max_bytes {
            drop(file);
            let _ = tokio::fs::remove_file(&partial).await;
            bail!("The {} download exceeded the allowed size.", tool.title);
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .with_context(|| format!("Could not write {}.", tool.title))?;
        report_progress(DownloadProgress {
            phase: "installing".to_string(),
            percent: total_bytes.map(|total| bytes_written as f64 / total as f64 * 100.0),
            bytes_written,
            total_bytes,
            title: tool.title.to_string(),
            item_index: None,
            item_count: None,
            source,
        });
    }

    file.flush()
        .await
        .with_context(|| format!("Could not finish writing {}.", tool.title))?;
    drop(file);

    let actual_sha256 = format!("{:x}", hasher.finalize());
    if !actual_sha256.eq_ignore_ascii_case(tool.sha256) {
        let _ = tokio::fs::remove_file(&partial).await;
        bail!(
            "The {} checksum did not match the pinned release.",
            tool.title
        );
    }
    validate_windows_executable(&partial, tool.title).await?;
    tokio::fs::rename(&partial, tool.destination)
        .await
        .with_context(|| format!("Could not finish installing {}.", tool.title))?;
    Ok(())
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
        let _ = tokio::fs::remove_file(path).await;
        bail!("The {title} download was not a valid Windows executable.");
    }
    Ok(())
}

async fn tool_version(executable: &Path, app_data_dir: &Path) -> Option<String> {
    if !executable.is_file() {
        return None;
    }
    let mut command = Command::new(executable);
    configure_spotdl_command(&mut command, app_data_dir);
    hide_console_window(&mut command);
    tokio::time::timeout(Duration::from_secs(12), command.arg("--version").output())
        .await
        .ok()
        .and_then(std::result::Result::ok)
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .filter(|version| !version.is_empty())
}

fn configure_spotdl_command(command: &mut Command, app_data_dir: &Path) {
    let home = spotdl_home(app_data_dir);
    command
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("NO_COLOR", "1")
        .env("PYTHONUTF8", "1");
}

async fn forward_lines<R>(reader: R, sender: mpsc::UnboundedSender<String>)
where
    R: AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if sender.send(line).is_err() {
            break;
        }
    }
}

fn parse_spotdl_progress(
    raw_line: &str,
    state: &mut SpotdlProgressState,
) -> Option<DownloadProgress> {
    let line = strip_ansi(raw_line);
    let marker_index = line.find(LOG_MARKER)?;
    let payload = &line[marker_index + LOG_MARKER.len()..];
    let mut fields = payload.splitn(2, '|');
    let _level = fields.next()?;
    let message = fields.next()?.trim();

    if let Some(rest) = message.strip_prefix("Found ") {
        if let Some(count) = rest
            .split_whitespace()
            .next()
            .and_then(|value| value.parse().ok())
        {
            state.total = Some(count);
            return Some(progress_event(
                "resolving",
                None,
                format!("Found {count} Spotify tracks"),
                None,
                state.total,
            ));
        }
    }

    if let Some((fraction, _)) = message.split_once(" complete") {
        if let Some((completed, total)) = fraction.rsplit_once('/') {
            if let (Ok(completed), Ok(total)) =
                (completed.trim().parse::<u64>(), total.trim().parse::<u64>())
            {
                state.completed = completed;
                state.total = Some(total);
                let percent = (total > 0).then_some(completed as f64 / total as f64 * 100.0);
                return Some(progress_event(
                    "downloading",
                    percent,
                    format!("Completed {completed} of {total} tracks"),
                    Some(completed),
                    Some(total),
                ));
            }
        }
    }

    if message.starts_with("Processing query:") {
        return Some(progress_event(
            "resolving",
            None,
            "Reading Spotify metadata".to_string(),
            None,
            state.total,
        ));
    }

    let (title, status) = message.rsplit_once(": ")?;
    let (phase, item_percent) = match status.trim() {
        "Downloading" => ("downloading", 35.0),
        "Converting" => ("converting", 70.0),
        "Embedding metadata" => ("tagging", 95.0),
        "Done" | "Skipped" => ("tagging", 100.0),
        "Error" => ("downloading", 100.0),
        _ => return None,
    };
    let percent = state.total.and_then(|total| {
        (total > 0).then_some(
            ((state.completed as f64 * 100.0) + item_percent) / (total as f64 * 100.0) * 100.0,
        )
    });

    Some(progress_event(
        phase,
        percent,
        title.trim().to_string(),
        Some(state.completed.saturating_add(1)),
        state.total,
    ))
}

fn progress_event(
    phase: &str,
    percent: Option<f64>,
    title: String,
    item_index: Option<u64>,
    item_count: Option<u64>,
) -> DownloadProgress {
    DownloadProgress {
        phase: phase.to_string(),
        percent,
        bytes_written: 0,
        total_bytes: None,
        title,
        item_index,
        item_count,
        source: DownloadSource::Spotify,
    }
}

fn remember_line(lines: &mut VecDeque<String>, line: &str) {
    if lines.len() == 24 {
        lines.pop_front();
    }
    lines.push_back(strip_ansi(line));
}

async fn read_manifest_paths(manifest: &Path, destination: &Path) -> Result<Vec<PathBuf>> {
    let content = match tokio::fs::read_to_string(manifest).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("Could not read the completed download list."),
    };

    let canonical_destination = tokio::fs::canonicalize(destination)
        .await
        .context("Could not validate the download destination.")?;
    let mut paths = Vec::new();
    for line in content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        let path = PathBuf::from(line);
        let absolute = if path.is_absolute() {
            path
        } else {
            destination.join(path)
        };
        if tokio::fs::canonicalize(&absolute)
            .await
            .is_ok_and(|canonical| canonical.starts_with(&canonical_destination))
        {
            paths.push(absolute);
        }
    }
    Ok(paths)
}

fn parse_error_file(content: &str) -> Vec<String> {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            !(line.len() == 19
                && line
                    .chars()
                    .all(|character| character.is_ascii_digit() || character == '-'))
        })
        .take(20)
        .map(ToOwned::to_owned)
        .collect()
}

async fn cleanup_run_files(manifest: &Path, errors: &Path) {
    let _ = tokio::fs::remove_file(manifest).await;
    let _ = tokio::fs::remove_file(errors).await;
}

fn spotdl_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("tools").join("spotdl")
}

fn spotdl_path(app_data_dir: &Path) -> PathBuf {
    spotdl_root(app_data_dir).join("spotdl.exe")
}

fn ffmpeg_path(app_data_dir: &Path) -> PathBuf {
    spotdl_root(app_data_dir).join("ffmpeg.exe")
}

pub(super) fn audio_processor_installed(app_data_dir: &Path) -> bool {
    ffmpeg_path(app_data_dir).is_file()
}

fn spotdl_home(app_data_dir: &Path) -> PathBuf {
    spotdl_root(app_data_dir).join("home")
}

#[cfg(test)]
mod tests {
    use super::{parse_error_file, parse_spotdl_progress, SpotdlProgressState};

    #[test]
    fn parses_collection_and_track_progress() {
        let mut state = SpotdlProgressState::default();
        let found = parse_spotdl_progress(
            "12:00 INFO LOAVY|INFO|Found 12 songs in Example (Playlist)",
            &mut state,
        )
        .unwrap();
        assert_eq!(found.item_count, Some(12));

        let track = parse_spotdl_progress(
            "12:00 INFO LOAVY|INFO|Artist - Song: Downloading",
            &mut state,
        )
        .unwrap();
        assert_eq!(track.title, "Artist - Song");
        assert_eq!(track.item_index, Some(1));
        assert_eq!(track.phase, "downloading");

        let complete =
            parse_spotdl_progress("12:00 INFO LOAVY|INFO|1/12 complete", &mut state).unwrap();
        assert!((complete.percent.unwrap() - (100.0 / 12.0)).abs() < 1e-10);
        assert_eq!(complete.item_index, Some(1));
    }

    #[test]
    fn removes_timestamp_lines_from_spotdl_errors() {
        let errors = parse_error_file(
            "2026-07-11-12-30-00\nLookupError: first track\nLookupError: second track\n",
        );
        assert_eq!(errors.len(), 2);
    }
}
