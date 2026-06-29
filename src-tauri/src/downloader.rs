use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

const YT_DLP_DOWNLOAD_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const PROGRESS_PREFIX: &str = "LOAVY_PROGRESS|";
const FILE_PREFIX: &str = "LOAVY_FILE|";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadMode {
    Single,
    Playlist,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDownloadRequest {
    pub url: String,
    pub destination_dir: Option<String>,
    pub mode: DownloadMode,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub url: String,
    pub destination: String,
    pub files: Vec<String>,
    pub downloaded_count: usize,
    pub mode: DownloadMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloaderStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub running: bool,
}

pub async fn downloader_status(app_data_dir: &Path, running: bool) -> DownloaderStatus {
    let executable = yt_dlp_path(app_data_dir);
    let version = if executable.is_file() {
        let mut command = Command::new(&executable);
        hide_console_window(&mut command);
        command
            .arg("--version")
            .output()
            .await
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|version| version.trim().to_string())
            .filter(|version| !version.is_empty())
    } else {
        None
    };

    DownloaderStatus {
        installed: executable.is_file(),
        version,
        running,
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
    let parsed = reqwest::Url::parse(request.url.trim()).context("Invalid media URL.")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        bail!("Only HTTP and HTTPS media URLs are supported.");
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

    let executable = ensure_yt_dlp(app_data_dir, &cancel, &mut report_progress).await?;
    if cancel.load(Ordering::SeqCst) {
        bail!("Download cancelled.");
    }

    report_progress(DownloadProgress {
        phase: "starting".to_string(),
        percent: None,
        bytes_written: 0,
        total_bytes: None,
        title: match request.mode {
            DownloadMode::Single => "Reading song information".to_string(),
            DownloadMode::Playlist => "Reading playlist information".to_string(),
        },
        item_index: None,
        item_count: None,
    });

    let mut command = Command::new(&executable);
    hide_console_window(&mut command);
    command
        .current_dir(&destination)
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
            "bestaudio[ext=m4a]/bestaudio/best",
            "--progress-template",
            "download:LOAVY_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress._percent_str)s|%(info.playlist_index)s|%(info.n_entries)s|%(info.title)s",
            "--print",
            "after_move:LOAVY_FILE|%(filepath)s",
        ]);

    if node_is_available() {
        command.args(["--js-runtimes", "node"]);
    }

    match request.mode {
        DownloadMode::Single => {
            command
                .arg("--no-playlist")
                .args(["--output", "%(title)s [%(id)s].%(ext)s"]);
        }
        DownloadMode::Playlist => {
            command.args(["--yes-playlist", "--ignore-errors"]).args([
                "--output",
                "%(playlist_title)s/%(playlist_index)03d - %(title)s [%(id)s].%(ext)s",
            ]);
        }
    }
    command.arg(parsed.as_str());

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

    let mut files = Vec::new();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stderr_task.await;
            bail!("Download cancelled.");
        }

        tokio::select! {
            line = stdout_lines.next_line() => {
                match line.context("Could not read yt-dlp progress.")? {
                    Some(line) => {
                        if let Some(progress) = parse_progress_line(&line) {
                            report_progress(progress);
                        } else if let Some(path) = line.strip_prefix(FILE_PREFIX) {
                            let path = PathBuf::from(path.trim());
                            let absolute = if path.is_absolute() {
                                path
                            } else {
                                destination.join(path)
                            };
                            files.push(absolute.to_string_lossy().to_string());
                        }
                    }
                    None => break,
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        }
    }

    let status = child.wait().await.context("Could not finish yt-dlp.")?;
    let stderr_output = stderr_task.await.unwrap_or_default();
    if !status.success() {
        bail!("{}", useful_error(&stderr_output));
    }

    files.sort();
    files.dedup();
    Ok(DownloadResult {
        url: parsed.to_string(),
        destination: destination.to_string_lossy().to_string(),
        downloaded_count: files.len(),
        files,
        mode: request.mode,
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
    if executable.is_file() {
        return Ok(executable);
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
        .user_agent("Loavy-Player/4.1.2")
        .build()
        .context("Could not prepare the yt-dlp installer.")?;
    let mut response = client
        .get(YT_DLP_DOWNLOAD_URL)
        .send()
        .await
        .context("Could not download yt-dlp.")?
        .error_for_status()
        .context("The yt-dlp download was rejected.")?;
    let total_bytes = response.content_length();
    let mut file = tokio::fs::File::create(&partial)
        .await
        .context("Could not create the yt-dlp executable.")?;
    let mut bytes_written = 0_u64;

    while let Some(chunk) = response
        .chunk()
        .await
        .context("The yt-dlp download was interrupted.")?
    {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = tokio::fs::remove_file(&partial).await;
            bail!("Download cancelled.");
        }
        file.write_all(&chunk)
            .await
            .context("Could not write the yt-dlp executable.")?;
        bytes_written += chunk.len() as u64;
        report_progress(DownloadProgress {
            phase: "installing".to_string(),
            percent: total_bytes.map(|total| bytes_written as f64 / total as f64 * 100.0),
            bytes_written,
            total_bytes,
            title: "Installing yt-dlp".to_string(),
            item_index: None,
            item_count: None,
        });
    }

    file.flush()
        .await
        .context("Could not finish installing yt-dlp.")?;
    drop(file);
    tokio::fs::rename(&partial, &executable)
        .await
        .context("Could not finish installing yt-dlp.")?;
    Ok(executable)
}

fn yt_dlp_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("tools").join("yt-dlp.exe")
}

fn node_is_available() -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .any(|path| path.join("node.exe").is_file() || path.join("node").is_file())
        })
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn hide_console_window(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console_window(_command: &mut Command) {}

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

fn useful_error(stderr: &str) -> String {
    let lines = stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    let message = lines
        .iter()
        .rev()
        .take(4)
        .rev()
        .copied()
        .collect::<Vec<_>>()
        .join("\n");

    if message.is_empty() {
        "yt-dlp could not download this URL.".to_string()
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_progress_line, useful_error};

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
    fn keeps_the_useful_end_of_errors() {
        let error = useful_error("one\ntwo\nthree\nfour\nfive\n");
        assert_eq!(error, "two\nthree\nfour\nfive");
    }
}
