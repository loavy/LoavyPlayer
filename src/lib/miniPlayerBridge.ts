import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { audioEngine, type AudioSnapshot } from "./audioEngine";
import { toggleAudioTrackFavorite } from "./favoriteActions";

export const MINI_PLAYER_LABEL = "mini-player";
export const MINI_PLAYER_READY_EVENT = "mini-player://ready";
export const MINI_PLAYER_CLOSED_EVENT = "mini-player://closed";
export const MINI_PLAYER_STATE_EVENT = "mini-player://state";
export const MINI_PLAYER_COMMAND_EVENT = "mini-player://command";
export const MINI_PLAYER_ACTION_RESULT_EVENT = "mini-player://action-result";

export type MiniPlayerTrack = {
  id: number;
  fileName: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  coverPath: string | null;
  favorite: boolean;
};

export type MiniPlayerState = {
  current: MiniPlayerTrack | null;
  playing: boolean;
  position: number;
  duration: number;
  localControlBlocked: boolean;
  playbackError: string | null;
};

export type MiniPlayerCommand =
  | { type: "toggle" }
  | { type: "previous" }
  | { type: "next" }
  | { type: "seek"; positionMs: number }
  | { type: "commit-seek" }
  | { type: "favorite" };

export type MiniPlayerActionResult = {
  action: "favorite";
  error: string | null;
};

/** Opens the singleton controller window through the narrow Rust command. */
export function openMiniPlayer() {
  return invoke<void>("open_mini_player");
}

/**
 * Bridges the main window's existing audio engine to the controller-only mini
 * window. Install this once in the main entry point, never in the mini window.
 */
export async function installMiniPlayerBridge(): Promise<() => void> {
  let miniConnected = false;
  let disposed = false;
  let sending = false;
  let pendingState: MiniPlayerState | null = null;
  let favoriteInFlight = false;

  const unsubscribeAudio = audioEngine.subscribe(() => queueState());
  const unlisteners = await Promise.all([
    safeListen(MINI_PLAYER_READY_EVENT, () => {
      miniConnected = true;
      queueState();
    }),
    safeListen(MINI_PLAYER_CLOSED_EVENT, () => {
      miniConnected = false;
      pendingState = null;
    }),
    safeListen<MiniPlayerCommand>(MINI_PLAYER_COMMAND_EVENT, (event) => {
      void handleCommand(event.payload);
    })
  ]);

  function queueState() {
    if (!miniConnected || disposed) return;
    pendingState = compactState(audioEngine.snapshot());
    void drainStateQueue();
  }

  async function drainStateQueue() {
    if (sending || disposed) return;
    sending = true;
    try {
      while (miniConnected && pendingState && !disposed) {
        const state = pendingState;
        pendingState = null;
        try {
          await emitTo(MINI_PLAYER_LABEL, MINI_PLAYER_STATE_EVENT, state);
        } catch {
          // The target disappeared; wait for its next ready event before sending.
          miniConnected = false;
          pendingState = null;
        }
      }
    } finally {
      sending = false;
    }
  }

  async function handleCommand(command: MiniPlayerCommand) {
    if (!command || typeof command !== "object" || disposed) return;
    switch (command.type) {
      case "toggle":
        await audioEngine.toggle();
        break;
      case "previous":
        await audioEngine.previous();
        break;
      case "next":
        await audioEngine.next();
        break;
      case "seek":
        if (Number.isFinite(command.positionMs)) audioEngine.seek(Math.max(0, command.positionMs));
        break;
      case "commit-seek":
        audioEngine.commitSeek();
        break;
      case "favorite":
        await toggleFavorite();
        break;
      default:
        break;
    }
  }

  async function toggleFavorite() {
    if (favoriteInFlight) return;
    const track = audioEngine.snapshot().current;
    if (!track || track.id <= 0) {
      await sendActionResult({ action: "favorite", error: "Favorites are only available for local library songs." });
      return;
    }

    favoriteInFlight = true;
    try {
      await toggleAudioTrackFavorite(track.id);
      await sendActionResult({ action: "favorite", error: null });
    } catch (error) {
      await sendActionResult({ action: "favorite", error: errorMessage(error) });
    } finally {
      favoriteInFlight = false;
    }
  }

  async function sendActionResult(result: MiniPlayerActionResult) {
    if (!miniConnected || disposed) return;
    try {
      await emitTo(MINI_PLAYER_LABEL, MINI_PLAYER_ACTION_RESULT_EVENT, result);
    } catch {
      miniConnected = false;
    }
  }

  return () => {
    disposed = true;
    miniConnected = false;
    pendingState = null;
    unsubscribeAudio();
    unlisteners.forEach((unlisten) => unlisten());
  };
}

function compactState(snapshot: AudioSnapshot): MiniPlayerState {
  const current = snapshot.current;
  return {
    current: current ? {
      id: current.id,
      fileName: current.fileName,
      title: current.title ?? null,
      artist: current.artist ?? null,
      album: current.album ?? null,
      coverPath: current.coverPath ?? null,
      favorite: current.favorite
    } : null,
    playing: snapshot.playing,
    position: Math.max(0, snapshot.position),
    duration: Math.max(0, snapshot.duration || current?.durationMs || 0),
    localControlBlocked: snapshot.localControlBlocked,
    playbackError: snapshot.error
  };
}

async function safeListen<T>(eventName: string, handler: Parameters<typeof listen<T>>[1]): Promise<UnlistenFn> {
  try {
    return await listen<T>(eventName, handler);
  } catch {
    // Browser-only development does not expose Tauri IPC.
    return () => undefined;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
