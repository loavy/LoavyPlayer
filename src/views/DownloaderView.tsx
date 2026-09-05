import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  ClipboardPaste,
  Disc3,
  Download,
  FolderOpen,
  Globe2,
  Info,
  Link2,
  ListMusic,
  LoaderCircle,
  Music2,
  RotateCcw,
  Square,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  DownloadFormat,
  DownloadFailure,
  DownloadMode,
  DownloadProgress,
  DownloadResult,
  DownloaderStatus,
  DownloaderToolHealth,
  DownloadSource,
  MediaDownloadRequest
} from "../types";

type DownloaderSection = "download" | "naming";
type TemplateField = "filename" | "folder";

type Props = {
  onDownloadMedia: (request: MediaDownloadRequest) => Promise<DownloadResult>;
  onGetStatus: () => Promise<DownloaderStatus>;
  onRepairTools: () => Promise<DownloaderStatus>;
  onCancel: () => Promise<void>;
  onSelectFolder: () => Promise<string | null>;
  onRevealDownload: (path: string) => Promise<void>;
};

const spotifyModes: Array<{ value: DownloadMode; label: string }> = [
  { value: "single", label: "Track" },
  { value: "album", label: "Album" },
  { value: "playlist", label: "Playlist" }
];

const webModes: Array<{ value: DownloadMode; label: string }> = [
  { value: "single", label: "Single song" },
  { value: "playlist", label: "Playlist" }
];

const DEFAULT_FILENAME_TEMPLATE = "{artist} - {title}";
const DEFAULT_FOLDER_TEMPLATE = "{album_artist}/{album}";
const FILENAME_TEMPLATE_STORAGE_KEY = "loavy.downloader.filenameTemplate";
const FOLDER_TEMPLATE_STORAGE_KEY = "loavy.downloader.folderTemplate";
const APPLY_FOLDER_TO_SINGLE_STORAGE_KEY = "loavy.downloader.applyFolderToSingle";
const DESTINATION_STORAGE_KEY = "loavy.downloader.destination";
const FORMAT_STORAGE_KEY = "loavy.downloader.format";
const AUDIO_FORMATS: Array<{ value: DownloadFormat; label: string; description: string }> = [
  { value: "m4a", label: "M4A", description: "Recommended" },
  { value: "mp3", label: "MP3", description: "Widely compatible" },
  { value: "opus", label: "Opus", description: "Smaller files" },
  { value: "flac", label: "FLAC", description: "Converted audio" }
];
const TEMPLATE_TOKENS = [
  "{title}",
  "{artist}",
  "{artists}",
  "{album}",
  "{album_artist}",
  "{track}",
  "{total_tracks}",
  "{disc}",
  "{total_discs}",
  "{year}",
  "{date}",
  "{isrc}",
  "{playlist}",
  "{position}"
] as const;

