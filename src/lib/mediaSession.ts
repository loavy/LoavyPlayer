import { convertFileSrc } from "@tauri-apps/api/core";
import { audioEngine } from "./audioEngine";
import { displayAlbum, displayArtist, displayTrackTitle } from "./format";
import { spotify } from "./spotify";

type Cleanup = () => void;

/**
 * Connects Loavy's single audio engine to the browser Media Session exposed by
 * WebView2. This module must only be loaded by the main window: the mini player
 * is a controller and never imports the audio engine.
 */
export function installMediaSession(): Cleanup {
  if (!("mediaSession" in navigator)) return () => undefined;

  const session = navigator.mediaSession;
  const installedActions: MediaSessionAction[] = [];
  let metadataKey = "";
  let playbackState: MediaSessionPlaybackState = "none";
  let positionKey = "";

  function setAction(action: MediaSessionAction, handler: MediaSessionActionHandler) {
    try {
      session.setActionHandler(action, handler);
      installedActions.push(action);
    } catch {
      // WebView2 versions may expose Media Session without every optional action.
    }
  }

  setAction("play", () => {
    if (spotify.get().active) { if (!spotify.get().playback?.is_playing) void spotify.play(); return; }
    if (!audioEngine.snapshot().playing) void audioEngine.toggle();
  });
  setAction("pause", () => {
    if (spotify.get().active) { if (spotify.get().playback?.is_playing) void spotify.pause(); return; }
    if (audioEngine.snapshot().playing) void audioEngine.toggle();
  });
  setAction("previoustrack", () => { if (spotify.get().active) void spotify.skip("previous"); else void audioEngine.previous(); });
  setAction("nexttrack", () => { if (spotify.get().active) void spotify.skip("next"); else void audioEngine.next(); });
  setAction("stop", () => { if (spotify.get().active) void spotify.pause(); else void audioEngine.stop(); });
  setAction("seekto", (details) => {
    if (typeof details.seekTime !== "number" || !Number.isFinite(details.seekTime)) return;
    if (spotify.get().active) { void spotify.seek(details.seekTime * 1000); return; }
    audioEngine.seek(details.seekTime * 1_000);
    audioEngine.commitSeek();
  });
  setAction("seekbackward", (details) => {
    if (spotify.get().active) { void spotify.seek((spotify.get().playback?.progress_ms || 0) - (details.seekOffset ?? 10) * 1000); return; }
    const snapshot = audioEngine.snapshot();
    const offsetSeconds = details.seekOffset ?? 10;
    audioEngine.seek(Math.max(0, snapshot.position - offsetSeconds * 1_000));
    audioEngine.commitSeek();
  });
  setAction("seekforward", (details) => {
    if (spotify.get().active) { void spotify.seek((spotify.get().playback?.progress_ms || 0) + (details.seekOffset ?? 10) * 1000); return; }
    const snapshot = audioEngine.snapshot();
    const offsetSeconds = details.seekOffset ?? 10;
    audioEngine.seek(Math.min(snapshot.duration || Number.MAX_SAFE_INTEGER, snapshot.position + offsetSeconds * 1_000));
    audioEngine.commitSeek();
  });

  function sync() {
    const remote = spotify.get();
    const item = remote.playback?.item;
    const snapshot = remote.active ? {
      current: item ? { id: -1, path: item.uri, title: item.name, artist: item.artists.map(artist => artist.name).join(", "), album: item.album?.name, coverPath: item.album?.images?.[0]?.url, fileName: item.name, durationMs: item.duration_ms } : null,
      playing: !!remote.playback?.is_playing,
      duration: item?.duration_ms || 0,
      position: remote.playback?.progress_ms || 0,
    } : audioEngine.snapshot();
    const track = snapshot.current;
    const nextMetadataKey = track
      ? [track.id, track.path, track.title, track.artist, track.album, track.coverPath].join("\u0000")
      : "";

    if (nextMetadataKey !== metadataKey) {
      metadataKey = nextMetadataKey;
      try {
        session.metadata = track && typeof MediaMetadata !== "undefined"
          ? new MediaMetadata({
              title: displayTrackTitle(track),
              artist: displayArtist(track.artist),
              album: displayAlbum(track.album),
              artwork: track.coverPath ? [{ src: mediaArtworkSource(track.coverPath) }] : []
            })
          : null;
      } catch {
        // Metadata is a quality-of-life enhancement and must never affect audio.
      }
    }

    const nextPlaybackState: MediaSessionPlaybackState = !track
      ? "none"
      : snapshot.playing ? "playing" : "paused";
    if (nextPlaybackState !== playbackState) {
      playbackState = nextPlaybackState;
      try {
        session.playbackState = nextPlaybackState;
      } catch {
        // Some WebView2 versions expose a read-only implementation.
      }
    }

    const durationSeconds = Math.max(0, (snapshot.duration || track?.durationMs || 0) / 1_000);
    const positionSeconds = Math.min(durationSeconds, Math.max(0, snapshot.position / 1_000));
    const nextPositionKey = durationSeconds > 0
      ? `${durationSeconds.toFixed(3)}:${Math.floor(positionSeconds)}:${snapshot.playing ? 1 : 0}`
      : "";
    if (nextPositionKey !== positionKey) {
      positionKey = nextPositionKey;
      try {
        if (durationSeconds > 0) {
          session.setPositionState({
            duration: durationSeconds,
            playbackRate: 1,
            position: positionSeconds
          });
        } else {
          session.setPositionState();
        }
      } catch {
        // Invalid/unknown durations should not interfere with playback.
      }
    }
  }

  const unsubscribe = audioEngine.subscribe(sync);
  const unsubscribeSpotify = spotify.subscribe(sync);
  sync();

  return () => {
    unsubscribe();
    unsubscribeSpotify();
    installedActions.forEach((action) => {
      try {
        session.setActionHandler(action, null);
      } catch {
        // Best-effort cleanup during a reload or app shutdown.
      }
    });
    try {
      session.metadata = null;
      session.playbackState = "none";
      session.setPositionState();
    } catch {
      // Best-effort cleanup only.
    }
  };
}

function mediaArtworkSource(path: string) {
  return /^(?:https?:|data:|blob:)/i.test(path.trim()) ? path : convertFileSrc(path);
}
