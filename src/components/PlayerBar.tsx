import { Heart, ListMusic, MoreHorizontal, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { audioEngine } from "../lib/audioEngine";
import { formatDuration, displayArtist, displayTrackTitle } from "../lib/format";
import { errorMessage, useLibraryActions } from "../lib/LibraryContext";
import { useAudio } from "../lib/useAudio";
import { Cover } from "./Cover";
import { api } from "../lib/api";
import { NowPlayingView } from "./NowPlayingView";
import { QueuePanel } from "./QueuePanel";
import { SongContextMenu } from "./SongContextMenu";
import type { MenuPoint } from "./ContextMenu";

export function PlayerBar() {
  const audio = useAudio();
  const { notify } = useLibraryActions();
  const [showNowPlaying, setShowNowPlaying] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [menuPoint, setMenuPoint] = useState<MenuPoint | null>(null);
  const repeatIcon = audio.repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />;
  const favorite = Boolean(audio.current?.favorite);
  const seekProgress = audio.duration ? Math.min(100, (audio.position / audio.duration) * 100) : 0;
  const seekStyle = { "--range-progress": `${seekProgress}%` } as CSSProperties;
  const volumeStyle = { "--range-progress": `${audio.volume * 100}%` } as CSSProperties;

  async function toggleFavorite() {
    if (!audio.current || audio.current.id <= 0) return;
    const track = audio.current;
    const previousFavorite = track.favorite;
    const nextFavorite = !previousFavorite;
    audioEngine.patchTrackFavorite(track.id, nextFavorite);
    try {
      await api.setTrackFavorite(track.id, nextFavorite);
      window.dispatchEvent(new CustomEvent("loavy:favorite-changed", { detail: { trackId: track.id, favorite: nextFavorite } }));
    } catch (error) {
      audioEngine.patchTrackFavorite(track.id, previousFavorite);
      notify(errorMessage(error), "error");
    }
  }

  function openMenu(button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect();
    setMenuPoint({ x: rect.right - 6, y: rect.top - 8 });
  }

  return (
    <>
      <footer className={audio.playing ? "playerBar isPlaying" : "playerBar"}>
        <div className="nowPlaying">
          <button className="nowPlayingMain" onClick={() => setShowNowPlaying(true)} title="Open now playing" disabled={!audio.current}>
            <span className="playerCover">
              <Cover path={audio.current?.coverPath} title={audio.current?.album || undefined} size="sm" />
              {audio.playing && <span className="playingPulse" aria-hidden="true"><i /><i /><i /></span>}
            </span>
            <span className="playerTrackText">
              <strong>{audio.current ? displayTrackTitle(audio.current) : "Ready to play"}</strong>
              <span>{audio.current ? displayArtist(audio.current.artist) : "Add music in Settings"}</span>
            </span>
          </button>
          {audio.current && (
            <span className="playerTrackActions">
              <button className={favorite ? "iconButton active favoriteButton" : "iconButton favoriteButton"} onClick={() => void toggleFavorite()} disabled={audio.current.id <= 0} title={favorite ? "Remove from favorites" : "Add to favorites"} aria-label={favorite ? "Remove from favorites" : "Add to favorites"}><Heart size={16} fill={favorite ? "currentColor" : "none"} /></button>
              <button className="iconButton" onClick={(event) => openMenu(event.currentTarget)} title="More song actions" aria-label="More song actions"><MoreHorizontal size={18} /></button>
            </span>
          )}
        </div>

        <div className="transport">
          <div className="transportButtons">
            <button className={audio.shuffle ? "iconButton active" : "iconButton"} onClick={() => audioEngine.setShuffle(!audio.shuffle)} title="Shuffle" aria-label="Toggle shuffle" disabled={audio.localControlBlocked}><Shuffle size={17} /></button>
            <button className="iconButton" onClick={() => void audioEngine.previous()} title="Previous" aria-label="Previous song" disabled={!audio.current || audio.localControlBlocked}><SkipBack size={19} /></button>
            <button className="playButton" onClick={() => void audioEngine.toggle()} title={audio.playing ? "Pause" : "Play"} aria-label={audio.playing ? "Pause" : "Play"} disabled={!audio.current || audio.localControlBlocked}>{audio.playing ? <Pause size={22} /> : <Play size={22} fill="currentColor" />}</button>
            <button className="iconButton" onClick={() => void audioEngine.next()} title="Next" aria-label="Next song" disabled={!audio.current || audio.localControlBlocked}><SkipForward size={19} /></button>
            <button className={audio.repeat !== "off" ? "iconButton active" : "iconButton"} onClick={() => audioEngine.setRepeat(audio.repeat === "off" ? "all" : audio.repeat === "all" ? "one" : "off")} title={`Repeat ${audio.repeat}`} aria-label={`Repeat ${audio.repeat}`} disabled={audio.localControlBlocked}>{repeatIcon}</button>
          </div>
          <div className="seekRow">
            <span>{formatDuration(audio.position)}</span>
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
              style={seekStyle}
              disabled={!audio.current || audio.localControlBlocked}
            />
            <span>{formatDuration(audio.duration)}</span>
          </div>
        </div>

        <div className="playerUtilities">
          <button className={showQueue ? "iconButton active queueButton" : "iconButton queueButton"} onClick={() => setShowQueue(true)} title="Open queue" aria-label={`Open queue, ${audio.upNext.length} upcoming`}>
            <ListMusic size={18} />{audio.upNext.length > 0 && <span>{Math.min(audio.upNext.length, 99)}</span>}
          </button>
          <label className="volume">
            <Volume2 size={18} />
            <input aria-label="Volume" type="range" min={0} max={1} step={0.01} value={audio.volume} onChange={(event) => audioEngine.setVolume(Number(event.target.value))} title="Volume" style={volumeStyle} />
          </label>
        </div>
      </footer>
      {showNowPlaying && <NowPlayingView onClose={() => setShowNowPlaying(false)} onToggleFavorite={() => void toggleFavorite()} onOpenMenu={openMenu} />}
      {showQueue && <QueuePanel onClose={() => setShowQueue(false)} />}
      {menuPoint && audio.current && <SongContextMenu track={audio.current} point={menuPoint} playbackQueue={audio.queue} queueIndex={audio.currentIndex} onClose={() => setMenuPoint(null)} onNavigate={() => setShowNowPlaying(false)} />}
    </>
  );
}