export function DownloaderView({
  onDownloadMedia,
  onGetStatus,
  onRepairTools,
  onCancel,
  onSelectFolder,
  onRevealDownload
}: Props) {
  const [section, setSection] = useState<DownloaderSection>("download");
  const [source, setSource] = useState<DownloadSource>("spotify");
  const [mode, setMode] = useState<DownloadMode>("single");
  const [format, setFormat] = useState<DownloadFormat>(() => {
    const stored = readStoredString(FORMAT_STORAGE_KEY, "m4a");
    return AUDIO_FORMATS.find((option) => option.value === stored)?.value ?? "m4a";
  });
  const [urls, setUrls] = useState<Record<DownloadSource, string>>({ spotify: "", web: "" });
  const [destination, setDestination] = useState(() => readStoredString(DESTINATION_STORAGE_KEY, ""));
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [status, setStatus] = useState<DownloaderStatus | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const [error, setError] = useState<DownloadFailure | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [filenameTemplate, setFilenameTemplate] = useState(() => readStoredString(
    FILENAME_TEMPLATE_STORAGE_KEY,
    DEFAULT_FILENAME_TEMPLATE
  ));
  const [folderTemplate, setFolderTemplate] = useState(() => readStoredString(
    FOLDER_TEMPLATE_STORAGE_KEY,
    DEFAULT_FOLDER_TEMPLATE
  ));
  const [applyFolderToSingle, setApplyFolderToSingle] = useState(() => readStoredBoolean(
    APPLY_FOLDER_TO_SINGLE_STORAGE_KEY,
    false
  ));
  const [activeTemplateField, setActiveTemplateField] = useState<TemplateField>("filename");
  const lifecycleRevision = useRef(0);
  const repairingRef = useRef(false);
  const operationRef = useRef(false);
  const downloadingRef = useRef(false);
  const lastRequestRef = useRef<MediaDownloadRequest | null>(null);
  const filenameTemplateRef = useRef<HTMLInputElement>(null);
  const folderTemplateRef = useRef<HTMLInputElement>(null);

  const url = urls[source];
  const detectedSpotifyMode = source === "spotify" ? spotifyModeFromUrl(url) : null;
  const availableModes = source === "spotify" ? spotifyModes : webModes;
  const busy = downloading || repairing;

  useEffect(() => {
    storeDownloaderSetting(DESTINATION_STORAGE_KEY, destination);
  }, [destination]);

  useEffect(() => {
    storeDownloaderSetting(FORMAT_STORAGE_KEY, format);
  }, [format]);

  useEffect(() => {
    storeDownloaderSetting(FILENAME_TEMPLATE_STORAGE_KEY, filenameTemplate);
  }, [filenameTemplate]);

  useEffect(() => {
    storeDownloaderSetting(FOLDER_TEMPLATE_STORAGE_KEY, folderTemplate);
  }, [folderTemplate]);

  useEffect(() => {
    storeDownloaderSetting(APPLY_FOLDER_TO_SINGLE_STORAGE_KEY, String(applyFolderToSingle));
  }, [applyFolderToSingle]);

  useEffect(() => {
    let disposed = false;
    const statusRevision = lifecycleRevision.current;
    void onGetStatus()
      .then((nextStatus) => {
        if (disposed) return;
        setStatus(nextStatus);
        if (lifecycleRevision.current === statusRevision) {
          downloadingRef.current = nextStatus.running;
          setDownloading(nextStatus.running);
        }
      })
      .catch(() => {
        // A status check should not prevent the user from attempting a download.
      });

    const unlistenProgress = listen<DownloadProgress>("download://progress", (event) => {
      if (disposed) return;
      lifecycleRevision.current += 1;
      setProgress(event.payload);
      if (!repairingRef.current) {
        downloadingRef.current = true;
        setDownloading(true);
      }
    });
    const unlistenCompleted = listen<DownloadResult>("download://completed", (event) => {
      // The invoke promise owns jobs started here. Handling its terminal event
      // as well would unlock the form before the promise has settled.
      if (disposed || operationRef.current) return;
      downloadingRef.current = false;
      lifecycleRevision.current += 1;
      setResult(event.payload);
      setSource(event.payload.source);
      setMode(event.payload.mode);
      setFormat(event.payload.format);
      setProgress(null);
      setError(null);
      setDownloading(false);
      setCancelling(false);
      void onGetStatus().then(setStatus).catch(() => undefined);
    });
    const unlistenFailed = listen<unknown>("download://failed", (event) => {
      if (disposed || operationRef.current) return;
      downloadingRef.current = false;
      lifecycleRevision.current += 1;
      setError(normalizeDownloadFailure(event.payload));
      setProgress(null);
      setDownloading(false);
      setCancelling(false);
      void onGetStatus().then(setStatus).catch(() => undefined);
    });
    // Observe rejections immediately, including in browser-only previews.
    const listeners = Promise.allSettled([unlistenProgress, unlistenCompleted, unlistenFailed]);
    return () => {
      disposed = true;
      void listeners.then((results) => results.forEach((entry) => {
        if (entry.status === "fulfilled") entry.value();
      }));
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
    if (section !== "download" || downloading || repairing) return;
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError(localFailure(source === "spotify" ? "Paste a Spotify track, album, or playlist URL." : `Enter a ${mode === "playlist" ? "playlist" : "media"} URL.`));
      return;
    }

    let requestMode = mode;
    if (source === "spotify") {
      const inferredMode = spotifyModeFromUrl(trimmedUrl);
      if (!inferredMode) {
        setError(localFailure("Use an https://open.spotify.com track, album, or playlist URL."));
        return;
      }
      requestMode = inferredMode;
      setMode(inferredMode);
    } else if (!isHttpUrl(trimmedUrl)) {
      setError(localFailure("Enter a valid http:// or https:// media URL."));
      return;
    }

    await runDownload({
      source,
      url: trimmedUrl,
      destinationDir: destination.trim() || null,
      mode: requestMode,
      format,
      filenameTemplate,
      folderTemplate,
      applyFolderToSingle
    });
  }

  async function runDownload(request: MediaDownloadRequest) {
    if (operationRef.current || downloadingRef.current) return;
    operationRef.current = true;
    downloadingRef.current = true;
    setSection("download");
    setSource(request.source);
    setMode(request.mode);
    setFormat(request.format);
    setUrls((current) => ({ ...current, [request.source]: request.url }));
    lastRequestRef.current = { ...request };
    lifecycleRevision.current += 1;
    setDownloading(true);
    setCancelling(false);
    setProgress(null);
    setResult(null);
    setError(null);
    try {
      const nextResult = await onDownloadMedia(request);
      setResult(nextResult);
      setProgress(null);
    } catch (downloadError) {
      setError(normalizeDownloadFailure(downloadError));
      setProgress(null);
    } finally {
      operationRef.current = false;
      downloadingRef.current = false;
      lifecycleRevision.current += 1;
      setDownloading(false);
      setCancelling(false);
      // Tool health is auxiliary; a failed refresh must not erase saved files.
      void onGetStatus().then(setStatus).catch(() => undefined);
    }
  }

  async function repairTools() {
    if (operationRef.current || downloadingRef.current) return;
    operationRef.current = true;
    lifecycleRevision.current += 1;
    repairingRef.current = true;
    setRepairing(true);
    setSection("download");
    setProgress(null);
    setResult(null);
    setError(null);
    try {
      setStatus(await onRepairTools());
    } catch (repairError) {
      setError(localFailure(`Could not repair the downloader tools: ${errorMessage(repairError)}`));
    } finally {
      operationRef.current = false;
      lifecycleRevision.current += 1;
      repairingRef.current = false;
      setRepairing(false);
      setCancelling(false);
      setProgress(null);
      void onGetStatus().then(setStatus).catch(() => undefined);
    }
  }

  async function chooseFolder() {
    try {
      const folder = await onSelectFolder();
      if (folder) setDestination(folder);
    } catch (folderError) {
      setError(localFailure(`Could not open the folder picker: ${errorMessage(folderError)}`));
    }
  }

  async function revealDownload(path: string) {
    try {
      await onRevealDownload(path);
    } catch (revealError) {
      setError(localFailure(`Could not show the saved files: ${errorMessage(revealError)}`));
    }
  }

  async function pasteUrl() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) changeUrl(text);
    } catch {
      setError(localFailure("Clipboard access is unavailable. Paste your link into the URL field."));
    }
  }

  async function cancelDownload() {
    setCancelling(true);
    try {
      await onCancel();
    } catch (cancelError) {
      setError(localFailure(errorMessage(cancelError)));
      setCancelling(false);
    }
  }

  function changeSource(nextSource: DownloadSource) {
    if (busy || source === nextSource) return;
    setSource(nextSource);
    if (nextSource === "spotify") {
      const storedMode = spotifyModeFromUrl(urls.spotify);
      if (storedMode) setMode(storedMode);
    } else if (mode === "album") {
      setMode("single");
    }
    setResult(null);
    setError(null);
    setProgress(null);
  }

  function changeUrl(nextUrl: string) {
    const inferredMode = spotifyModeFromUrl(nextUrl);
    const nextSource = inferredMode ? "spotify" : isHttpUrl(nextUrl) ? "web" : source;
    setSource(nextSource);
    setUrls((current) => ({ ...current, [nextSource]: nextUrl }));
    setError(null);
    setResult(null);
    lastRequestRef.current = null;
    if (inferredMode) setMode(inferredMode);
    else if (nextSource === "web" && mode === "album") setMode("single");
  }

  function reset() {
    lastRequestRef.current = null;
    setUrls((current) => ({ ...current, [source]: "" }));
    setResult(null);
    setError(null);
    setProgress(null);
  }

  function insertTemplateToken(token: string) {
    if (downloading) return;
    const input = activeTemplateField === "filename" ? filenameTemplateRef.current : folderTemplateRef.current;
    const currentValue = activeTemplateField === "filename" ? filenameTemplate : folderTemplate;
    const setValue = activeTemplateField === "filename" ? setFilenameTemplate : setFolderTemplate;
    const selectionStart = input?.selectionStart ?? currentValue.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const nextValue = `${currentValue.slice(0, selectionStart)}${token}${currentValue.slice(selectionEnd)}`;
    const nextCaretPosition = selectionStart + token.length;

    setValue(nextValue);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(nextCaretPosition, nextCaretPosition);
    });
  }

  function resetFilenameTemplate() {
    setFilenameTemplate(DEFAULT_FILENAME_TEMPLATE);
    setActiveTemplateField("filename");
    requestAnimationFrame(() => filenameTemplateRef.current?.focus());
  }

  function resetFolderTemplate() {
    setFolderTemplate(DEFAULT_FOLDER_TEMPLATE);
    setActiveTemplateField("folder");
    requestAnimationFrame(() => folderTemplateRef.current?.focus());
  }

  const progressSource = progress?.source ?? source;
  const itemLabel = repairing
    ? "Repairing managed tools"
    : progress?.itemIndex
    ? `Track ${progress.itemIndex}${progress.itemCount ? ` of ${progress.itemCount}` : ""}`
    : progress
      ? phaseLabel(progress.phase, progressSource)
      : source === "spotify"
        ? "Preparing Spotify match"
        : mode === "playlist"
          ? "Preparing playlist"
          : "Preparing song";
  const progressTitle = progress?.title || phaseFallback(progress?.phase, progressSource, format);
  const actionLabel = downloadActionLabel(source, detectedSpotifyMode ?? mode);
  const filenamePreview = `${renderTemplatePreview(filenameTemplate) || "Untitled"}.${format}`;
  const folderPreview = renderTemplatePreview(folderTemplate, true);
  const useFolder = folderPreview && !(source === "spotify" && mode === "playlist")
    && (mode !== "single" || applyFolderToSingle);
  const outputPreview = `${useFolder ? `${folderPreview}/` : ""}${filenamePreview}`;

  return (
    <section className="downloaderView" aria-labelledby="downloader-title">
      <div className="downloaderIntro">
        <div className="downloaderMark"><Download size={26} /></div>
        <div>
          <span>Your next listen</span>
          <h2 id="downloader-title">A link. A song. Yours to keep.</h2>
          <p>Download audio, choose your format, and give it a home in your collection.</p>
        </div>
      </div>
      <details className="downloaderTools">
        <summary><Wrench size={15} /> Download tools <span>Installed automatically when needed</span></summary>
        <div className="downloaderStatuses" aria-label="Downloader tool status">
          <ToolStatusPill label="yt-dlp" health={status?.ytDlp} />
          <ToolStatusPill label="FFmpeg" health={status?.ffmpeg} />
          <ToolStatusPill label={status?.jsRuntime.provider || "Deno"} health={status?.jsRuntime} />
          <ToolStatusPill label="spotDL" health={status?.spotdl} />
          <button
            type="button"
            className="downloaderRepairButton"
            onClick={() => void repairTools()}
            disabled={downloading || repairing}
          >
            {repairing ? <LoaderCircle size={14} className="spin" /> : <Wrench size={14} />}
            {repairing ? "Repairing tools" : "Repair tools"}
          </button>
        </div>
      </details>

      <form className="downloadSurface" onSubmit={handleDownload}>
        <div className="downloadSectionTabs" role="tablist" aria-label="Downloader settings">
          <button
            id="downloader-download-tab"
            type="button"
            role="tab"
            aria-selected={section === "download"}
            aria-controls="downloader-download-panel"
            className={section === "download" ? "active" : ""}
            onClick={() => setSection("download")}
          >
            <Download size={17} /> Download
          </button>
          <button
            id="downloader-naming-tab"
            type="button"
            role="tab"
            aria-selected={section === "naming"}
            aria-controls="downloader-naming-panel"
            className={section === "naming" ? "active" : ""}
            onClick={() => setSection("naming")}
            disabled={busy}
          >
            <ListMusic size={17} /> Naming
          </button>
        </div>

        <div
          id="downloader-download-panel"
          className="downloadSectionPanel downloadMainPanel"
          role="tabpanel"
          aria-labelledby="downloader-download-tab"
          hidden={section !== "download"}
        >
          <div className="downloadSourceTabs" role="tablist" aria-label="Download source">
          <button
            id="spotify-source-tab"
            type="button"
            role="tab"
            aria-selected={source === "spotify"}
            aria-controls="download-source-panel"
            className={source === "spotify" ? "active" : ""}
            onClick={() => changeSource("spotify")}
            disabled={busy}
          >
            <Disc3 size={23} /><span><strong>Spotify</strong><small>Tracks, albums & playlists</small></span>
            {source === "spotify" && <CheckCircle2 size={17} className="sourceSelected" />}
          </button>
          <button
            id="web-source-tab"
            type="button"
            role="tab"
            aria-selected={source === "web"}
            aria-controls="download-source-panel"
            className={source === "web" ? "active" : ""}
            onClick={() => changeSource("web")}
            disabled={busy}
          >
            <Globe2 size={23} /><span><strong>Direct link</strong><small>YouTube & supported sites</small></span>
            {source === "web" && <CheckCircle2 size={17} className="sourceSelected" />}
          </button>
        </div>

        <div
          id="download-source-panel"
          className="downloadSourcePanel"
          role="tabpanel"
          aria-labelledby={source === "spotify" ? "spotify-source-tab" : "web-source-tab"}
        >
          <div className={availableModes.length === 3 ? "downloadMode threeOptions" : "downloadMode"} aria-label="Download type">
            {availableModes.map((option) => {
              const urlLocksMode = source === "spotify" && detectedSpotifyMode !== null;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={mode === option.value ? "active" : ""}
                  aria-pressed={mode === option.value}
                  onClick={() => setMode(option.value)}
                  disabled={downloading || (urlLocksMode && detectedSpotifyMode !== option.value)}
                  title={urlLocksMode && detectedSpotifyMode !== option.value ? "The Spotify URL determines this type" : undefined}
                >
                  {option.value === "playlist" ? <ListMusic size={17} /> : option.value === "album" ? <Disc3 size={17} /> : <Music2 size={17} />}
                  {option.label}
                </button>
              );
            })}
          </div>

          <label className="downloadField downloadUrlField">
            <span>
              <Link2 size={15} />
              {source === "spotify" ? "Spotify URL" : mode === "playlist" ? "Playlist URL" : "Media URL"}
              {source === "spotify" && detectedSpotifyMode && (
                <small className="downloadDetected">Detected: {modeName(detectedSpotifyMode)}</small>
              )}
            </span>
            <div className="downloadUrlControl"><input
              type="url"
              inputMode="url"
              autoComplete="off"
              value={url}
              onChange={(event) => changeUrl(event.target.value)}
              placeholder={source === "spotify"
                ? "https://open.spotify.com/track/..."
                : mode === "playlist"
                  ? "https://www.youtube.com/playlist?list=..."
                  : "https://www.youtube.com/watch?v=..."}
              aria-describedby={source === "spotify" ? "spotify-download-note" : undefined}
              disabled={busy}
              required={section === "download"}
              spellCheck={false}
            /><button type="button" className="downloadPasteButton" onClick={() => void pasteUrl()} disabled={busy} title="Paste link from clipboard"><ClipboardPaste size={16} /> Paste</button></div>
          </label>

          {source === "spotify" && (
            <div id="spotify-download-note" className="downloadSourceNote">
              <Info size={18} />
              <div>
                <strong>Spotify metadata, matched audio</strong>
                <p>Tracks are matched to public audio on YouTube. Quality depends on the match; Spotify audio streams are not downloaded.</p>
              </div>
            </div>
          )}
        </div>

        <div className="downloadOptionGrid">
          <label className="downloadField">
            <span><FolderOpen size={15} /> Save to</span>
            <div className="pathPicker">
              <input
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="Downloads/Loavy Player"
                disabled={busy}
              />
              <button
                type="button"
                className="iconButton borderedIconButton"
                onClick={chooseFolder}
                disabled={busy}
                title="Choose folder"
                aria-label="Choose download folder"
              >
                <FolderOpen size={18} />
              </button>
            </div>
          </label>

        </div>

        <fieldset className="downloadFormats" disabled={busy}>
          <legend>Choose your audio format</legend>
          <div>{AUDIO_FORMATS.map((option) => (
            <label key={option.value} className={format === option.value ? "selected" : ""}>
              <input type="radio" name="audio-format" value={option.value} checked={format === option.value} onChange={() => setFormat(option.value)} />
              <strong>{option.label}</strong><small>{option.description}</small>
            </label>
          ))}</div>
        </fieldset>

        <div className="downloadOutputPreview"><Music2 size={17} /><div><span>Example file</span><output>{outputPreview}</output></div><button type="button" onClick={() => setSection("naming")} disabled={busy}>Edit naming</button></div>

        {format === "flac" && (
          <p className="downloadFieldHint">FLAC cannot add quality that is missing from the original source.</p>
        )}

        {(downloading || repairing) && (
          <div className="downloadProgress" aria-live="polite" role="status">
            <div className={percent === null ? "progressTrack indeterminate" : "progressTrack"}>
              <span style={percent === null ? undefined : { width: `${percent}%` }} />
            </div>
            <div className="downloadProgressMeta">
              <div>
                <span>{sourceName(progressSource)} · {itemLabel}</span>
                <strong>{progressTitle}</strong>
              </div>
              <span>
                {progress?.bytesWritten ? formatBytes(progress.bytesWritten) : ""}
                {progress?.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : ""}
                {percent !== null ? ` (${percent}%)` : ""}
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="downloadNotice error downloadFailureNotice" role="alert">
            <Info size={18} aria-hidden="true" />
            <div>
              <strong>{error.message}</strong>
              <span>{failureHint(error)}</span>
              <div className="downloadFailureActions">
                {lastRequestRef.current && error.category !== "cancelled" && (
                  <button
                    type="button"
                    className="secondaryAction"
                    onClick={() => void runDownload({ ...lastRequestRef.current! })}
                    disabled={downloading || repairing}
                  >
                    <RotateCcw size={15} /> Retry the same request
                  </button>
                )}
              </div>
              {error.diagnostic && (
                <details className="downloadFailureDetails">
                  <summary>Show technical details</summary>
                  <pre>{formatDiagnostic(error)}</pre>
                </details>
              )}
            </div>
          </div>
        )}

        {result && (
          <div className="downloadResult" aria-live="polite">
            <div className="downloadResultHeader">
              <CheckCircle2 size={20} />
              <div>
                <strong>{result.downloadedCount > 0 ? `${result.downloadedCount} ${result.downloadedCount === 1 ? "song" : "songs"} ready to listen` : "No new files saved"}</strong>
                <span>{result.destination}</span>
                <small className="downloadResultMeta">{sourceName(result.source)} · {result.format.toUpperCase()}</small>
              </div>
              <button
                type="button"
                className="secondaryAction"
                onClick={() => void revealDownload(result.files[0] || result.destination)}
              >
                <FolderOpen size={16} /> Show files
              </button>
            </div>
            {(result.failedCount > 0 || result.warnings.length > 0) && (
              <div className="downloadPartialNotice" role="status">
                <Info size={16} />
                <div>
                  <strong>
                    Some items need your attention
                  </strong>
                  <span>{result.warnings[0] || "The other files were saved successfully."}</span>
                  {result.warnings.length > 1 && <details><summary>Show all {result.warnings.length} notices</summary><ul>{result.warnings.slice(1).map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
                </div>
              </div>
            )}
            {result.files.length > 0 && (
              <div className="downloadedFiles">
                {result.files.slice(0, 5).map((file) => <button type="button" key={file} onClick={() => void revealDownload(file)} title={file}><Music2 size={14} />{fileName(file)}<FolderOpen size={14} /></button>)}
                {result.files.length > 5 && <span>+ {result.files.length - 5} more</span>}
              </div>
            )}
          </div>
        )}

        <div className="downloadActions">
          <button className="primaryAction" type="submit" disabled={busy || !url.trim()}>
            {downloading ? <LoaderCircle size={18} className="spin" /> : <Download size={18} />}
            {repairing ? "Tools are being repaired" : downloading ? "Downloading" : actionLabel}
          </button>
          {(downloading || repairing) && (
            <button className="secondaryAction dangerAction" type="button" onClick={() => void cancelDownload()} disabled={cancelling}>
              <Square size={15} /> {cancelling ? "Stopping" : repairing ? "Cancel repair" : "Cancel"}
            </button>
          )}
          {!downloading && !repairing && (result || error) && (
            <button className="secondaryAction" type="button" onClick={reset}>
              <RotateCcw size={16} /> New download
            </button>
          )}
        </div>
        <p className="downloadLibraryHint">To see saved music in your library, choose a configured music folder and scan it in Settings.</p>
        </div>

        <div
          id="downloader-naming-panel"
          className="downloadSectionPanel downloadNamingPanel"
          role="tabpanel"
          aria-labelledby="downloader-naming-tab"
          hidden={section !== "naming"}
        >
          <div className="namingPanelHeader">
            <div>
              <h3>File and folder naming</h3>
              <p>Build names from each song&apos;s metadata. Your choices are saved automatically.</p>
            </div>
            {downloading && <span className="namingLockedNotice">Available after the current download</span>}
          </div>

          <div className="namingTemplateGrid">
            <section className="namingTemplateCard" aria-labelledby="filename-template-label">
              <div className="namingFieldHeader">
                <label id="filename-template-label" htmlFor="filename-template">Filename</label>
                <button
                  type="button"
                  className="namingResetButton"
                  onClick={resetFilenameTemplate}
                  disabled={busy}
                  title="Reset filename template"
                  aria-label="Reset filename template to artist and title"
                >
                  <RotateCcw size={15} /> Reset
                </button>
              </div>
              <div className="namingTemplateControl">
                <input
                  id="filename-template"
                  ref={filenameTemplateRef}
                  value={filenameTemplate}
                  onChange={(event) => setFilenameTemplate(event.target.value)}
                  onFocus={() => setActiveTemplateField("filename")}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={512}
                  aria-describedby="filename-template-help filename-template-preview"
                />
              </div>
              <p id="filename-template-help" className="namingFieldHelp">
                The correct audio extension is added automatically.
              </p>
              <div id="filename-template-preview" className="namingPreview" aria-live="polite">
                <span>Preview</span>
                <output>{filenamePreview}</output>
              </div>
            </section>

            <section className="namingTemplateCard" aria-labelledby="folder-template-label">
              <div className="namingFieldHeader">
                <label id="folder-template-label" htmlFor="folder-template">Folder structure</label>
                <button
                  type="button"
                  className="namingResetButton"
                  onClick={resetFolderTemplate}
                  disabled={busy}
                  title="Reset folder template"
                  aria-label="Reset folder template to album artist and album"
                >
                  <RotateCcw size={15} /> Reset
                </button>
              </div>
              <div className="namingTemplateControl">
                <input
                  id="folder-template"
                  ref={folderTemplateRef}
                  value={folderTemplate}
                  onChange={(event) => setFolderTemplate(event.target.value)}
                  onFocus={() => setActiveTemplateField("folder")}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={512}
                  aria-describedby="folder-template-help folder-template-preview"
                />
              </div>
              <label id="folder-template-help" className="namingFolderToggle">
                <span>
                  <strong>Use folders for single tracks</strong>
                  <small>Applies to albums and direct-link playlists by default. Spotify playlists stay together in the destination.</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={applyFolderToSingle}
                  onChange={(event) => setApplyFolderToSingle(event.target.checked)}
                  disabled={busy}
                />
              </label>
              <div id="folder-template-preview" className="namingPreview" aria-live="polite">
                <span>Preview</span>
                <output>{folderPreview ? `${folderPreview}/` : "No subfolder"}</output>
              </div>
            </section>
          </div>

          <div className="namingTokenSection" aria-labelledby="naming-token-heading">
            <div className="namingTokenHeader">
              <strong id="naming-token-heading">Metadata tokens</strong>
              <span>Insert into the {activeTemplateField === "filename" ? "filename" : "folder"} field</span>
            </div>
            <div className="namingTokenList" role="group" aria-label="Template tokens">
              {TEMPLATE_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  className="namingTokenChip"
                  onClick={() => insertTemplateToken(token)}
                  disabled={busy}
                  aria-label={`Insert ${token} into ${activeTemplateField} template`}
                >
                  {token}
                </button>
              ))}
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}

