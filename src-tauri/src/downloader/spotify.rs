use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::mpsc,
};

use super::{
    atomic_replace, download_verified_asset, file_sha256, hide_console_window, read_bounded,
    strip_ansi, terminate_child, useful_error, DownloadOptions, DownloadProgress, DownloadResult,
    DownloadSource, PinnedAsset, ProcessFailure, ToolHealth,
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
const MAX_ERROR_FILE_BYTES: usize = 64 * 1024;
const MAX_PROCESS_LINE_BYTES: usize = 4 * 1024;
const PROCESS_LINE_QUEUE_CAPACITY: usize = 64;

const LOG_MARKER: &str = "LOAVY|";

pub(super) struct SpotifyToolStatus {
    pub spotdl: ToolHealth,
    pub ffmpeg: ToolHealth,
}

#[derive(Default)]
struct SpotdlProgressState {
    total: Option<u64>,
    completed: u64,
}

pub(super) async fn status(app_data_dir: &Path) -> SpotifyToolStatus {
    let (spotdl, ffmpeg) = tokio::join!(spotdl_health(app_data_dir), ffmpeg_health(app_data_dir));
    SpotifyToolStatus { spotdl, ffmpeg }
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
    let js_runtime =
        super::direct::ensure_js_runtime(app_data_dir, cancel, report_progress, true).await?;
    if cancel.load(Ordering::SeqCst) {
        bail!("Download cancelled.");
    }

    report_progress(DownloadProgress {
        phase: "reading".to_string(),
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

    command
        .arg("--yt-dlp-args")
        .arg(spotdl_runtime_args(&js_runtime));

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
    let (line_tx, mut line_rx) = mpsc::channel(PROCESS_LINE_QUEUE_CAPACITY);
    let stdout_task = tokio::spawn(forward_lines(stdout, line_tx.clone()));
    let stderr_task = tokio::spawn(forward_lines(stderr, line_tx));

    let mut progress_state = SpotdlProgressState::default();
    let mut recent_output = VecDeque::with_capacity(24);
    let mut output_closed = false;
    let exit_status = loop {
        if cancel.load(Ordering::SeqCst) {
            terminate_child(&mut child).await;
            line_rx.close();
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
            line = line_rx.recv(), if !output_closed => {
                if let Some(line) = line {
                    remember_line(&mut recent_output, &line);
                    if let Some(progress) = parse_spotdl_progress(&line, &mut progress_state) {
                        report_progress(progress);
                    }
                } else {
                    output_closed = true;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(120)) => {}
        }
    };

    while let Some(line) = line_rx.recv().await {
        remember_line(&mut recent_output, &line);
        if let Some(progress) = parse_spotdl_progress(&line, &mut progress_state) {
            report_progress(progress);
        }
    }
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let error_file = match tokio::fs::File::open(&errors_path).await {
        Ok(file) => read_bounded(file, MAX_ERROR_FILE_BYTES).await,
        Err(_) => String::new(),
    };
    let mut warnings = parse_error_file(&error_file);
    let manifest_result = read_manifest_paths(&manifest_path, destination).await;
    cleanup_run_files(&manifest_path, &errors_path).await;
    let mut files = manifest_result?;
    files.retain(|path| path.is_file());
    files.sort();
    files.dedup();

    if !exit_status.success() {
        let output = recent_output.into_iter().collect::<Vec<_>>().join("\n");
        let combined = if error_file.trim().is_empty() {
            output
        } else {
            format!("{output}\n{error_file}")
        };
        let summary = useful_error(
            &combined,
            "The Spotify downloader could not finish this link.",
        );
        if files.is_empty() {
            return Err(ProcessFailure {
                summary,
                exit_code: exit_status.code(),
                stderr: combined,
            }
            .into());
        }
        // A collection may have saved usable tracks before a later item failed.
        if warnings.is_empty() {
            warnings.push(summary);
        }
    }

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

fn spotdl_runtime_args(runtime: &super::direct::JsRuntime) -> String {
    // spotDL parses this one argument again with Python's POSIX shlex.split.
    // Single-quote the value to preserve Windows backslashes and spaces, and
    // escape embedded apostrophes using adjacent quoted/unquoted segments.
    let value = runtime.yt_dlp_argument().replace('\'', "'\"'\"'");
    format!("--js-runtimes '{value}'")
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
    if !spotdl_is_trusted(&spotdl, app_data_dir).await {
        let partial = spotdl.with_extension("exe.download");
        download_verified_asset(
            PinnedAsset {
                url: SPOTDL_DOWNLOAD_URL,
                sha256: SPOTDL_SHA256,
                max_bytes: SPOTDL_MAX_BYTES,
                partial: &partial,
                title: "Preparing Spotify support",
                source: DownloadSource::Spotify,
            },
            cancel,
            report_progress,
        )
        .await?;
        let install_result: Result<()> = async {
            validate_windows_executable(&partial, "Spotify support").await?;
            let version = tool_version(&partial, app_data_dir)
                .await
                .context("The downloaded spotDL executable did not start correctly.")?;
            if version != SPOTDL_VERSION {
                bail!("The Spotify downloader version could not be verified.");
            }
            atomic_replace(&partial, &spotdl)
                .await
                .context("Could not atomically install Spotify support.")?;
            Ok(())
        }
        .await;
        if install_result.is_err() {
            let _ = tokio::fs::remove_file(&partial).await;
        }
        install_result?;
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
    if !ffmpeg_is_trusted(&ffmpeg).await {
        let partial = ffmpeg.with_extension("exe.download");
        download_verified_asset(
            PinnedAsset {
                url: FFMPEG_DOWNLOAD_URL,
                sha256: FFMPEG_SHA256,
                max_bytes: FFMPEG_MAX_BYTES,
                partial: &partial,
                title: "Preparing the audio processor",
                source,
            },
            cancel,
            report_progress,
        )
        .await?;
        let install_result: Result<()> = async {
            validate_windows_executable(&partial, "audio processor").await?;
            ffmpeg_version(&partial)
                .await
                .context("The downloaded audio processor did not start correctly.")?;
            atomic_replace(&partial, &ffmpeg)
                .await
                .context("Could not atomically install the audio processor.")?;
            Ok(())
        }
        .await;
        if install_result.is_err() {
            let _ = tokio::fs::remove_file(&partial).await;
        }
        install_result?;
    }
    Ok(ffmpeg)
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

async fn spotdl_is_trusted(executable: &Path, app_data_dir: &Path) -> bool {
    file_sha256(executable)
        .await
        .is_ok_and(|hash| hash.eq_ignore_ascii_case(SPOTDL_SHA256))
        && tool_version(executable, app_data_dir).await.as_deref() == Some(SPOTDL_VERSION)
}

async fn ffmpeg_is_trusted(executable: &Path) -> bool {
    file_sha256(executable)
        .await
        .is_ok_and(|hash| hash.eq_ignore_ascii_case(FFMPEG_SHA256))
        && ffmpeg_version(executable).await.is_some()
}

async fn spotdl_health(app_data_dir: &Path) -> ToolHealth {
    let executable = spotdl_path(app_data_dir);
    if !executable.is_file() {
        return ToolHealth::missing(Some(SPOTDL_VERSION));
    }
    if !file_sha256(&executable)
        .await
        .is_ok_and(|hash| hash.eq_ignore_ascii_case(SPOTDL_SHA256))
    {
        return ToolHealth::corrupt(
            None,
            Some(SPOTDL_VERSION),
            "The spotDL executable failed its checksum verification.",
        );
    }
    let version = tool_version(&executable, app_data_dir).await;
    if version.as_deref() == Some(SPOTDL_VERSION) {
        ToolHealth::ready(version, Some(SPOTDL_VERSION))
    } else {
        ToolHealth::corrupt(
            version,
            Some(SPOTDL_VERSION),
            "The spotDL executable failed its version verification.",
        )
    }
}

async fn ffmpeg_health(app_data_dir: &Path) -> ToolHealth {
    let executable = ffmpeg_path(app_data_dir);
    if !executable.is_file() {
        return ToolHealth::missing(Some("4.4"));
    }
    if !file_sha256(&executable)
        .await
        .is_ok_and(|hash| hash.eq_ignore_ascii_case(FFMPEG_SHA256))
    {
        return ToolHealth::corrupt(
            None,
            Some("4.4"),
            "The FFmpeg executable failed its checksum verification.",
        );
    }
    let version = ffmpeg_version(&executable).await;
    if version.is_some() {
        ToolHealth::ready(version, Some("4.4"))
    } else {
        ToolHealth::corrupt(
            version,
            Some("4.4"),
            "The FFmpeg executable failed its version verification.",
        )
    }
}

async fn ffmpeg_version(executable: &Path) -> Option<String> {
    if !executable.is_file() {
        return None;
    }
    let mut command = Command::new(executable);
    command.kill_on_drop(true).stdin(Stdio::null());
    hide_console_window(&mut command);
    tokio::time::timeout(Duration::from_secs(8), command.arg("-version").output())
        .await
        .ok()
        .and_then(std::result::Result::ok)
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|output| {
            output
                .lines()
                .next()
                .and_then(|line| line.strip_prefix("ffmpeg version "))
                .and_then(|version| version.split_whitespace().next())
                .map(str::to_string)
        })
}

pub(super) async fn repair_tools<F>(
    app_data_dir: &Path,
    cancel: &AtomicBool,
    report_progress: &mut F,
) -> Result<()>
where
    F: FnMut(DownloadProgress),
{
    ensure_tools(app_data_dir, cancel, report_progress).await?;
    Ok(())
}

async fn tool_version(executable: &Path, app_data_dir: &Path) -> Option<String> {
    if !executable.is_file() {
        return None;
    }
    let mut command = Command::new(executable);
    command.kill_on_drop(true).stdin(Stdio::null());
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

async fn forward_lines<R>(mut reader: R, sender: mpsc::Sender<String>)
where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0_u8; 4 * 1024];
    let mut pending = Vec::with_capacity(MAX_PROCESS_LINE_BYTES);
    let mut truncated = false;
    loop {
        let Ok(read) = reader.read(&mut chunk).await else {
            break;
        };
        if read == 0 {
            break;
        }
        for byte in &chunk[..read] {
            if *byte == b'\n' {
                let mut line = String::from_utf8_lossy(&pending).into_owned();
                if truncated {
                    line.push_str("...");
                }
                if sender.send(line).await.is_err() {
                    return;
                }
                pending.clear();
                truncated = false;
            } else if pending.len() < MAX_PROCESS_LINE_BYTES {
                pending.push(*byte);
            } else {
                truncated = true;
            }
        }
    }
    if !pending.is_empty() || truncated {
        let mut line = String::from_utf8_lossy(&pending).into_owned();
        if truncated {
            line.push_str("...");
        }
        let _ = sender.send(line).await;
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
                "reading",
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
            "reading",
            None,
            "Reading Spotify metadata".to_string(),
            None,
            state.total,
        ));
    }

    let (title, status) = message.rsplit_once(": ")?;
    let (phase, item_percent) = match status.trim() {
        "Downloading" => ("downloading", Some(35.0)),
        "Converting" => ("processing", None),
        "Embedding metadata" => ("embedding", None),
        "Done" | "Skipped" => ("saving", None),
        "Error" => ("downloading", Some(100.0)),
        _ => return None,
    };
    let percent = item_percent.and_then(|item_percent| {
        state.total.and_then(|total| {
            (total > 0).then_some(
                ((state.completed as f64 * 100.0) + item_percent) / (total as f64 * 100.0) * 100.0,
            )
        })
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
    let line = strip_ansi(line);
    let line = if line.len() > 4096 {
        let mut start = line.len() - 4096;
        while !line.is_char_boundary(start) {
            start += 1;
        }
        format!("...{}", &line[start..])
    } else {
        line
    };
    lines.push_back(line);
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
        .trim_start_matches('\u{feff}')
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

fn spotdl_home(app_data_dir: &Path) -> PathBuf {
    spotdl_root(app_data_dir).join("home")
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::{
        forward_lines, parse_error_file, parse_spotdl_progress, read_manifest_paths, remember_line,
        spotdl_runtime_args, SpotdlProgressState, MAX_PROCESS_LINE_BYTES,
    };
    use tokio::io::AsyncWriteExt;

    #[test]
    fn quotes_windows_runtime_paths_for_spotdl_shlex() {
        let runtime = crate::downloader::direct::JsRuntime {
            name: "node",
            version: "22.0.0".into(),
            executable: std::path::PathBuf::from(r"C:\Program Files\O'Brien\node.exe"),
        };
        assert_eq!(
            spotdl_runtime_args(&runtime),
            r#"--js-runtimes 'node:C:\Program Files\O'"'"'Brien\node.exe'"#
        );
    }

    #[tokio::test]
    async fn manifest_keeps_completed_files_and_rejects_missing_or_outside_paths() {
        let root = std::env::temp_dir().join(format!(
            "loavy-manifest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let destination = root.join("My Music");
        tokio::fs::create_dir_all(&destination).await.unwrap();
        tokio::fs::write(destination.join("Song.m4a"), b"audio")
            .await
            .unwrap();
        tokio::fs::write(root.join("outside.m4a"), b"outside")
            .await
            .unwrap();
        let manifest = destination.join("result.m3u8");
        tokio::fs::write(
            &manifest,
            "\u{feff}Song.m4a\n#EXTINF:0,Missing\nMissing.m4a\n../outside.m4a\n",
        )
        .await
        .unwrap();
        let files = read_manifest_paths(&manifest, &destination).await.unwrap();
        assert_eq!(files, vec![destination.join("Song.m4a")]);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

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

        let converting = parse_spotdl_progress(
            "12:00 INFO LOAVY|INFO|Artist - Song: Converting",
            &mut state,
        )
        .unwrap();
        assert_eq!(converting.phase, "processing");
        assert_eq!(converting.percent, None);

        let embedding = parse_spotdl_progress(
            "12:00 INFO LOAVY|INFO|Artist - Song: Embedding metadata",
            &mut state,
        )
        .unwrap();
        assert_eq!(embedding.phase, "embedding");
        assert_eq!(embedding.percent, None);
    }

    #[test]
    fn removes_timestamp_lines_from_spotdl_errors() {
        let errors = parse_error_file(
            "2026-07-11-12-30-00\nLookupError: first track\nLookupError: second track\n",
        );
        assert_eq!(errors.len(), 2);
    }

    #[test]
    fn bounds_recent_process_output_by_lines_and_bytes() {
        let mut lines = VecDeque::new();
        for index in 0..30 {
            remember_line(&mut lines, &format!("line {index}"));
        }
        assert_eq!(lines.len(), 24);
        assert_eq!(lines.front().unwrap(), "line 6");

        remember_line(&mut lines, &"x".repeat(5_000));
        assert!(lines.back().unwrap().len() <= 4_099);
        assert!(lines.back().unwrap().starts_with("..."));
    }

    #[tokio::test]
    async fn bounds_a_single_process_output_line_before_queueing_it() {
        let (mut writer, reader) = tokio::io::duplex(8 * 1024);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        let forwarder = tokio::spawn(forward_lines(reader, sender));
        writer.write_all(&vec![b'x'; 6 * 1024]).await.unwrap();
        writer.write_all(b"\nshort\n").await.unwrap();
        drop(writer);

        let long = receiver.recv().await.unwrap();
        let short = receiver.recv().await.unwrap();
        assert_eq!(long.len(), MAX_PROCESS_LINE_BYTES + 3);
        assert!(long.ends_with("..."));
        assert_eq!(short, "short");
        forwarder.await.unwrap();
    }
}
