import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Expand,
  Heart,
  Music2,
  Pause,
  Pin,
  PinOff,
  Play,
  SkipBack,
  SkipForward
} from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { displayArtist, displayTrackTitle } from "../lib/format";
import type {
  MiniPlayerActionResult,
  MiniPlayerCommand,
  MiniPlayerState
} from "../lib/miniPlayerBridge";
import "../mini-player.css";

const MAIN_WINDOW_LABEL = "main";
const MINI_PLAYER_READY_EVENT = "mini-player://ready";
const MINI_PLAYER_CLOSED_EVENT = "mini-player://closed";
const MINI_PLAYER_STATE_EVENT = "mini-player://state";
const MINI_PLAYER_COMMAND_EVENT = "mini-player://command";
const MINI_PLAYER_ACTION_RESULT_EVENT = "mini-player://action-result";

const EMPTY_STATE: MiniPlayerState = {
  current: null,
  playing: false,
  position: 0,
  duration: 0,
  localControlBlocked: false,
  playbackError: null
};

export function MiniPlayerWindow() {
  const [player, setPlayer] = useState<MiniPlayerState>(EMPTY_STATE);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [windowBusy, setWindowBusy] = useState(false);
  const [dragPosition, setDragPosition] = useState<number | null>(null);

  useEffect(() => {
    applySavedAppearance();
    let disposed = false;
    let unlisteners: UnlistenFn[] = [];
    const notifyClosed = () => {
      void emitTo(MAIN_WINDOW_LABEL, MINI_PLAYER_CLOSED_EVENT).catch(() => undefined);
    };
    window.addEventListener("pagehide", notifyClosed);

    async function connect() {
      try {
        const listeners = await Promise.all([
          listen<MiniPlayerState>(MINI_PLAYER_STATE_EVENT, (event) => {
            if (disposed) return;
            setPlayer(event.payload);
            setConnected(true);
          }),
          listen<MiniPlayerActionResult>(MINI_PLAYER_ACTION_RESULT_EVENT, (event) => {
            if (disposed) return;
            if (event.payload.action === "favorite") setFavoriteBusy(false);
            setMessage(event.payload.error);
          })
        ]);
        if (disposed) {
          listeners.forEach((unlisten) => unlisten());
          return;
        }
        unlisteners = listeners;
        await emitTo(MAIN_WINDOW_LABEL, MINI_PLAYER_READY_EVENT);
      } catch (error) {
        if (!disposed) setMessage(`Could not connect to Loavy: ${errorMessage(error)}`);
      }
    }

    void connect();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      window.removeEventListener("pagehide", notifyClosed);
    };
  }, []);

  const current = player.current;
  const title = current ? displayTrackTitle(current) : "Nothing playing";
  const artist = current ? displayArtist(current.artist) : "Choose a song in Loavy";
  const position = dragPosition ?? player.position;
  const progress = player.duration > 0 ? Math.min(100, (position / player.duration) * 100) : 0;
  const progressStyle = { "--mini-range-progress": `${progress}%` } as CSSProperties;
  const controlsDisabled = !current || player.localControlBlocked || !connected;
  const artworkUrl = current?.coverPath ? mediaSource(current.coverPath) : null;

  function send(command: MiniPlayerCommand) {
    void emitTo(MAIN_WINDOW_LABEL, MINI_PLAYER_COMMAND_EVENT, command)
      .catch((error) => {
        if (command.type === "favorite") setFavoriteBusy(false);
        setMessage(`Could not control playback: ${errorMessage(error)}`);
      });
  }

  function previewSeek(value: number) {
    const positionMs = Math.min(player.duration || value, Math.max(0, value));
    setDragPosition(positionMs);
    send({ type: "seek", positionMs });
  }

  function commitSeek() {
    if (dragPosition === null) return;
    send({ type: "commit-seek" });
    setDragPosition(null);
  }

  function toggleFavorite() {
    if (!current || current.id <= 0 || favoriteBusy) return;
    setFavoriteBusy(true);
    setMessage(null);
    send({ type: "favorite" });
  }

  async function toggleAlwaysOnTop() {
    if (windowBusy) return;
    const next = !alwaysOnTop;
    setWindowBusy(true);
    setMessage(null);
    try {
      await invoke<void>("set_mini_player_always_on_top", { enabled: next });
      setAlwaysOnTop(next);
    } catch (error) {
      setMessage(`Could not change always-on-top: ${errorMessage(error)}`);
    } finally {
      setWindowBusy(false);
    }
  }

  async function returnToLoavy() {
    if (windowBusy) return;
    setWindowBusy(true);
    setMessage(null);
    try {
      await invoke<void>("show_full_player");
    } catch (error) {
      setMessage(`Could not restore Loavy: ${errorMessage(error)}`);
      setWindowBusy(false);
    }
  }

  return (
    <main className="miniPlayerShell" aria-label="Loavy Mini Player">
      <section className="miniPlayerTrack" aria-live="polite">
        <div className={artworkUrl ? "miniPlayerArtwork" : "miniPlayerArtwork placeholder"}>
          {artworkUrl ? <img src={artworkUrl} alt={current?.album || "Album artwork"} decoding="async" /> : <Music2 size={30} aria-hidden="true" />}
        </div>

        <div className="miniPlayerMetadata">
          <strong title={title}>{title}</strong>
          <span title={artist}>{artist}</span>
        </div>

        <div className="miniPlayerWindowActions" role="group" aria-label="Mini Player options">
          <button
            type="button"
            className={current?.favorite ? "miniIconButton favorite active" : "miniIconButton favorite"}
            onClick={toggleFavorite}
            disabled={!current || current.id <= 0 || favoriteBusy}
            title={current?.favorite ? "Remove from Favorites" : "Add to Favorites"}
            aria-label={current?.favorite ? "Remove from Favorites" : "Add to Favorites"}
          >
            <Heart size={17} fill={current?.favorite ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            className={alwaysOnTop ? "miniIconButton active" : "miniIconButton"}
            onClick={() => void toggleAlwaysOnTop()}
            disabled={windowBusy}
            title={alwaysOnTop ? "Turn off always on top" : "Keep Mini Player on top"}
            aria-label={alwaysOnTop ? "Turn off always on top" : "Keep Mini Player on top"}
            aria-pressed={alwaysOnTop}
          >
            {alwaysOnTop ? <PinOff size={16} /> : <Pin size={16} />}
          </button>
          <button
            type="button"
            className="miniIconButton"
            onClick={() => void returnToLoavy()}
            disabled={windowBusy}
            title="Return to full Loavy"
            aria-label="Return to full Loavy"
          >
            <Expand size={16} />
          </button>
        </div>
      </section>

      <section className="miniPlayerControls" aria-label="Playback controls">
        <button type="button" className="miniTransportButton" onClick={() => send({ type: "previous" })} disabled={controlsDisabled} title="Previous" aria-label="Previous song">
          <SkipBack size={22} fill="currentColor" />
        </button>
        <button type="button" className="miniPlayButton" onClick={() => send({ type: "toggle" })} disabled={controlsDisabled} title={player.playing ? "Pause" : "Play"} aria-label={player.playing ? "Pause" : "Play"}>
          {player.playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
        </button>
        <button type="button" className="miniTransportButton" onClick={() => send({ type: "next" })} disabled={controlsDisabled} title="Next" aria-label="Next song">
          <SkipForward size={22} fill="currentColor" />
        </button>
      </section>

      <section className="miniPlayerSeek" aria-label="Playback progress">
        <span>{formatMiniDuration(position)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(player.duration, 1)}
          value={Math.min(position, Math.max(player.duration, 1))}
          onChange={(event) => previewSeek(Number(event.target.value))}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          onBlur={commitSeek}
          disabled={controlsDisabled || player.duration <= 0}
          aria-label="Song progress"
          aria-valuetext={`${formatMiniDuration(position)} of ${formatMiniDuration(player.duration)}`}
          style={progressStyle}
        />
        <span>{formatMiniDuration(player.duration)}</span>
      </section>

      {(message || player.playbackError || (!connected && !message)) && (
        <p className={message || player.playbackError ? "miniPlayerMessage error" : "miniPlayerMessage"} role={message || player.playbackError ? "alert" : "status"}>
          {message || player.playbackError || "Connecting to Loavy…"}
        </p>
      )}
    </main>
  );
}

function applySavedAppearance() {
  const root = document.documentElement;
  root.dataset.theme = localStorage.getItem("loavy.theme") || "dark";
  root.dataset.motion = localStorage.getItem("loavy.reduceMotion") === "true" ? "reduced" : "full";
  root.dataset.contrast = localStorage.getItem("loavy.highContrast") === "true" ? "high" : "normal";
  root.style.setProperty("--accent", localStorage.getItem("loavy.accent") || "#48c6a8");
}

function mediaSource(path: string) {
  return /^(?:https?:|data:|blob:)/i.test(path.trim()) ? path : convertFileSrc(path);
}

function formatMiniDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
