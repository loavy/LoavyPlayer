import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2,
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
  DownloadMode,
  DownloadProgress,
  DownloadResult,
  DownloaderStatus,
  DownloadSource,
  MediaDownloadRequest
} from "../types";

type DownloaderSection = "download" | "naming";
type TemplateField = "filename" | "folder";

type Props = {
  onDownloadMedia: (request: MediaDownloadRequest) => Promise<DownloadResult>;
  onGetStatus: () => Promise<DownloaderStatus>;
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
  onCancel,
  onSelectFolder,
  onRevealDownload
}: Props) {
  const [section, setSection] = useState<DownloaderSection>("download");
  const [source, setSource] = useState<DownloadSource>("spotify");
  const [mode, setMode] = useState<DownloadMode>("single");
  const [format, setFormat] = useState<DownloadFormat>("m4a");
  const [urls, setUrls] = useState<Record<DownloadSource, string>>({ spotify: "", web: "" });
  const [destination, setDestination] = useState("");
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [status, setStatus] = useState<DownloaderStatus | null>(null);
  const [result, setResult] = useState<DownloadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
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
  const filenameTemplateRef = useRef<HTMLInputElement>(null);
  const folderTemplateRef = useRef<HTMLInputElement>(null);

  const url = urls[source];
  const detectedSpotifyMode = source === "spotify" ? spotifyModeFromUrl(url) : null;
  const availableModes = source === "spotify" ? spotifyModes : webModes;

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
    const statusRevision = lifecycleRevision.current;
    void onGetStatus()
      .then((nextStatus) => {
        setStatus(nextStatus);
        if (lifecycleRevision.current === statusRevision) {
          setDownloading(nextStatus.running);
        }
      })
      .catch(() => {
        // A status check should not prevent the user from attempting a download.
      });

    const unlistenProgress = listen<DownloadProgress>("download://progress", (event) => {
      lifecycleRevision.current += 1;
      setProgress(event.payload);
      setDownloading(true);
    });
    const unlistenCompleted = listen<DownloadResult>("download://completed", (event) => {
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
    const unlistenFailed = listen<string>("download://failed", (event) => {
      lifecycleRevision.current += 1;
      setError(event.payload);
      setProgress(null);
      setDownloading(false);
      setCancelling(false);
      void onGetStatus().then(setStatus).catch(() => undefined);
    });
    return () => {
      void Promise.all([unlistenProgress, unlistenCompleted, unlistenFailed])
        .then((removeListeners) => removeListeners.forEach((removeListener) => removeListener()));
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
    if (section !== "download") return;
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError(source === "spotify" ? "Paste a Spotify track, album, or playlist URL." : `Enter a ${mode === "playlist" ? "playlist" : "media"} URL.`);
      return;
    }

    let requestMode = mode;
    if (source === "spotify") {
      const inferredMode = spotifyModeFromUrl(trimmedUrl);
      if (!inferredMode) {
        setError("Use an https://open.spotify.com track, album, or playlist URL.");
        return;
      }
      requestMode = inferredMode;
      setMode(inferredMode);
    } else if (!isHttpUrl(trimmedUrl)) {
      setError("Enter a valid http:// or https:// media URL.");
      return;
    }

    lifecycleRevision.current += 1;
    setDownloading(true);
    setCancelling(false);
    setProgress(null);
    setResult(null);
    setError(null);
    try {
      const nextResult = await onDownloadMedia({
        source,
        url: trimmedUrl,
        destinationDir: destination.trim() || null,
        mode: requestMode,
        format,
        filenameTemplate,
        folderTemplate,
        applyFolderToSingle
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
    try {
      await onCancel();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
      setCancelling(false);
    }
  }

  function changeSource(nextSource: DownloadSource) {
    if (downloading || source === nextSource) return;
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
    setUrls((current) => ({ ...current, [source]: nextUrl }));
    setError(null);
    if (source === "spotify") {
      const inferredMode = spotifyModeFromUrl(nextUrl);
      if (inferredMode) setMode(inferredMode);
    }
  }

  function reset() {
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
  const itemLabel = progress?.itemIndex
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

  return (
    <section className="downloaderView" aria-labelledby="downloader-title">
      <div className="downloaderIntro">
        <div className="downloaderMark"><Music2 size={26} /></div>
        <div>
          <span>Loavy Downloader 5.8.1</span>
          <h2 id="downloader-title">Bring more music into your library.</h2>
          <p>Save Spotify tracks and releases, or download audio from a supported direct link.</p>
        </div>
        <div className="downloaderStatuses" aria-label="Downloader tool status">
          <div className={status?.spotdlInstalled ? "downloaderStatus ready" : "downloaderStatus"}>
            <Disc3 size={14} />
            Spotify: {status?.spotdlInstalled ? `spotDL ${status.spotdlVersion || "ready"}` : "sets up on first use"}
          </div>
          <div className={status?.installed ? "downloaderStatus ready" : "downloaderStatus"}>
            <Wrench size={14} />
            Direct: {status?.installed ? `yt-dlp ${status.version || "ready"}` : "sets up on first use"}
          </div>
        </div>
      </div>

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
            disabled={downloading}
          >
            <Disc3 size={18} /> Spotify
          </button>
          <button
            id="web-source-tab"
            type="button"
            role="tab"
            aria-selected={source === "web"}
            aria-controls="download-source-panel"
            className={source === "web" ? "active" : ""}
            onClick={() => changeSource("web")}
            disabled={downloading}
          >
            <Globe2 size={18} /> Direct link
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

          <label className="downloadField">
            <span>
              <Link2 size={15} />
              {source === "spotify" ? "Spotify URL" : mode === "playlist" ? "Playlist URL" : "Media URL"}
              {source === "spotify" && detectedSpotifyMode && (
                <small className="downloadDetected">Detected: {modeName(detectedSpotifyMode)}</small>
              )}
            </span>
            <input
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
              disabled={downloading}
              required={section === "download"}
            />
          </label>

          {source === "spotify" && (
            <div id="spotify-download-note" className="downloadSourceNote">
              <Info size={18} />
              <div>
                <strong>How Spotify downloads work</strong>
                <p>Spotify supplies the metadata. spotDL matches it to audio hosted elsewhere—normally YouTube—so a FLAC conversion is not true lossless audio.</p>
                <p className="downloadSetupNote">
                  {status?.spotdlInstalled ? "Spotify tools are ready." : "First-use setup:"} {status?.spotdlInstalled ? "A fresh setup is" : "Loavy downloads"} about 125 MB for managed spotDL and FFmpeg.
                </p>
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
                disabled={downloading}
              />
              <button
                type="button"
                className="iconButton borderedIconButton"
                onClick={chooseFolder}
                disabled={downloading}
                title="Choose folder"
                aria-label="Choose download folder"
              >
                <FolderOpen size={18} />
              </button>
            </div>
          </label>

          <label className="downloadField">
            <span><Disc3 size={15} /> Audio format</span>
            <select value={format} onChange={(event) => setFormat(event.target.value as DownloadFormat)} disabled={downloading}>
              <option value="m4a">M4A · Recommended</option>
              <option value="mp3">MP3 · Compatible</option>
              <option value="opus">Opus · Efficient</option>
              <option value="flac">FLAC · Converted</option>
            </select>
          </label>
        </div>

        {format === "flac" && source !== "spotify" && (
          <p className="downloadFieldHint">FLAC cannot add quality that is missing from the original source.</p>
        )}

        {downloading && (
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

        {error && <div className="downloadNotice error" role="alert">{error}</div>}

        {result && (
          <div className="downloadResult" aria-live="polite">
            <div className="downloadResultHeader">
              <CheckCircle2 size={20} />
              <div>
                <strong>{result.downloadedCount} {result.downloadedCount === 1 ? "song" : "songs"} ready</strong>
                <span>{result.destination}</span>
                <small className="downloadResultMeta">{sourceName(result.source)} · {result.format.toUpperCase()}</small>
              </div>
              <button
                type="button"
                className="secondaryAction"
                onClick={() => void onRevealDownload(result.files[0] || result.destination)}
              >
                <FolderOpen size={16} /> Show files
              </button>
            </div>
            {(result.failedCount > 0 || result.warnings.length > 0) && (
              <div className="downloadPartialNotice" role="status">
                <Info size={16} />
                <div>
                  <strong>
                    {result.failedCount > 0
                      ? `${result.failedCount} ${result.failedCount === 1 ? "track" : "tracks"} could not be downloaded.`
                      : "Completed with a warning."}
                  </strong>
                  <span>
                    {result.warnings[0] || "The other files were saved successfully."}
                    {result.warnings.length > 1 ? ` (+${result.warnings.length - 1} more)` : ""}
                  </span>
                </div>
              </div>
            )}
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
            {downloading ? "Downloading" : actionLabel}
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
                  disabled={downloading}
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
                  disabled={downloading}
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
                  disabled={downloading}
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
                  disabled={downloading}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={512}
                  aria-describedby="folder-template-help folder-template-preview"
                />
              </div>
              <label id="folder-template-help" className="namingFolderToggle">
                <span>
                  <strong>Use folders for single tracks</strong>
                  <small>Otherwise, folder structure applies only to albums and playlists.</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={applyFolderToSingle}
                  onChange={(event) => setApplyFolderToSingle(event.target.checked)}
                  disabled={downloading}
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
                  disabled={downloading}
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
    case "installing": return "One-time setup";
    case "resolving": return source === "spotify" ? "Matching audio" : "Resolving link";
    case "starting": return "Starting downloader";
    case "downloading": return "Downloading audio";
    case "converting": return "Converting audio";
    case "tagging": return "Writing metadata";
  }
}

function phaseFallback(phase: DownloadProgress["phase"] | undefined, source: DownloadSource, format: DownloadFormat) {
  switch (phase) {
    case "installing": return source === "spotify" ? "Installing spotDL and FFmpeg..." : "Installing yt-dlp...";
    case "resolving": return source === "spotify" ? "Finding the best audio match..." : "Reading media information...";
    case "downloading": return "Downloading the best available audio...";
    case "converting": return `Converting to ${format.toUpperCase()}...`;
    case "tagging": return "Adding title, artist, album, and artwork...";
    default: return source === "spotify" ? "Starting spotDL..." : "Starting yt-dlp...";
  }
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
  const rendered = template.replace(/\{([a-z_]+)\}/g, (token, key: string) => TEMPLATE_PREVIEW_VALUES[key] ?? token).trim();
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
