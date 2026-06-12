import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ChevronDown,
  Expand,
  Heart,
  ListMusic,
  Minimize,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { audioEngine } from "../lib/audioEngine";
import { displayAlbum, displayArtist, displayTrackTitle, formatDuration } from "../lib/format";
import { useAudio } from "../lib/useAudio";
import { Cover } from "./Cover";

type Props = {
  onClose: () => void;
  onToggleFavorite: () => void;
};

export function NowPlayingView({ onClose, onToggleFavorite }: Props) {
  const audio = useAudio();
  const viewRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const favorite = Boolean(audio.current?.favorite);
  const coverUrl = audio.current?.coverPath ? convertFileSrc(audio.current.coverPath) : undefined;
  const repeatIcon = audio.repeat === "one" ? <Repeat1 size={20} /> : <Repeat size={20} />;

  useEffect(() => {
    function onFullscreenChange() {
      setFullscreen(Boolean(document.fullscreenElement));
    }

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !document.fullscreenElement) onClose();
      if (event.code === "Space" && event.target === document.body) {
        event.preventDefault();
        void audioEngine.toggle();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await viewRef.current?.requestFullscreen();
    }
  }

  return (
    <div className="nowPlayingView" ref={viewRef} role="dialog" aria-modal="true" aria-label="Now playing">
      {coverUrl && <div className="nowPlayingBackdrop" style={{ backgroundImage: `url("${coverUrl}")` }} />}
      <div className="nowPlayingTint" />

      <header className="nowPlayingHeader">
        <button className="glassIconButton" onClick={onClose} title="Close now playing">
          <ChevronDown size={23} />
        </button>
        <div>
          <span>Now playing</span>
          <strong>Loavy Player</strong>
        </div>
        <button className="glassIconButton" onClick={() => void toggleFullscreen()} title={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>
          {fullscreen ? <Minimize size={20} /> : <Expand size={20} />}
        </button>
      </header>

      <main className="nowPlayingStage">
        <section className="nowPlayingArtwork">
          <Cover path={audio.current?.coverPath} title={audio.current?.album || undefined} size="lg" />
          <div className="artworkGlow" />
        </section>

        <section className="nowPlayingDetails">
          <div className="playingStatus"><span /> {audio.playing ? "Playing now" : "Paused"}</div>
          <div className="heroTitleRow">
            <div>
              <h2>{audio.current ? displayTrackTitle(audio.current) : "Nothing playing yet"}</h2>
              <p>{audio.current ? displayArtist(audio.current.artist) : "Choose a song from your library"}</p>
            </div>
            <button
              className={favorite ? "heroFavorite active" : "heroFavorite"}
              onClick={onToggleFavorite}
              disabled={!audio.current}
              title={favorite ? "Remove from favorites" : "Add to favorites"}
            >
              <Heart size={22} fill={favorite ? "currentColor" : "none"} />
            </button>
          </div>

          <div className="heroAlbum">
            <ListMusic size={16} />
            <span>{audio.current ? displayAlbum(audio.current.album) : "Your music, beautifully presented"}</span>
            {audio.current?.year && <span>{audio.current.year}</span>}
          </div>

          <div className="heroProgress">
            <input
              type="range"
              min={0}
              max={Math.max(audio.duration, 1)}
              value={Math.min(audio.position, Math.max(audio.duration, 1))}
              onChange={(event) => audioEngine.seek(Number(event.target.value))}
            />
            <div><span>{formatDuration(audio.position)}</span><span>{formatDuration(audio.duration)}</span></div>
          </div>

          <div className="heroControls">
            <button className={audio.shuffle ? "heroControl active" : "heroControl"} onClick={() => audioEngine.setShuffle(!audio.shuffle)} title="Shuffle">
              <Shuffle size={21} />
            </button>
            <button className="heroControl" onClick={() => void audioEngine.previous()} title="Previous"><SkipBack size={29} /></button>
            <button className="heroPlayButton" onClick={() => void audioEngine.toggle()} title={audio.playing ? "Pause" : "Play"}>
              {audio.playing ? <Pause size={34} /> : <Play size={34} fill="currentColor" />}
            </button>
            <button className="heroControl" onClick={() => void audioEngine.next()} title="Next"><SkipForward size={29} /></button>
            <button
              className={audio.repeat !== "off" ? "heroControl active" : "heroControl"}
              onClick={() => audioEngine.setRepeat(audio.repeat === "off" ? "all" : audio.repeat === "all" ? "one" : "off")}
              title="Repeat"
            >
              {repeatIcon}
            </button>
          </div>

          <div className="heroVolume">
            <Volume2 size={18} />
            <input type="range" min={0} max={1} step={0.01} value={audio.volume} onChange={(event) => audioEngine.setVolume(Number(event.target.value))} />
          </div>
        </section>
      </main>
    </div>
  );
}
