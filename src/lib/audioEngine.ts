import { convertFileSrc } from "@tauri-apps/api/core";
import type { RepeatMode, Track } from "../types";

type Listener = () => void;

class AudioEngine {
  private audio = new Audio();
  private listeners = new Set<Listener>();
  private queue: Track[] = [];
  private index = -1;

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
    this.queue = queue;
    this.index = index;
    this.current = track;
    this.audio.src = convertFileSrc(track.path);
    await this.audio.play();
    localStorage.setItem("loavy.lastTrackPath", track.path);
    this.emit();
  }

  async toggle() {
    if (!this.current) return;
    if (this.audio.paused) {
      await this.audio.play();
    } else {
      this.audio.pause();
    }
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
    this.audio.currentTime = ms / 1000;
    this.position = ms;
    this.emit();
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

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}

export const audioEngine = new AudioEngine();