function ToolStatusPill({ label, health }: { label: string; health?: DownloaderToolHealth }) {
  const usable = health?.state === "ready" || health?.state === "updateAvailable";
  const stateLabel = !health
    ? "checking"
    : health.state === "ready"
      ? health.version || "ready"
      : health.state === "updateAvailable"
        ? `${health.version || "installed"} · update ready`
        : health.state === "corrupt"
          ? "needs repair"
          : "not installed";
  return (
    <div
      className={usable ? "downloaderStatus ready" : health ? `downloaderStatus ${health.state}` : "downloaderStatus"}
      title={health?.detail || undefined}
    >
      {usable ? <CheckCircle2 size={14} /> : <Wrench size={14} />}
      <span>{label}: {stateLabel}</span>
    </div>
  );
}

function spotifyModeFromUrl(value: string): DownloadMode | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "open.spotify.com") return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const typeIndex = segments.findIndex((segment) => segment === "track" || segment === "album" || segment === "playlist");
    if (typeIndex < 0 || !segments[typeIndex + 1]) return null;
    const type = segments[typeIndex];
    if (type === "track") return "single";
    if (type === "album") return "album";
    if (type === "playlist") return "playlist";
    return null;
  } catch {
    return null;
  }
}

function isHttpUrl(value: string) {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

function phaseLabel(phase: DownloadProgress["phase"], source: DownloadSource) {
  switch (phase) {
    case "preparing": return "Verifying managed tools";
    case "reading": return source === "spotify" ? "Reading Spotify release" : "Reading media information";
    case "downloading": return "Downloading audio";
    case "processing": return "Processing audio";
    case "embedding": return "Embedding metadata";
    case "saving": return "Saving verified files";
  }
}

function phaseFallback(phase: DownloadProgress["phase"] | undefined, source: DownloadSource, format: DownloadFormat) {
  switch (phase) {
    case "preparing": return "Downloading or verifying the managed downloader tools...";
    case "reading": return source === "spotify" ? "Reading Spotify metadata..." : "Reading media information...";
    case "downloading": return "Downloading the best available audio...";
    case "processing": return `Processing ${format.toUpperCase()} audio...`;
    case "embedding": return "Adding title, artist, album, and artwork...";
    case "saving": return "Saving the finished audio file...";
    default: return source === "spotify" ? "Starting spotDL..." : "Starting yt-dlp...";
  }
}

function localFailure(message: string): DownloadFailure {
  return { message, category: "validation", retryable: false, diagnostic: null };
}

function normalizeDownloadFailure(error: unknown): DownloadFailure {
  if (error instanceof Error) return normalizeDownloadFailure(error.message);
  if (typeof error === "string") {
    try {
      return normalizeDownloadFailure(JSON.parse(error));
    } catch {
      return localFailure(error);
    }
  }
  if (error && typeof error === "object" && "message" in error) {
    const candidate = error as Partial<DownloadFailure>;
    return {
      message: typeof candidate.message === "string" ? candidate.message : "The download failed.",
      category: typeof candidate.category === "string" ? candidate.category : "unknown",
      retryable: candidate.retryable === true,
      diagnostic: candidate.diagnostic && typeof candidate.diagnostic === "object"
        ? candidate.diagnostic
        : null
    };
  }
  return localFailure(String(error));
}

function failureHint(error: DownloadFailure) {
  switch (error.category) {
    case "jsRuntime": return "Repair the tools, then retry the exact same request.";
    case "network": return "Check your connection and retry when the source is reachable.";
    case "unavailable": return "The source may be private, removed, restricted, or unavailable in your region.";
    case "disk": return "Check the destination folder, free space, and write permissions.";
    case "cancelled": return "No additional action is needed.";
    default: return error.retryable ? "You can retry the exact same request below." : "Review the technical details if you need to troubleshoot further.";
  }
}

function formatDiagnostic(error: DownloadFailure) {
  const diagnostic = error.diagnostic;
  if (!diagnostic) return "No technical details were reported.";
  return [
    `Loavy: ${diagnostic.loavyVersion}`,
    `Source: ${diagnostic.source}`,
    `Format: ${diagnostic.requestedFormat}`,
    `yt-dlp: ${diagnostic.ytDlpVersion || "unavailable"}`,
    `FFmpeg: ${diagnostic.ffmpegVersion || "unavailable"}`,
    `JavaScript runtime: ${diagnostic.jsRuntime || "unavailable"}`,
    `Exit code: ${diagnostic.exitCode ?? "unavailable"}`,
    "",
    diagnostic.reason,
    diagnostic.relevantStderr ? `\nRelevant downloader output:\n${diagnostic.relevantStderr}` : ""
  ].filter((line) => line !== "").join("\n");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function downloadActionLabel(source: DownloadSource, mode: DownloadMode) {
  if (source === "web") return mode === "playlist" ? "Download playlist" : "Download audio";
  if (mode === "album") return "Download album";
  if (mode === "playlist") return "Download playlist";
  return "Download track";
}

function modeName(mode: DownloadMode) {
  if (mode === "single") return "track";
  return mode;
}

function sourceName(source: DownloadSource) {
  return source === "spotify" ? "Spotify" : "Direct link";
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

const TEMPLATE_PREVIEW_VALUES: Record<string, string> = {
  title: "Golden",
  artist: "HUNTR/X",
  artists: "HUNTR/X",
  album: "KPop Demon Hunters (Soundtrack from the Netflix Film)",
  album_artist: "KPop Demon Hunters Cast",
  track: "01",
  total_tracks: "12",
  disc: "1",
  total_discs: "1",
  year: "2025",
  date: "2025-06-20",
  isrc: "QZ8BZ2512345",
  playlist: "KPop Favorites",
  position: "01"
};

function renderTemplatePreview(template: string, folder = false) {
  const rendered = template.replace(/\{([a-z_]+)\}/g, (token, key: string) => {
    const value = TEMPLATE_PREVIEW_VALUES[key];
    return value === undefined ? token : value.replace(/[<>:"/\\|?*]/g, "_");
  }).trim();
  if (!folder) return rendered;
  return rendered.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

function readStoredString(key: string, fallback: string) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function readStoredBoolean(key: string, fallback: boolean) {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function storeDownloaderSetting(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Downloads still work if the webview refuses local storage access.
  }
}
