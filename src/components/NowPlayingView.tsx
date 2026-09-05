import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ChevronDown,
  Disc3,
  Expand,
  Heart,
  Image,
  ListMusic,
  Minimize,
  MoreHorizontal,
  Pause,
  Play,
  Quote,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { audioEngine } from "../lib/audioEngine";
import { displayAlbum, displayArtist, displayTrackTitle, formatDuration } from "../lib/format";
import { useLibraryActions } from "../lib/LibraryContext";
import { useAudio } from "../lib/useAudio";
import { Cover } from "./Cover";
import { LyricsPanel } from "./LyricsPanel";
import { QueuePanel } from "./QueuePanel";

type Props = {
  onClose: () => void;
  onToggleFavorite: () => void;
  onOpenMenu?: (button: HTMLButtonElement) => void;
};

export function NowPlayingView({ onClose, onToggleFavorite, onOpenMenu }: Props) {
  const audio = useAudio();
  const { openAlbum, openArtist } = useLibraryActions();
  const viewRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const showQueueRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [mode, setMode] = useState<"artwork" | "lyrics">(() => localStorage.getItem("loavy.nowPlayingMode") === "lyrics" ? "lyrics" : "artwork");
  const [showQueue, setShowQueue] = useState(false);
  const [nestedDialogOpen, setNestedDialogOpen] = useState(false);
  onCloseRef.current = onClose;
  showQueueRef.current = showQueue;
  const backgroundObscured = showQueue || nestedDialogOpen;
  const favorite = Boolean(audio.current?.favorite);
  const coverUrl = audio.current?.coverPath ? convertFileSrc(audio.current.coverPath) : undefined;
  const trackTitle = audio.current ? displayTrackTitle(audio.current) : "";
  const repeatIcon = audio.repeat === "one" ? <Repeat1 size={20} /> : <Repeat size={20} />;
  const progress = audio.duration ? Math.min(100, (audio.position / audio.duration) * 100) : 0;
  const progressStyle = { "--range-progress": `${progress}%` } as CSSProperties;
  const volumeStyle = { "--range-progress": `${audio.volume * 100}%` } as CSSProperties;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function onFullscreenChange() {
      setFullscreen(Boolean(document.fullscreenElement));
    }
    function onKeyDown(event: KeyboardEvent) {
      const view = viewRef.current;
      if (!view?.contains(event.target as Node)) return;
      if (event.key === "Escape" && !document.fullscreenElement && !showQueueRef.current) {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...view.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex='-1'])"
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const update = () => {
      const next = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
        .some((dialog) => dialog !== viewRef.current && !dialog.classList.contains("queuePanel"));
      const view = viewRef.current;
      if (next || showQueueRef.current) view?.setAttribute("inert", "");
      else view?.removeAttribute("inert");
      setNestedDialogOpen((current) => current === next ? current : next);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-modal"],
      childList: true,
      subtree: true
    });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (backgroundObscured) view.setAttribute("inert", "");
    else view.removeAttribute("inert");
    return () => view.removeAttribute("inert");
  }, [backgroundObscured]);

  function selectMode(nextMode: "artwork" | "lyrics") {
    setMode(nextMode);
    localStorage.setItem("loavy.nowPlayingMode", nextMode);
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await viewRef.current?.requestFullscreen();
  }

  function navigateToArtist() {
    const artist = audio.current?.artist?.trim();
    if (!artist) return;
    openArtist(artist);
    onClose();
  }

  function navigateToAlbum() {
    const album = audio.current?.album?.trim();
    if (!album) return;
    openAlbum(album);
    onClose();
  }

  return (
    <div
      className="nowPlayingView"
      ref={viewRef}
      role="dialog"
      aria-modal={backgroundObscured ? undefined : true}
      aria-label="Now playing"
    >
      {coverUrl && <div className="nowPlayingBackdrop" style={{ backgroundImage: `url("${coverUrl}")` }} />}
      <div className="nowPlayingTint" />

      <header className="nowPlayingHeader" aria-label="Now playing controls">
        <button ref={closeRef} className="glassIconButton nowPlayingClose" onClick={onClose} title="Close now playing" aria-label="Close now playing">
          <ChevronDown size={23} />
        </button>
        <div className="nowPlayingModeSwitch" role="group" aria-label="Now playing presentation">
          <button className={mode === "artwork" ? "active" : ""} aria-pressed={mode === "artwork"} onClick={() => selectMode("artwork")}><Image size={15} /> Artwork</button>
          <button className={mode === "lyrics" ? "active" : ""} aria-pressed={mode === "lyrics"} onClick={() => selectMode("lyrics")}><Quote size={15} /> Lyrics</button>
        </div>
        <button className="glassIconButton nowPlayingFullscreen" onClick={() => void toggleFullscreen()} title={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>
          {fullscreen ? <Minimize size={20} /> : <Expand size={20} />}
        </button>
      </header>

      {!audio.current ? (
        <section className="nowPlayingEmpty" aria-label="Now playing status">
          <span><Disc3 size={54} /></span>
          <h2>Nothing playing</h2>
          <p>Choose something from your library and it will appear here.</p>
          <button className="primaryAction" onClick={onClose}>Browse your music</button>
        </section>
      ) : (
        <section className={mode === "lyrics" ? "nowPlayingStage lyricsMode" : "nowPlayingStage artworkMode"} aria-labelledby="now-playing-track-title">
          <section className="nowPlayingVisual" aria-label={mode === "artwork" ? "Album artwork" : undefined}>
            {mode === "artwork" ? (
              <div className="nowPlayingArtwork">
                <Cover path={audio.current.coverPath} title={audio.current.album || undefined} size="lg" />
                <div className="artworkGlow" />
              </div>
            ) : <LyricsPanel track={audio.current} />}
          </section>

          <section className="nowPlayingDetails" aria-label="Playback details">
            <div className="playingStatus"><span /> {audio.playing ? "Playing now" : "Paused"}</div>
            <div className="heroTitleRow">
              <div className="heroTitleCopy">
                <h2 id="now-playing-track-title" className={`heroTrackTitle ${titleLengthClass(trackTitle)}`} title={trackTitle}>{trackTitle}</h2>
                <button className="heroArtistLink" onClick={navigateToArtist} disabled={!audio.current.artist?.trim()}>
                  {displayArtist(audio.current.artist)}
                </button>
              </div>
              <button
                className={favorite ? "heroFavorite active" : "heroFavorite"}
                onClick={onToggleFavorite}
                title={favorite ? "Remove from favorites" : "Add to favorites"}
                aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
                disabled={audio.current.id <= 0}
              >
                <Heart size={22} fill={favorite ? "currentColor" : "none"} />
              </button>
            </div>

            <div className="heroAlbum">
              <ListMusic size={16} />
              <button onClick={navigateToAlbum} disabled={!audio.current.album?.trim()}>{displayAlbum(audio.current.album)}</button>
              {audio.current.year && <span>{audio.current.year}</span>}
            </div>

            <div className="heroProgress">
              <input
                aria-label="Song progress"
                type="range"
                min={0}
                max={Math.max(audio.duration, 1)}
                value={Math.min(audio.position, Math.max(audio.duration, 1))}
                onChange={(event) => audioEngine.seek(Number(event.target.value))}
                onPointerUp={() => { audioEngine.commitSeek(); }}
                onKeyUp={() => { audioEngine.commitSeek(); }}
                onBlur={() => { audioEngine.commitSeek(); }}
                style={progressStyle}
                disabled={audio.localControlBlocked}
                aria-valuetext={`${formatDuration(audio.position)} of ${formatDuration(audio.duration)}`}
              />
              <div><span>{formatDuration(audio.position)}</span><span>{formatDuration(audio.duration)}</span></div>
            </div>

            <div className="heroControls" role="group" aria-label="Playback controls">
              <button className={audio.shuffle ? "heroControl active" : "heroControl"} onClick={() => audioEngine.setShuffle(!audio.shuffle)} title="Shuffle" aria-label="Toggle shuffle" aria-pressed={audio.shuffle} disabled={audio.localControlBlocked}>
                <Shuffle size={21} />
              </button>
              <button className="heroControl" onClick={() => void audioEngine.previous()} title="Previous" aria-label="Previous song" disabled={audio.localControlBlocked}><SkipBack size={29} /></button>
              <button className="heroPlayButton" onClick={() => void audioEngine.toggle()} title={audio.playing ? "Pause" : "Play"} aria-label={audio.playing ? "Pause" : "Play"} disabled={audio.localControlBlocked}>
                {audio.playing ? <Pause size={34} /> : <Play size={34} fill="currentColor" />}
              </button>
              <button className="heroControl" onClick={() => void audioEngine.next()} title="Next" aria-label="Next song" disabled={audio.localControlBlocked}><SkipForward size={29} /></button>
              <button
                className={audio.repeat !== "off" ? "heroControl active" : "heroControl"}
                onClick={() => audioEngine.setRepeat(audio.repeat === "off" ? "all" : audio.repeat === "all" ? "one" : "off")}
                title="Repeat"
                aria-label={`Repeat ${audio.repeat}`}
                aria-pressed={audio.repeat !== "off"}
                disabled={audio.localControlBlocked}
              >
                {repeatIcon}
              </button>
            </div>

            <div className="heroSecondaryControls">
              <button className="glassTextButton" onClick={() => setShowQueue(true)}><ListMusic size={17} /> Queue {audio.upNext.length ? <span>{audio.upNext.length}</span> : null}</button>
              {onOpenMenu && <button className="glassTextButton" onClick={(event) => onOpenMenu(event.currentTarget)}><MoreHorizontal size={18} /> More</button>}
              <label className="heroVolume">
                <Volume2 size={18} />
                <span className="srOnly">Volume</span>
                <input aria-label="Volume" aria-valuetext={`${Math.round(audio.volume * 100)}%`} type="range" min={0} max={1} step={0.01} value={audio.volume} onChange={(event) => audioEngine.setVolume(Number(event.target.value))} style={volumeStyle} />
              </label>
            </div>
          </section>
        </section>
      )}
      {showQueue && <QueuePanel onClose={() => setShowQueue(false)} />}
    </div>
  );
}

function titleLengthClass(title: string) {
  if (title.length <= 24) return "titleShort";
  if (title.length <= 44) return "titleMedium";
  if (title.length <= 72) return "titleLong";
  return "titleExtraLong";
}
