import { Heart, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { audioEngine } from "../lib/audioEngine";
import { formatDuration, displayArtist, displayTrackTitle } from "../lib/format";
import { useAudio } from "../lib/useAudio";
import { Cover } from "./Cover";
import { api } from "../lib/api";

export function PlayerBar() {
  const audio = useAudio();
  const repeatIcon = audio.repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />;
  const favorite = Boolean(audio.current?.favorite);

  async function toggleFavorite() {
    if (!audio.current) return;
    const nextFavorite = !favorite;
    audioEngine.setCurrentFavorite(nextFavorite);
    try {
      await api.setTrackFavorite(audio.current.id, nextFavorite);
      window.dispatchEvent(new CustomEvent("loavy:favorite-changed", {
        detail: { trackId: audio.current.id, favorite: nextFavorite }
      }));
    } catch {
      audioEngine.setCurrentFavorite(favorite);
    }
  }

  return (
    <footer className="playerBar">
      <div className="nowPlaying">
        <Cover path={audio.current?.coverPath} title={audio.current?.album || undefined} size="sm" />
        <div>
          <strong>{audio.current ? displayTrackTitle(audio.current) : "Ready to play"}</strong>
          <span>{audio.current ? displayArtist(audio.current.artist) : "Add music in Settings"}</span>
        </div>
      </div>

      <div className="transport">
        <div className="transportButtons">
          <button className={audio.shuffle ? "iconButton active" : "iconButton"} onClick={() => audioEngine.setShuffle(!audio.shuffle)} title="Shuffle">
            <Shuffle size={17} />
          </button>
          <button className="iconButton" onClick={() => void audioEngine.previous()} title="Previous">
            <SkipBack size={19} />
          </button>
          <button className="playButton" onClick={() => void audioEngine.toggle()} title={audio.playing ? "Pause" : "Play"}>
            {audio.playing ? <Pause size={22} /> : <Play size={22} />}
          </button>
          <button className="iconButton" onClick={() => void audioEngine.next()} title="Next">
            <SkipForward size={19} />
          </button>
          <button
            className={favorite ? "iconButton active favoriteButton" : "iconButton favoriteButton"}
            onClick={() => void toggleFavorite()}
            title={favorite ? "Remove from favorites" : "Add to favorites"}
            disabled={!audio.current}
          >
            <Heart size={17} fill={favorite ? "currentColor" : "none"} />
          </button>
          <button
            className={audio.repeat !== "off" ? "iconButton active" : "iconButton"}
            onClick={() => audioEngine.setRepeat(audio.repeat === "off" ? "all" : audio.repeat === "all" ? "one" : "off")}
            title="Repeat"
          >
            {repeatIcon}
          </button>
        </div>
        <div className="seekRow">
          <span>{formatDuration(audio.position)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(audio.duration, 1)}
            value={Math.min(audio.position, Math.max(audio.duration, 1))}
            onChange={(event) => audioEngine.seek(Number(event.target.value))}
          />
          <span>{formatDuration(audio.duration)}</span>
        </div>
      </div>

      <div className="volume">
        <Volume2 size={18} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={audio.volume}
          onChange={(event) => audioEngine.setVolume(Number(event.target.value))}
          title="Volume"
        />
      </div>
    </footer>
  );
}
