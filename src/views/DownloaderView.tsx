import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  Download,
  FolderOpen,
  Link2,
  ListMusic,
  LoaderCircle,
  Music2,
  RotateCcw,
  Square,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type {
  DownloadMode,
  DownloadProgress,
  DownloadResult,
  DownloaderStatus,
  MediaDownloadRequest
} from "../types";

type Props = {
  onDownloadMedia: (request: MediaDownloadRequest) => Promise<DownloadResult>;
  onGetStatus: () => Promise<DownloaderStatus>;
  onCancel: () => Promise<void>;
  onSelectFolder: () => Promise<string | null>;
  onRevealDownload: (path: string) => Promise<void>;
};

export function DownloaderView({
  onDownloadMedia,
  onGetStatus,
  onCancel,
  onSelectFolder,
  onRevealDownload
}: Props) {
  const [mode, setMode] = useState<DownloadMode>("single");
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [status, setStatus] = useState<DownloaderStatus | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    void onGetStatus().then((nextStatus) => {
      setStatus(nextStatus);
      setDownloading(nextStatus.running);
    });
    const unlisten = listen<DownloadProgress>("download://progress", (event) => {
      setProgress(event.payload);
      setDownloading(true);
    });
    return () => {
      void unlisten.then((removeListener) => removeListener());
    };
  }, [onGetStatus]);

  const percent = useMemo(() => {
    if (progress?.percent !== null && progress?.percent !== undefined) {
      return Math.min(100, Math.max(0, Math.round(progress.percent)));
    }
    if (!progress?.totalBytes) return null;
    return Math.min(100, Math.round((progress.bytesWritten / progress.totalBytes) * 100));
  }, [progress]);

  async function handleDownload(event: FormEvent) {
    event.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError(`Enter a ${mode === "playlist" ? "playlist" : "song"} URL.`);
      return;
    }

    setDownloading(true);
    setCancelling(false);
    setProgress(null);
    setResult(null);
    setError(null);
    try {
      const nextResult = await onDownloadMedia({
        url: trimmedUrl,
        destinationDir: destination.trim() || null,
        mode
      });
      setResult(nextResult);
      setStatus(await onGetStatus());
      setProgress(null);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
      setProgress(null);
    } finally {
      setDownloading(false);
      setCancelling(false);
    }
  }

  async function chooseFolder() {
    const folder = await onSelectFolder();
    if (folder) setDestination(folder);
  }

  async function cancelDownload() {
    setCancelling(true);
    await onCancel();
  }

  function reset() {
    setUrl("");
    setResult(null);
    setError(null);
    setProgress(null);
  }

  const itemLabel = progress?.itemIndex
    ? `Track ${progress.itemIndex}${progress.itemCount ? ` of ${progress.itemCount}` : ""}`
    : progress?.phase === "installing"
      ? "One-time setup"
      : mode === "playlist"
        ? "Preparing playlist"
        : "Preparing song";

  return (
    <section className="downloaderView">
      <div className="downloaderIntro">
        <div className="downloaderMark"><Music2 size={26} /></div>
        <div>
          <span>Powered by yt-dlp</span>
          <h2>Save a song or a whole playlist.</h2>
          <p>Loavy downloads the best available audio and prefers M4A for library compatibility.</p>
        </div>
        <div className="downloaderStatus">
          <Wrench size={14} />
          {status?.installed ? `yt-dlp ${status.version || "ready"}` : "Installs on first download"}
        </div>
      </div>

      <form className="downloadSurface" onSubmit={handleDownload}>
        <div className="downloadMode" aria-label="Download type">
          <button
            type="button"
            className={mode === "single" ? "active" : ""}
            onClick={() => setMode("single")}
            disabled={downloading}
          >
            <Music2 size={17} /> Single song
          </button>
          <button
            type="button"
            className={mode === "playlist" ? "active" : ""}
            onClick={() => setMode("playlist")}
            disabled={downloading}
          >
            <ListMusic size={17} /> Playlist
          </button>
        </div>

        <label className="downloadField">
          <span><Link2 size={15} /> {mode === "playlist" ? "Playlist URL" : "Song URL"}</span>
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={mode === "playlist" ? "https://www.youtube.com/playlist?list=..." : "https://www.youtube.com/watch?v=..."}
            disabled={downloading}
          />
        </label>

        <label className="downloadField">
          <span><FolderOpen size={15} /> Save to</span>
          <div className="pathPicker">
            <input
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder="Downloads/Loavy Player"
              disabled={downloading}
            />
            <button type="button" className="iconButton borderedIconButton" onClick={chooseFolder} disabled={downloading} title="Choose folder">
              <FolderOpen size={18} />
            </button>
          </div>
        </label>

        {downloading && (
          <div className="downloadProgress" aria-live="polite">
            <div className={percent === null ? "progressTrack indeterminate" : "progressTrack"}>
              <span style={percent === null ? undefined : { width: `${percent}%` }} />
            </div>
            <div className="downloadProgressMeta">
              <div>
                <span>{itemLabel}</span>
                <strong>{progress?.title || "Starting yt-dlp..."}</strong>
              </div>
              <span>
                {progress?.bytesWritten ? formatBytes(progress.bytesWritten) : ""}
                {progress?.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : ""}
                {percent !== null ? ` (${percent}%)` : ""}
              </span>
            </div>
          </div>
        )}

        {error && <div className="downloadNotice error" role="alert">{error}</div>}

        {result && (
          <div className="downloadResult" aria-live="polite">
            <div className="downloadResultHeader">
              <CheckCircle2 size={20} />
              <div>
                <strong>{result.downloadedCount} {result.downloadedCount === 1 ? "song" : "songs"} ready</strong>
                <span>{result.destination}</span>
              </div>
              <button
                type="button"
                className="secondaryAction"
                onClick={() => void onRevealDownload(result.files[0] || result.destination)}
              >
                <FolderOpen size={16} /> Show files
              </button>
            </div>
            {result.files.length > 0 && (
              <div className="downloadedFiles">
                {result.files.slice(0, 5).map((file) => <span key={file}>{fileName(file)}</span>)}
                {result.files.length > 5 && <span>+ {result.files.length - 5} more</span>}
              </div>
            )}
          </div>
        )}

        <div className="downloadActions">
          <button className="primaryAction" type="submit" disabled={downloading || !url.trim()}>
            {downloading ? <LoaderCircle size={18} className="spin" /> : <Download size={18} />}
            {downloading ? "Downloading" : mode === "playlist" ? "Download playlist" : "Download song"}
          </button>
          {downloading && (
            <button className="secondaryAction dangerAction" type="button" onClick={() => void cancelDownload()} disabled={cancelling}>
              <Square size={15} /> {cancelling ? "Stopping" : "Cancel"}
            </button>
          )}
          {!downloading && (result || error) && (
            <button className="secondaryAction" type="button" onClick={reset}>
              <RotateCcw size={16} /> New download
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}
