import { listen } from "@tauri-apps/api/event";
import { navigateTabList } from "../components/SegmentedTabs";
import {
  Check,
  CheckCircle2,
  Cloud as CloudIcon,
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
  Play,
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
  { value: "single", label: "Song" },
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
  const [history, setHistory] = useState<HistoryEntry[]>(readHistory);
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
      rememberDownload(historyEntry(event.payload, { source: event.payload.source, url: event.payload.url, destinationDir: event.payload.destination || null, mode: event.payload.mode, format: event.payload.format, filenameTemplate: readStoredString(FILENAME_TEMPLATE_STORAGE_KEY, DEFAULT_FILENAME_TEMPLATE), folderTemplate: readStoredString(FOLDER_TEMPLATE_STORAGE_KEY, DEFAULT_FOLDER_TEMPLATE), applyFolderToSingle: readStoredBoolean(APPLY_FOLDER_TO_SINGLE_STORAGE_KEY, false) }));
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

  function rememberDownload(entry: HistoryEntry) {
    if (entry.count <= 0) return;
    setHistory((current) => {
      const next = [entry, ...current.filter((item) => item.request.url !== entry.request.url || item.format !== entry.format)].slice(0, 12);
      storeDownloaderSetting(HISTORY_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  function clearHistory() {
    setHistory([]);
    storeDownloaderSetting(HISTORY_STORAGE_KEY, "[]");
  }

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
      rememberDownload(historyEntry(nextResult, request));
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

  const detected = detectLink(url);
  const toolHealth = status ? [status.ytDlp, status.ffmpeg, status.jsRuntime, status.spotdl] : [];
  const toolsReady = toolHealth.length > 0 && toolHealth.every((health) => health?.state === "ready" || health?.state === "updateAvailable");
  const toolsSummary = !status ? "Checking tools" : toolsReady ? "Tools ready" : "Tools need repair";
  const stepIndex = repairing ? -1 : progress ? PHASE_STEPS.findIndex((step) => step.phases.includes(progress.phase)) : 0;

  return (
    <section className="downloaderView dlView" aria-labelledby="downloader-title" data-busy={busy}>
      <header className="dlHeader">
        <div className="dlHeaderText">
          <h2 id="downloader-title">Downloader</h2>
          <p>Paste a link from Spotify, YouTube or SoundCloud and keep the song in your collection.</p>
        </div>
        <details className="downloaderTools">
          <summary><span className="dlToolsDot" data-state={!status ? "checking" : toolsReady ? "ready" : "repair"} />{toolsSummary}</summary>
          <div className="downloaderStatuses" aria-label="Downloader tool status">
            <ToolStatusPill label="yt-dlp" health={status?.ytDlp} />
            <ToolStatusPill label="FFmpeg" health={status?.ffmpeg} />
            <ToolStatusPill label={status?.jsRuntime.provider || "Deno"} health={status?.jsRuntime} />
            <ToolStatusPill label="spotDL" health={status?.spotdl} />
            <p>Installed and updated automatically on Windows.</p>
            <button type="button" className="downloaderRepairButton" onClick={() => void repairTools()} disabled={downloading || repairing}>
              {repairing ? <LoaderCircle size={14} className="spin" /> : <Wrench size={14} />}
              {repairing ? "Repairing tools" : "Repair tools"}
            </button>
          </div>
        </details>
      </header>

      <div className="dlLayout">
      <form className="downloadSurface dlSurface" onSubmit={handleDownload}>
        <div className="downloadSectionTabs" role="tablist" aria-label="Downloader settings" onKeyDown={navigateTabList}>
          <button id="downloader-download-tab" type="button" role="tab" aria-selected={section === "download"} tabIndex={section === "download" ? 0 : -1} aria-controls="downloader-download-panel" className={section === "download" ? "active" : ""} onClick={() => setSection("download")}>
            <Download size={15} /> Download
          </button>
          <button id="downloader-naming-tab" type="button" role="tab" aria-selected={section === "naming"} tabIndex={section === "naming" ? 0 : -1} aria-controls="downloader-naming-panel" className={section === "naming" ? "active" : ""} onClick={() => setSection("naming")} disabled={busy}>
            <ListMusic size={15} /> File names
          </button>
        </div>

        <div id="downloader-download-panel" className="downloadSectionPanel downloadMainPanel" role="tabpanel" aria-labelledby="downloader-download-tab" hidden={section !== "download"}>
          <div className="dlLinkCard" data-kind={detected?.kind || "empty"}>
            <label className="downloadField downloadUrlField">
              <span className="dlVisuallyHidden">{source === "spotify" ? "Spotify URL" : mode === "playlist" ? "Playlist URL" : "Media URL"}</span>
              <div className="downloadUrlControl">
                <span className="dlLinkIcon" aria-hidden="true">{detected ? <SourceGlyph kind={detected.kind} /> : <Link2 size={20} />}</span>
                <input
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  value={url}
                  onChange={(event) => changeUrl(event.target.value)}
                  placeholder={source === "spotify" ? "Paste a Spotify link" : mode === "playlist" ? "Paste a playlist link" : "Paste a YouTube or SoundCloud link"}
                  aria-describedby="download-link-status"
                  disabled={busy}
                  required={section === "download"}
                  spellCheck={false}
                />
                <button type="button" className="downloadPasteButton" onClick={() => void pasteUrl()} disabled={busy} title="Paste link from clipboard"><ClipboardPaste size={15} /> Paste</button>
              </div>
            </label>
            <div className="dlLinkMeta">
              <span id="download-link-status" className="dlDetected" data-kind={detected?.kind || "empty"}>
                {detected ? <>{detected.label}{source === "spotify" && detectedSpotifyMode ? ` ${modeName(detectedSpotifyMode)}` : ""}</> : "Spotify, YouTube, SoundCloud and many more sites work"}
              </span>
              <div className="downloadSourceTabs" role="tablist" aria-label="Download source" onKeyDown={navigateTabList}>
                <button id="spotify-source-tab" type="button" role="tab" aria-selected={source === "spotify"} tabIndex={source === "spotify" ? 0 : -1} aria-controls="download-source-panel" className={source === "spotify" ? "active" : ""} onClick={() => changeSource("spotify")} disabled={busy}>
                  <Disc3 size={15} /><span>Spotify</span>
                </button>
                <button id="web-source-tab" type="button" role="tab" aria-selected={source === "web"} tabIndex={source === "web" ? 0 : -1} aria-controls="download-source-panel" className={source === "web" ? "active" : ""} onClick={() => changeSource("web")} disabled={busy}>
                  <Globe2 size={15} /><span>Other sites</span>
                </button>
              </div>
            </div>
          </div>

          <div id="download-source-panel" className="downloadSourcePanel" role="tabpanel" aria-labelledby={source === "spotify" ? "spotify-source-tab" : "web-source-tab"}>
            <div className="dlRow">
              <span className="dlRowLabel">Get</span>
              <div className={availableModes.length === 3 ? "downloadMode threeOptions" : "downloadMode"} aria-label="Download type">
                {availableModes.map((option) => {
                  const urlLocksMode = source === "spotify" && detectedSpotifyMode !== null;
                  return (
                    <button key={option.value} type="button" className={mode === option.value ? "active" : ""} aria-pressed={mode === option.value} onClick={() => setMode(option.value)} disabled={downloading || (urlLocksMode && detectedSpotifyMode !== option.value)} title={urlLocksMode && detectedSpotifyMode !== option.value ? "The Spotify link decides this" : undefined}>
                      {option.value === "playlist" ? <ListMusic size={15} /> : option.value === "album" ? <Disc3 size={15} /> : <Music2 size={15} />}
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
            {source === "spotify" && <p id="spotify-download-note" className="downloadSourceNote"><Info size={14} />Spotify gives the song details; the audio is matched from YouTube, so quality depends on the match.</p>}
          </div>

          <fieldset className="downloadFormats" disabled={busy}>
            <legend className="dlVisuallyHidden">Audio format</legend>
            <div className="dlRow"><span className="dlRowLabel" aria-hidden="true">Format</span><div className="dlFormatList">{AUDIO_FORMATS.map((option) => (
              <label key={option.value} className={format === option.value ? "selected" : ""} title={option.description}>
                <input type="radio" name="audio-format" value={option.value} checked={format === option.value} onChange={() => setFormat(option.value)} />
                <strong>{option.label}</strong><small>{option.description}</small>
              </label>
            ))}</div></div>
          </fieldset>
          {format === "flac" && <p className="downloadFieldHint">FLAC keeps what the source has; it can't add quality that isn't there.</p>}

          <div className="dlRow dlSaveRow">
            <span className="dlRowLabel">Save to</span>
            <label className="downloadField dlSaveField">
              <span className="dlVisuallyHidden">Save to folder</span>
              <div className="pathPicker">
                <button type="button" className="iconButton borderedIconButton" onClick={chooseFolder} disabled={busy} title="Choose folder" aria-label="Choose download folder"><FolderOpen size={17} /></button>
                <input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Downloads\Loavy Player" disabled={busy} />
              </div>
            </label>
          </div>

          <div className="downloadOutputPreview"><Music2 size={15} /><div><span>Saved as</span><output>{outputPreview}</output></div><button type="button" onClick={() => setSection("naming")} disabled={busy}>Change</button></div>

          {(downloading || repairing) && (
            <div className="downloadProgress dlProgress" aria-live="polite" role="status">
              <div className="dlProgressTop">
                <span className="dlProgressDisc" aria-hidden="true"><Disc3 size={26} /></span>
                <div className="downloadProgressMeta">
                  <span>{sourceName(progressSource)}, {itemLabel.toLowerCase()}</span>
                  <strong>{progressTitle}</strong>
                </div>
                <span className="dlPercent">{percent !== null ? `${percent}%` : ""}</span>
              </div>
              <div className={percent === null ? "progressTrack indeterminate" : "progressTrack"}><span style={percent === null ? undefined : { width: `${percent}%` }} /></div>
              {!repairing && <ol className="dlSteps" aria-label="Download steps">
                {PHASE_STEPS.map((step, index) => <li key={step.label} data-state={index < stepIndex ? "done" : index === stepIndex ? "current" : "todo"}><span>{index < stepIndex ? <Check size={11} strokeWidth={3} /> : index + 1}</span>{step.label}</li>)}
              </ol>}
              {(progress?.bytesWritten || progress?.totalBytes) ? <small className="dlBytes">{progress?.bytesWritten ? formatBytes(progress.bytesWritten) : ""}{progress?.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : ""}</small> : null}
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
                    <button type="button" className="secondaryAction" onClick={() => void runDownload({ ...lastRequestRef.current! })} disabled={downloading || repairing}><RotateCcw size={15} /> Try again</button>
                  )}
                  {(error.category === "jsRuntime" || error.category === "unknown") && (
                    <button type="button" className="secondaryAction" onClick={() => void repairTools()} disabled={downloading || repairing}><Wrench size={15} /> Repair tools</button>
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
                <span className="dlResultIcon"><CheckCircle2 size={22} /></span>
                <div>
                  <strong>{result.downloadedCount > 0 ? `${result.downloadedCount} ${result.downloadedCount === 1 ? "song" : "songs"} saved` : "No new files saved"}</strong>
                  <span title={result.destination}>{result.destination}</span>
                  <small className="downloadResultMeta">{sourceName(result.source)}, {result.format.toUpperCase()}</small>
                </div>
                <button type="button" className="secondaryAction" onClick={() => void revealDownload(result.files[0] || result.destination)}><FolderOpen size={15} /> Show files</button>
              </div>
              {(result.failedCount > 0 || result.warnings.length > 0) && (
                <div className="downloadPartialNotice" role="status">
                  <Info size={16} />
                  <div>
                    <strong>{result.failedCount > 0 ? `${result.failedCount} ${result.failedCount === 1 ? "song" : "songs"} couldn't be saved` : "A few things to know"}</strong>
                    <span>{result.warnings[0] || "The other files were saved."}</span>
                    {result.warnings.length > 1 && <details><summary>Show all {result.warnings.length} notes</summary><ul>{result.warnings.slice(1).map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
                  </div>
                </div>
              )}
              {result.files.length > 0 && (
                <div className="downloadedFiles">
                  {result.files.slice(0, 6).map((file) => <button type="button" key={file} onClick={() => void revealDownload(file)} title={file}><Music2 size={14} /><span>{fileName(file)}</span><FolderOpen size={14} /></button>)}
                  {result.files.length > 6 && <span>and {result.files.length - 6} more</span>}
                </div>
              )}
            </div>
          )}

          <div className="downloadActions">
            <button className="primaryAction dlGo" type="submit" disabled={busy || !url.trim()}>
              {downloading ? <LoaderCircle size={18} className="spin" /> : <Download size={18} />}
              {repairing ? "Repairing tools" : downloading ? "Downloading" : actionLabel}
            </button>
            {(downloading || repairing) && (
              <button className="secondaryAction dangerAction" type="button" onClick={() => void cancelDownload()} disabled={cancelling}>
                <Square size={13} fill="currentColor" /> {cancelling ? "Stopping" : repairing ? "Cancel repair" : "Cancel"}
              </button>
            )}
            {!downloading && !repairing && (result || error) && (
              <button className="secondaryAction" type="button" onClick={reset}><RotateCcw size={15} /> New download</button>
            )}
          </div>
          <p className="downloadLibraryHint">Songs show up in your library when they're saved inside one of your music folders.</p>
        </div>

        <div id="downloader-naming-panel" className="downloadSectionPanel downloadNamingPanel" role="tabpanel" aria-labelledby="downloader-naming-tab" hidden={section !== "naming"}>
          <div className="namingPanelHeader">
            <div>
              <h3>File and folder names</h3>
              <p>Built from each song's details. Changes are saved automatically.</p>
            </div>
            {downloading && <span className="namingLockedNotice">Available after the current download</span>}
          </div>

          <div className="namingTemplateGrid">
            <section className="namingTemplateCard" aria-labelledby="filename-template-label">
              <div className="namingFieldHeader">
                <label id="filename-template-label" htmlFor="filename-template">File name</label>
                <button type="button" className="namingResetButton" onClick={resetFilenameTemplate} disabled={busy} title="Reset filename template" aria-label="Reset filename template to artist and title"><RotateCcw size={14} /> Reset</button>
              </div>
              <div className="namingTemplateControl">
                <input id="filename-template" ref={filenameTemplateRef} value={filenameTemplate} onChange={(event) => setFilenameTemplate(event.target.value)} onFocus={() => setActiveTemplateField("filename")} disabled={busy} autoComplete="off" spellCheck={false} maxLength={512} aria-describedby="filename-template-help filename-template-preview" />
              </div>
              <p id="filename-template-help" className="namingFieldHelp">The right extension is added for you.</p>
              <div id="filename-template-preview" className="namingPreview" aria-live="polite"><span>Preview</span><output>{filenamePreview}</output></div>
            </section>

            <section className="namingTemplateCard" aria-labelledby="folder-template-label">
              <div className="namingFieldHeader">
                <label id="folder-template-label" htmlFor="folder-template">Folders</label>
                <button type="button" className="namingResetButton" onClick={resetFolderTemplate} disabled={busy} title="Reset folder template" aria-label="Reset folder template to album artist and album"><RotateCcw size={14} /> Reset</button>
              </div>
              <div className="namingTemplateControl">
                <input id="folder-template" ref={folderTemplateRef} value={folderTemplate} onChange={(event) => setFolderTemplate(event.target.value)} onFocus={() => setActiveTemplateField("folder")} disabled={busy} autoComplete="off" spellCheck={false} maxLength={512} aria-describedby="folder-template-help folder-template-preview" />
              </div>
              <label id="folder-template-help" className="namingFolderToggle">
                <span>
                  <strong>Use folders for single songs</strong>
                  <small>Albums and playlists from other sites always use folders. Spotify playlists stay together in one place.</small>
                </span>
                <input type="checkbox" role="switch" checked={applyFolderToSingle} onChange={(event) => setApplyFolderToSingle(event.target.checked)} disabled={busy} />
              </label>
              <div id="folder-template-preview" className="namingPreview" aria-live="polite"><span>Preview</span><output>{folderPreview ? `${folderPreview}/` : "No subfolder"}</output></div>
            </section>
          </div>

          <div className="namingTokenSection" aria-labelledby="naming-token-heading">
            <div className="namingTokenHeader">
              <strong id="naming-token-heading">Song details you can use</strong>
              <span>Click to add to the {activeTemplateField === "filename" ? "file name" : "folders"}</span>
            </div>
            <div className="namingTokenList" role="group" aria-label="Template tokens">
              {TEMPLATE_TOKENS.map((token) => (
                <button key={token} type="button" className="namingTokenChip" onClick={() => insertTemplateToken(token)} disabled={busy} aria-label={`Insert ${token} into ${activeTemplateField} template`}>{token}</button>
              ))}
            </div>
          </div>
        </div>
      </form>

      <aside className="dlSide">
        <section className="dlHistory" aria-labelledby="dl-history-title">
          <header><h3 id="dl-history-title">Recent downloads</h3>{history.length > 0 && <button type="button" className="dlHistoryClear" onClick={clearHistory}>Clear</button>}</header>
          {history.length ? <ul>
            {history.map((entry) => (
              <li key={entry.id}>
                <span className="dlHistoryIcon" data-kind={entry.kind}><SourceGlyph kind={entry.kind} /></span>
                <div className="dlHistoryText">
                  <strong title={entry.title}>{entry.title}</strong>
                  <small>{entry.count} {entry.count === 1 ? "song" : "songs"}, {entry.format.toUpperCase()}, {timeAgo(entry.at)}{entry.failed ? `, ${entry.failed} failed` : ""}</small>
                </div>
                <div className="dlHistoryActions">
                  {entry.firstFile && <button type="button" className="iconButton" onClick={() => void revealDownload(entry.firstFile!)} title="Show files" aria-label={`Show files for ${entry.title}`}><FolderOpen size={15} /></button>}
                  <button type="button" className="iconButton" onClick={() => void runDownload({ ...entry.request })} disabled={busy} title="Download again" aria-label={`Download ${entry.title} again`}><RotateCcw size={15} /></button>
                </div>
              </li>
            ))}
          </ul> : <div className="dlHistoryEmpty"><span aria-hidden="true"><Download size={20} /></span><strong>Nothing downloaded yet</strong><small>Songs you save show up here, so you can open them or grab them again.</small></div>}
        </section>
        <section className="dlTips" aria-label="Tips">
          <h3>Good to know</h3>
          <ul>
            <li><Disc3 size={15} /><span><strong>Spotify links</strong> bring the right title, artist and cover. The sound comes from a matching YouTube upload.</span></li>
            <li><ListMusic size={15} /><span><strong>Playlists and albums</strong> are saved into their own folder.</span></li>
            <li><Music2 size={15} /><span><strong>M4A</strong> keeps the best quality with the smallest files.</span></li>
          </ul>
        </section>
      </aside>
      </div>
    </section>
  );
}

const PHASE_STEPS: Array<{ label: string; phases: DownloadProgress["phase"][] }> = [
  { label: "Read", phases: ["preparing", "reading"] },
  { label: "Download", phases: ["downloading"] },
  { label: "Convert", phases: ["processing"] },
  { label: "Tag", phases: ["embedding"] },
  { label: "Save", phases: ["saving"] }
];

type LinkKind = "spotify" | "youtube" | "soundcloud" | "bandcamp" | "web";

function detectLink(value: string): { kind: LinkKind; label: string } | null {
  try {
    const parsed = new URL(value.trim());
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\.|^m\./, "");
    if (host === "open.spotify.com") return { kind: "spotify", label: "Spotify" };
    if (host === "music.youtube.com") return { kind: "youtube", label: "YouTube Music" };
    if (host === "youtube.com" || host === "youtu.be") return { kind: "youtube", label: parsed.searchParams.has("list") && !parsed.searchParams.has("v") ? "YouTube playlist" : "YouTube" };
    if (host.endsWith("soundcloud.com")) return { kind: "soundcloud", label: "SoundCloud" };
    if (host.endsWith("bandcamp.com")) return { kind: "bandcamp", label: "Bandcamp" };
    return { kind: "web", label: host };
  } catch {
    return null;
  }
}

function SourceGlyph({ kind }: { kind: LinkKind }) {
  if (kind === "spotify") return <Disc3 size={18} />;
  if (kind === "youtube") return <Play size={16} fill="currentColor" />;
  if (kind === "soundcloud") return <CloudIcon size={18} />;
  if (kind === "bandcamp") return <Music2 size={18} />;
  return <Globe2 size={18} />;
}

type HistoryEntry = { id: string; at: number; kind: LinkKind; title: string; count: number; failed: number; format: DownloadFormat; firstFile: string | null; request: MediaDownloadRequest };
const HISTORY_STORAGE_KEY = "loavy.downloader.history";

function readHistory(): HistoryEntry[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === "string" && entry.request?.url).slice(0, 12) : [];
  } catch {
    return [];
  }
}

function historyEntry(result: DownloadResult, request: MediaDownloadRequest): HistoryEntry {
  const first = result.files[0] || null;
  const name = first ? fileName(first).replace(/\.[a-z0-9]{2,5}$/i, "") : detectLink(result.url)?.label || result.url;
  const title = result.files.length > 1 ? `${name} and ${result.files.length - 1} more` : name;
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), kind: detectLink(result.url)?.kind || (result.source === "spotify" ? "spotify" : "web"), title, count: result.downloadedCount, failed: result.failedCount, format: result.format, firstFile: first, request };
}

function timeAgo(at: number) {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
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
