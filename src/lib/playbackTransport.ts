import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";
import { audioGraph } from "./audioGraph";
import { audioPreferences } from "./audioPreferences";

type Deck = { source: AudioBufferSourceNode; gain: GainNode; buffer: AudioBuffer; start: number; offset: number; key?: string; url: string };
const MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;

/** Media-compatible transport with clock-scheduled PCM successors for local files. */
export class PlaybackTransport extends EventTarget {
  private local = new Audio();
  private stream = new Audio();
  private media = this.local;
  private active: Deck | null = null;
  private successor: Deck | null = null;
  private tails = new Set<Deck>();
  private cached = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer>>();
  private pendingControllers = new Map<string, AbortController>();
  private controller: AbortController | null = null;
  private generation = 0;
  private prepareGeneration = 0;
  private preparedKey = "";
  private sourceUrl = "";
  private offset = 0;
  private stopped = true;
  private decodeAllowed = true;
  private track: Track | null = null;
  private outputVolume = .82;
  private mediaAttached = false;
  private bufferMode = false;
  transitionBlocked = false;
  mode: "native" | "decoded" = "native";

  constructor() {
    super();
    this.local.crossOrigin = "anonymous";
    this.local.preload = this.stream.preload = "auto";
    for (const media of [this.local, this.stream]) for (const type of ["timeupdate", "loadedmetadata", "durationchange", "canplay", "play", "pause", "ended", "error"]) media.addEventListener(type, () => {
      if (this.mode === "native" && this.media === media) this.dispatchEvent(new Event(type));
    });
    window.setInterval(() => {
      if (this.mode !== "decoded" || this.stopped) return;
      this.promoteIfDue();
      this.dispatchEvent(new Event("timeupdate"));
    }, 100);
    audioPreferences.subscribe(() => { this.cancelSuccessor(); this.dispatchEvent(new Event("preferenceschange")); });
  }
  configure(track: Track) { this.track = track; this.decodeAllowed = !/^https?:\/\//i.test(track.path) && track.fileSize <= MAX_FILE_BYTES && (!track.durationMs || track.durationMs <= 900_000); }
  get src() { return this.sourceUrl; }
  set src(url: string) {
    this.release(); this.sourceUrl = url; this.offset = 0; this.bufferMode = false;
    this.media = this.track && /^https?:/i.test(this.track.path) ? this.stream : this.local;
    this.media.src = url;
  }
  get paused() { return this.mode === "decoded" ? this.stopped : this.media.paused; }
  get readyState() { return this.bufferMode ? 4 : this.media.readyState; }
  get duration() { return this.active?.buffer.duration ?? this.cached.get(this.sourceUrl)?.duration ?? this.media.duration; }
  get currentTime() {
    if (this.mode !== "decoded") return this.media.currentTime;
    if (!this.active || this.stopped) return this.offset;
    return Math.min(this.active.buffer.duration, this.active.offset + Math.max(0, audioGraph.ensure().context.currentTime - this.active.start));
  }
  set currentTime(seconds: number) {
    if (!Number.isFinite(seconds)) return;
    if (this.mode !== "decoded") { this.media.currentTime = seconds; return; }
    const playing = !this.stopped;
    const buffer = this.active?.buffer || this.cached.get(this.sourceUrl);
    this.stopDecks(); this.offset = Math.max(0, Math.min(seconds, buffer?.duration || seconds));
    if (playing && buffer) this.startBuffer(buffer, this.offset);
    queueMicrotask(() => this.dispatchEvent(new Event("timeupdate")));
  }
  get volume() { return this.outputVolume; }
  set volume(value: number) { this.outputVolume = value; audioGraph.setVolume(value); this.stream.volume = value; this.local.volume = this.mediaAttached ? 1 : value; }
  get error() { return this.media.error; }
  getAttribute(name: string) { return name === "src" ? this.sourceUrl || null : this.media.getAttribute(name); }
  removeAttribute(name: string) { if (name === "src") { this.release(); this.sourceUrl = ""; } this.media.removeAttribute(name); }
  load() { if (this.mode === "native") this.media.load(); }

  async play() {
    const generation = this.generation;
    const settings = audioPreferences.get();
    if (!this.transitionBlocked && (this.mode === "decoded" || (this.decodeAllowed && (settings.gapless || settings.crossfade > 0)))) {
      try {
        await audioGraph.resume();
        const buffer = this.cached.get(this.sourceUrl) || await this.decode(this.sourceUrl);
        if (generation !== this.generation) return;
        if (!this.stopped && this.active) return;
        this.mode = "decoded"; this.bufferMode = true; this.media.pause();
        this.startBuffer(buffer, this.offset || this.media.currentTime || 0);
        this.dispatchEvent(new Event("loadedmetadata"));
        this.dispatchEvent(new Event("play"));
        return;
      } catch (error) { if (generation !== this.generation || (error instanceof DOMException && error.name === "AbortError")) return; }
    }
    if (generation !== this.generation) return;
    if (this.mode === "decoded") {
      const offset = this.currentTime;
      this.stopDecks(); this.mode = "native"; this.bufferMode = false;
      this.media.src = this.sourceUrl; this.media.load();
      try { this.media.currentTime = offset; } catch { this.media.addEventListener("loadedmetadata", () => { this.media.currentTime = offset; }, { once: true }); }
    }
    this.mode = "native"; this.stopped = false;
    if (this.media === this.local) {
      try { await audioGraph.resume(); audioGraph.attach(this.local); this.mediaAttached = true; this.local.volume = 1; } catch { this.local.volume = this.outputVolume; }
    }
    await this.media.play();
  }
  pause() {
    this.generation++; this.controller?.abort();
    if (this.mode === "native") { this.media.pause(); return; }
    if (this.stopped) return;
    this.offset = this.currentTime; this.stopped = true; this.stopDecks();
    this.dispatchEvent(new Event("pause"));
  }
  prepare(track: Track | null, key: string, allowCrossfade: boolean) {
    if (!track || this.transitionBlocked || this.mode !== "decoded" || this.stopped || !this.active || /^https?:\/\//i.test(track.path) || track.fileSize > MAX_FILE_BYTES || (track.durationMs || 0) > 900_000 || (!audioPreferences.get().gapless && audioPreferences.get().crossfade === 0)) { this.cancelSuccessor(); return; }
    if (this.preparedKey === key) return;
    this.cancelSuccessor(); this.preparedKey = key;
    const revision = this.prepareGeneration;
    const active = this.active;
    const url = /^(blob:|data:)/i.test(track.path) ? track.path : convertFileSrc(track.path);
    void this.decode(url).then((buffer) => {
      if (revision !== this.prepareGeneration || this.active !== active || this.stopped) return;
      const { context, input } = audioGraph.ensure();
      const remaining = active.buffer.duration - this.currentTime;
      if (remaining < .04) return;
      const fade = allowCrossfade ? Math.min(audioPreferences.get().crossfade, remaining / 2, buffer.duration / 2) : 0;
      const when = active.start + active.buffer.duration - active.offset - fade;
      if (when < context.currentTime) return;
      const source = context.createBufferSource(); source.buffer = buffer;
      const gain = context.createGain(); gain.gain.value = fade > 0 ? 0 : 1; source.connect(gain); gain.connect(input);
      if (fade > 0) {
        const outgoing = new Float32Array(48), incoming = new Float32Array(48);
        for (let i = 0; i < 48; i++) { outgoing[i] = Math.cos(i / 47 * Math.PI / 2); incoming[i] = Math.sin(i / 47 * Math.PI / 2); }
        active.gain.gain.cancelScheduledValues(context.currentTime); active.gain.gain.setValueAtTime(1, when);
        active.gain.gain.setValueCurveAtTime(outgoing, when, fade); gain.gain.setValueCurveAtTime(incoming, when, fade);
      }
      const deck: Deck = { source, gain, buffer, start: when, offset: 0, key, url };
      source.onended = () => this.ended(deck);
      this.successor = deck; source.start(when);
    }).catch(() => { /* The active source remains audible; normal next-track loading is the fallback. */ });
  }
  private async decode(url: string): Promise<AudioBuffer> {
    const existing = this.cached.get(url); if (existing) return existing;
    const pending = this.pending.get(url); if (pending && !this.pendingControllers.get(url)?.signal.aborted) return pending;
    const controller = new AbortController(); this.controller = controller;
    const operation = (async () => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("Could not prepare audio");
      const length = Number(response.headers.get("Content-Length"));
      if (length > MAX_FILE_BYTES) throw new Error("Track uses standard playback");
      const bytes = await response.arrayBuffer(); if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("Track uses standard playback");
      const buffer = await audioGraph.ensure().context.decodeAudioData(bytes);
      if (buffer.length * buffer.numberOfChannels * 4 > MAX_DECODED_BYTES) throw new Error("Track uses standard playback");
      for (const cachedUrl of this.cached.keys()) if (cachedUrl !== this.sourceUrl && cachedUrl !== url) this.cached.delete(cachedUrl);
      this.cached.set(url, buffer); return buffer;
    })();
    this.pending.set(url, operation);
    this.pendingControllers.set(url, controller);
    try { return await operation; } finally { if (this.pending.get(url) === operation) { this.pending.delete(url); this.pendingControllers.delete(url); } }
  }
  private startBuffer(buffer: AudioBuffer, offset: number) {
    const { context, input } = audioGraph.ensure();
    const source = context.createBufferSource(); source.buffer = buffer;
    const gain = context.createGain(); source.connect(gain); gain.connect(input);
    const deck: Deck = { source, gain, buffer, offset, start: context.currentTime, url: this.sourceUrl };
    this.active = deck; this.stopped = false; source.onended = () => this.ended(deck); source.start(deck.start, Math.min(offset, Math.max(0, buffer.duration - .001)));
  }
  private promoteIfDue() {
    const successor = this.successor;
    if (!successor || audioGraph.ensure().context.currentTime < successor.start) return;
    if (this.active) this.tails.add(this.active);
    this.active = successor; this.successor = null; this.sourceUrl = successor.url; this.offset = 0; this.preparedKey = "";
    this.dispatchEvent(new CustomEvent("transition", { detail: successor.key }));
  }
  private ended(deck: Deck) {
    this.promoteIfDue();
    this.tails.delete(deck); deck.source.disconnect(); deck.gain.disconnect();
    if (this.active !== deck || this.stopped) return;
    this.offset = deck.buffer.duration; this.active = null; this.stopped = true; this.dispatchEvent(new Event("ended"));
  }
  cancelSuccessor() {
    this.prepareGeneration++; this.preparedKey = "";
    const hadSuccessor = Boolean(this.successor);
    if (this.successor) { const next = this.successor; this.successor = null; next.source.onended = null; try { next.source.stop(); } catch {} next.source.disconnect(); next.gain.disconnect(); }
    if (hadSuccessor && this.active) { const now = audioGraph.ensure().context.currentTime, gain = this.active.gain.gain; if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now); else gain.cancelScheduledValues(0); gain.setTargetAtTime(1, now, .01); }
  }
  private stopDecks() {
    this.cancelSuccessor();
    for (const deck of [...this.tails, ...(this.active ? [this.active] : [])]) { deck.source.onended = null; try { deck.source.stop(); } catch {} deck.source.disconnect(); deck.gain.disconnect(); }
    this.tails.clear(); this.active = null;
  }
  private release() {
    this.generation++; this.controller?.abort(); this.controller = null;
    this.local.pause(); this.stream.pause(); this.stopDecks(); this.stopped = true; this.mode = "native";
  }
}
