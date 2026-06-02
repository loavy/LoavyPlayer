import { convertFileSrc } from "@tauri-apps/api/core";
import type { RepeatMode, RoomPlaybackState, Track } from "../types";

type Listener = () => void;

class AudioEngine {
  private audio = new Audio();
  private listeners = new Set<Listener>();
  private queue: Track[] = [];
  private index = -1;
  private localControlBlocked = false;
  private onBlockedLocalControl: (() => void) | null = null;

  repeat: RepeatMode = "off";
  shuffle = false;
  current: Track | null = null;
  playing = false;
  duration = 0;
  position = 0;
  volume = Number(localStorage.getItem("loavy.volume") || "0.82");

  constructor() {
    this.audio.volume = this.volume;
    this.audio.addEventListener("timeupdate", () => {
      this.position = this.audio.currentTime * 1000;
      this.duration = Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : 0;
      this.emit();
    });
    this.audio.addEventListener("play", () => {
      this.playing = true;
      this.emit();
    });
    this.audio.addEventListener("pause", () => {
      this.playing = false;
      this.emit();
    });
    this.audio.addEventListener("ended", () => {
      if (this.repeat === "one") {
        void this.playTrack(this.current, this.queue, this.index);
      } else {
        void this.next();
      }
    });
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot() {
    return {
      current: this.current,
      playing: this.playing,
      duration: this.duration,
      position: this.position,
      volume: this.volume,
      repeat: this.repeat,
      shuffle: this.shuffle
    };
  }

  async playTrack(track: Track | null, queue = this.queue, index = this.index) {
    if (!track) return;
    if (this.blockLocalControl()) return;
    this.queue = queue;
    this.index = index;
    this.current = track;
    this.audio.src = convertFileSrc(track.path);
    await this.audio.play();
    localStorage.setItem("loavy.lastTrackPath", track.path);
    this.emit();
    this.emitLocalPlaybackChanged();
  }

  async syncToRoomPlayback(track: Track, playback: RoomPlaybackState) {
    const targetPosition = Math.max(0, playback.positionMs);
    const sameTrack = this.current?.id === track.id;

    if (!sameTrack) {
      this.queue = [track];
      this.index = 0;
      this.current = track;
      this.audio.src = convertFileSrc(track.path);
    }

    const driftMs = Math.abs(this.audio.currentTime * 1000 - targetPosition);
    if (!sameTrack || driftMs > 1800) {
      this.audio.currentTime = targetPosition / 1000;
      this.position = targetPosition;
    }

    if (playback.playing) {
      await this.audio.play();
    } else {
      this.audio.pause();
    }

    this.playing = playback.playing;
    this.duration = playback.durationMs || this.duration;
    localStorage.setItem("loavy.lastTrackPath", track.path);
    this.emit();
  }

  async toggle() {
    if (!this.current) return;
    if (this.blockLocalControl()) return;
    if (this.audio.paused) {
      await this.audio.play();
    } else {
      this.audio.pause();
    }
    this.emitLocalPlaybackChanged();
  }

  stop() {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.position = 0;
    this.emit();
  }

  async next() {
    if (!this.queue.length) return;
    const nextIndex = this.shuffle
      ? Math.floor(Math.random() * this.queue.length)
      : this.index + 1;

    if (nextIndex >= this.queue.length) {
      if (this.repeat === "all") {
        await this.playTrack(this.queue[0], this.queue, 0);
      } else {
        this.stop();
      }
      return;
    }

    await this.playTrack(this.queue[nextIndex], this.queue, nextIndex);
  }

  async previous() {
    if (!this.queue.length) return;
    if (this.audio.currentTime > 4) {
      this.audio.currentTime = 0;
      return;
    }
    const prevIndex = Math.max(0, this.index - 1);
    await this.playTrack(this.queue[prevIndex], this.queue, prevIndex);
  }

  seek(ms: number) {
    if (this.blockLocalControl()) return;
    this.audio.currentTime = ms / 1000;
    this.position = ms;
    this.emit();
    this.emitLocalPlaybackChanged();
  }

  setVolume(volume: number) {
    this.volume = volume;
    this.audio.volume = volume;
    localStorage.setItem("loavy.volume", String(volume));
    this.emit();
  }

  setRepeat(repeat: RepeatMode) {
    this.repeat = repeat;
    this.emit();
  }

  setShuffle(shuffle: boolean) {
    this.shuffle = shuffle;
    this.emit();
  }

  setLocalControlBlocked(blocked: boolean, onBlocked?: () => void) {
    this.localControlBlocked = blocked;
    this.onBlockedLocalControl = onBlocked || null;
  }

  setCurrentFavorite(favorite: boolean) {
    if (!this.current) return;
    this.current = { ...this.current, favorite };
    this.queue = this.queue.map((track) => track.id === this.current?.id ? { ...track, favorite } : track);
    this.emit();
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private blockLocalControl() {
    if (!this.localControlBlocked) return false;
    this.onBlockedLocalControl?.();
    return true;
  }

  private emitLocalPlaybackChanged() {
    if (!this.current) return;
    window.dispatchEvent(new CustomEvent("loavy:local-playback-changed", {
      detail: {
        trackId: this.current.id,
        title: this.current.title || this.current.fileName.replace(/\.[^.]+$/, ""),
        artist: this.current.artist || null,
        album: this.current.album || null,
        coverPath: this.current.coverPath || null,
        durationMs: Math.round(this.duration || this.current.durationMs || 0) || null,
        positionMs: Math.round(this.position),
        playing: this.playing,
        hostTimestampMs: Date.now()
      }
    }));
  }
}

export const audioEngine = new AudioEngine();
