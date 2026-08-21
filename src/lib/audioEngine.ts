import { convertFileSrc } from "@tauri-apps/api/core";
import type { RepeatMode, RoomPlaybackState, Track } from "../types";

type Listener = () => void;
type TrackInput = Track | readonly Track[];
export type TrackReference = Track | number | string;

export type AudioSnapshot = {
  current: Track | null;
  playing: boolean;
  duration: number;
  position: number;
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  queue: readonly Track[];
  currentIndex: number;
  /** Alias retained for callers that prefer queue-oriented naming. */
  queueIndex: number;
  upNext: readonly Track[];
  localControlBlocked: boolean;
  error: string | null;
};

export type QueueReconciliation = {
  removedEntries: number;
  currentRemoved: boolean;
  queueLength: number;
  currentIndex: number;
};

export type TrackRemovalHandle = Readonly<{
  token: number;
  trackId: number | null;
  path: string | null;
  wasCurrent: boolean;
  wasPlaying: boolean;
}>;

type StoredTrackReference = {
  id: number;
  path: string;
};

type StoredPlaybackSession = {
  version: 1;
  currentTrackId: number;
  currentPath: string;
  queue: StoredTrackReference[];
  index: number;
  positionMs: number;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  explicitNextCount: number;
  savedAt: number;
};

type PendingRemoval = {
  handle: TrackRemovalHandle;
  reference: TrackReference;
  queue: Track[];
  index: number;
  current: Track | null;
  position: number;
  duration: number;
  startedForSource: boolean;
  explicitNextCount: number;
};

const SESSION_VERSION = 1 as const;
export const AUDIO_SESSION_STORAGE_KEY = "loavy.playbackSession";
const LEGACY_LAST_TRACK_KEY = "loavy.lastTrackPath";
const VOLUME_STORAGE_KEY = "loavy.volume";
const DEFAULT_VOLUME = 0.82;
const SESSION_WRITE_INTERVAL_MS = 5_000;
const SEEK_WRITE_DEBOUNCE_MS = 700;
const MAX_PERSISTED_QUEUE_LENGTH = 20_000;
const BLOCKED_MESSAGE = "Playback controls are managed by the Room host.";

class AudioEngine {
  private audio = new Audio();
  private listeners = new Set<Listener>();
  private queue: Track[] = [];
  private index = -1;
  /** Number of contiguous upcoming entries that must play before shuffle resumes. */
  private explicitNextCount = 0;
  private localControlBlocked = false;
  private onBlockedLocalControl: (() => void) | null = null;
  private pendingSeekMs: number | null = null;
  private sessionWriteTimer: number | null = null;
  private seekWriteTimer: number | null = null;
  private lastSessionWriteAt = 0;
  private loadGeneration = 0;
  private startedForSource = false;
  private sourceReleased = false;
  private sessionRestored = false;
  private nextRemovalToken = 1;
  private pendingRemovals = new Map<number, PendingRemoval>();
  private snapshotQueueSource: Track[] | null = null;
  private snapshotQueueIndex = Number.MIN_SAFE_INTEGER;
  private cachedSnapshotQueue: readonly Track[] = [];
  private cachedSnapshotUpNext: readonly Track[] = [];

  repeat: RepeatMode = "off";
  shuffle = false;
  current: Track | null = null;
  playing = false;
  duration = 0;
  position = 0;
  volume = readStoredVolume();
  error: string | null = null;

  constructor() {
    this.audio.volume = this.volume;

    this.audio.addEventListener("timeupdate", () => {
      this.updateDurationFromMedia();
      if (this.pendingSeekMs !== null) {
        this.applyPendingSeek();
      } else if (Number.isFinite(this.audio.currentTime)) {
        this.position = Math.max(0, this.audio.currentTime * 1000);
      }
      this.emit();
      this.scheduleSessionFlush();
    });

    const updateMetadata = () => {
      this.updateDurationFromMedia();
      this.applyPendingSeek();
      this.emit();
    };
    this.audio.addEventListener("loadedmetadata", updateMetadata);
    this.audio.addEventListener("durationchange", updateMetadata);
    this.audio.addEventListener("canplay", () => this.applyPendingSeek());

    this.audio.addEventListener("play", () => {
      this.playing = true;
      this.error = null;
      this.emit();
    });

    this.audio.addEventListener("pause", () => {
      this.playing = false;
      if (this.pendingSeekMs === null && Number.isFinite(this.audio.currentTime)) {
        this.position = Math.max(0, this.audio.currentTime * 1000);
      }
      this.emit();
      this.flushSession();
    });

    this.audio.addEventListener("ended", () => {
      this.playing = false;
      if (this.duration > 0) this.position = this.duration;
      if (this.repeat === "one") {
        void this.replayCurrent();
      } else {
        void this.next();
      }
    });

    this.audio.addEventListener("error", () => {
      if (this.sourceReleased || !this.audio.getAttribute("src")) return;
      this.reportPlaybackError(describeMediaError(this.audio.error));
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flushSession();
    });
    window.addEventListener("pagehide", () => this.flushSession());
    window.addEventListener("beforeunload", () => this.flushSession());
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): AudioSnapshot {
    if (this.snapshotQueueSource !== this.queue || this.snapshotQueueIndex !== this.index) {
      this.snapshotQueueSource = this.queue;
      this.snapshotQueueIndex = this.index;
      this.cachedSnapshotQueue = this.queue.slice();
      this.cachedSnapshotUpNext = this.cachedSnapshotQueue.slice(Math.max(0, this.index + 1));
    }
    return {
      current: this.current,
      playing: this.playing,
      duration: this.duration,
      position: this.position,
      volume: this.volume,
      repeat: this.repeat,
      shuffle: this.shuffle,
      queue: this.cachedSnapshotQueue,
      currentIndex: this.index,
      queueIndex: this.index,
      upNext: this.cachedSnapshotUpNext,
      localControlBlocked: this.localControlBlocked,
      error: this.error
    };
  }

  /**
   * Restores a persisted session exactly once, using the supplied full library as
   * the authority. The selected track is loaded but playback always remains paused.
   */
  restoreSession(canonicalTracks: readonly Track[]): boolean {
    if (this.sessionRestored) {
      this.reconcileQueue(canonicalTracks);
      return Boolean(this.current);
    }
    this.sessionRestored = true;

    const canonical = buildCanonicalTrackLookup(canonicalTracks);
    const stored = readStoredSession();
    let current = stored
      ? canonical.byPath.get(normalizePath(stored.currentPath))
        || canonical.byId.get(stored.currentTrackId)
        || null
      : null;
    let restoredQueue: Track[] = [];
    let restoredIndex = -1;
    let restoredPosition = 0;
    let restoredExplicitNextCount = 0;

    if (stored && current) {
      for (let storedIndex = 0; storedIndex < stored.queue.length; storedIndex += 1) {
        const reference = stored.queue[storedIndex];
        const track = canonicalTrackForReference(reference, canonical);
        if (!track) continue;
        if (storedIndex === stored.index && sameTrack(track, current)) {
          restoredIndex = restoredQueue.length;
        }
        if (
          storedIndex > stored.index
          && storedIndex <= stored.index + stored.explicitNextCount
        ) {
          restoredExplicitNextCount += 1;
        }
        restoredQueue.push(track);
      }

      if (restoredIndex < 0) {
        restoredIndex = restoredQueue.findIndex((track) => sameTrack(track, current!));
      }
      if (restoredIndex < 0) {
        restoredIndex = clampInteger(stored.index, 0, restoredQueue.length);
        restoredQueue.splice(restoredIndex, 0, current);
      }

      restoredPosition = clampPosition(stored.positionMs, current.durationMs);
      this.shuffle = stored.shuffle;
      this.repeat = stored.repeat;
      this.applyVolume(stored.volume);
    }

    if (!current) {
      const legacyPath = safeStorageGet(LEGACY_LAST_TRACK_KEY);
      current = legacyPath ? canonical.byPath.get(normalizePath(legacyPath)) || null : null;
      if (current) {
        restoredQueue = [current];
        restoredIndex = 0;
        restoredExplicitNextCount = 0;
      }
    }

    if (!current) {
      this.clearSession();
      return false;
    }

    this.explicitNextCount = clampExplicitNextCount(
      restoredExplicitNextCount,
      restoredQueue.length,
      restoredIndex
    );
    this.loadTrackPaused(current, restoredQueue, restoredIndex, restoredPosition, false);
    this.flushSession();
    return true;
  }

  flushSession() {
    if (this.sessionWriteTimer !== null) {
      window.clearTimeout(this.sessionWriteTimer);
      this.sessionWriteTimer = null;
    }
    if (this.seekWriteTimer !== null) {
      window.clearTimeout(this.seekWriteTimer);
      this.seekWriteTimer = null;
    }

    const now = Date.now();
    this.lastSessionWriteAt = now;
    const current = this.current;

    if (!current) {
      // Do not destroy a saved session if the window closes before the initial
      // library request has had a chance to validate and restore it.
      if (!this.sessionRestored) return;
      safeStorageRemove(AUDIO_SESSION_STORAGE_KEY);
      safeStorageRemove(LEGACY_LAST_TRACK_KEY);
      return;
    }

    // A Room stream must never replace the user's last valid local session.
    if (!isPersistableTrack(current)) return;

    const persistedQueue: StoredTrackReference[] = [];
    let persistedIndex = -1;
    let persistedExplicitNextCount = 0;
    const explicitNextEnd = this.index + this.explicitNextCount;
    for (let queueIndex = 0; queueIndex < this.queue.length; queueIndex += 1) {
      const track = this.queue[queueIndex];
      if (!isPersistableTrack(track)) continue;
      if (queueIndex === this.index) persistedIndex = persistedQueue.length;
      if (queueIndex > this.index && queueIndex <= explicitNextEnd) {
        persistedExplicitNextCount += 1;
      }
      persistedQueue.push({ id: track.id, path: track.path });
    }

    if (persistedIndex < 0) {
      persistedIndex = persistedQueue.findIndex((track) =>
        track.id === current.id && normalizePath(track.path) === normalizePath(current.path)
      );
    }
    if (persistedIndex < 0) {
      persistedIndex = clampInteger(this.index, 0, persistedQueue.length);
      persistedQueue.splice(persistedIndex, 0, { id: current.id, path: current.path });
    }

    let queueToStore = persistedQueue;
    let indexToStore = persistedIndex;
    if (persistedQueue.length > MAX_PERSISTED_QUEUE_LENGTH) {
      const desiredHistory = Math.floor(MAX_PERSISTED_QUEUE_LENGTH * 0.2);
      const start = clampInteger(
        persistedIndex - desiredHistory,
        0,
        persistedQueue.length - MAX_PERSISTED_QUEUE_LENGTH
      );
      queueToStore = persistedQueue.slice(start, start + MAX_PERSISTED_QUEUE_LENGTH);
      indexToStore = persistedIndex - start;
    }
    const explicitNextCountToStore = clampExplicitNextCount(
      persistedExplicitNextCount,
      queueToStore.length,
      indexToStore
    );

    const session: StoredPlaybackSession = {
      version: SESSION_VERSION,
      currentTrackId: current.id,
      currentPath: current.path,
      queue: queueToStore,
      index: indexToStore,
      positionMs: Math.max(0, Math.round(this.position)),
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: this.volume,
      explicitNextCount: explicitNextCountToStore,
      savedAt: now
    };
    safeStorageSet(AUDIO_SESSION_STORAGE_KEY, JSON.stringify(session));
    safeStorageSet(LEGACY_LAST_TRACK_KEY, current.path);
  }

  clearSession() {
    if (this.sessionWriteTimer !== null) {
      window.clearTimeout(this.sessionWriteTimer);
      this.sessionWriteTimer = null;
    }
    if (this.seekWriteTimer !== null) {
      window.clearTimeout(this.seekWriteTimer);
      this.seekWriteTimer = null;
    }
    safeStorageRemove(AUDIO_SESSION_STORAGE_KEY);
    safeStorageRemove(LEGACY_LAST_TRACK_KEY);
  }

  async playTrack(track: Track | null, queue: readonly Track[] = this.queue, index = this.index): Promise<boolean> {
    if (!track || this.blockLocalControl()) return false;
    return this.playTrackInternal(track, queue, index, true, 0, true);
  }

  async syncToRoomPlayback(track: Track, playback: RoomPlaybackState): Promise<boolean> {
    const targetPosition = Math.max(0, finiteNumber(playback.positionMs, 0));
    const sameCurrentTrack = this.current?.id === track.id;

    if (!sameCurrentTrack) {
      // Preserve the prior local session before a transient Room source replaces it.
      this.flushSession();
      this.explicitNextCount = 0;
      this.loadTrackPaused(track, [track], 0, targetPosition, true);
    }

    const mediaPosition = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime * 1000 : this.position;
    const driftMs = Math.abs(mediaPosition - targetPosition);
    if (!sameCurrentTrack || driftMs > 1_800) {
      this.setPendingSeek(targetPosition);
    }

    if (playback.durationMs && playback.durationMs > 0) {
      this.duration = playback.durationMs;
    }
    this.startedForSource = true;

    let success = true;
    if (playback.playing) {
      success = await this.startCurrentPlayback(this.loadGeneration, false, false);
    } else {
      this.audio.pause();
      this.playing = false;
    }

    this.playing = playback.playing && success;
    this.emit();
    // No local-playback event here: Room synchronization must not echo to the host.
    return success;
  }

  async toggle(): Promise<boolean> {
    if (!this.current || this.blockLocalControl()) return false;
    if (this.audio.paused || !this.playing) {
      if (this.sourceReleased) {
        this.loadTrackPaused(this.current, this.queue, this.index, this.position, this.startedForSource);
      }
      const success = await this.startCurrentPlayback(this.loadGeneration, true, true);
      if (success) this.flushSession();
      return success;
    }

    this.audio.pause();
    this.playing = false;
    this.flushSession();
    this.emitLocalPlaybackChanged();
    return true;
  }

  stop(): boolean {
    if (!this.current || this.blockLocalControl()) return false;
    this.stopInternal(true);
    return true;
  }

  async next(): Promise<boolean> {
    if (!this.queue.length || this.blockLocalControl()) return false;

    this.explicitNextCount = clampExplicitNextCount(
      this.explicitNextCount,
      this.queue.length,
      this.index
    );
    const nextExplicitNextCount = Math.max(0, this.explicitNextCount - 1);
    const nextIndex = this.index + 1;

    if (nextIndex >= this.queue.length) {
      if (this.repeat === "all") {
        if (this.shuffle) {
          const nextCycle = materializeShuffleCycle(this.queue, this.index);
          return this.playTrackInternal(nextCycle[0], nextCycle, 0, true, 0);
        }
        return this.playTrackInternal(this.queue[0], this.queue, 0, true, 0);
      }
      this.stopInternal(true);
      return true;
    }

    return this.playTrackInternal(
      this.queue[nextIndex],
      this.queue,
      nextIndex,
      true,
      nextExplicitNextCount
    );
  }

  async previous(): Promise<boolean> {
    if (!this.queue.length || this.blockLocalControl()) return false;
    if (this.audio.currentTime > 4 || this.position > 4_000) {
      this.seekInternal(0, true);
      this.flushSession();
      return true;
    }
    const previousIndex = Math.max(0, this.index - 1);
    const carriedExplicitNextCount = this.explicitNextCount + Math.max(0, this.index - previousIndex);
    return this.playTrackInternal(
      this.queue[previousIndex],
      this.queue,
      previousIndex,
      true,
      carriedExplicitNextCount
    );
  }

  seek(ms: number): boolean {
    if (!this.current || this.blockLocalControl()) return false;
    this.seekInternal(ms, true);
    return true;
  }

  /** Immediately persists the final position after a pointer or keyboard seek gesture. */
  commitSeek(): boolean {
    if (!this.current || this.localControlBlocked) return false;
    this.flushSession();
    return true;
  }

  setVolume(volume: number): boolean {
    const nextVolume = clampVolume(volume, this.volume);
    this.applyVolume(nextVolume);
    safeStorageSet(VOLUME_STORAGE_KEY, String(nextVolume));
    this.emit();
    this.flushSession();
    return true;
  }

  setRepeat(repeat: RepeatMode): boolean {
    if (this.blockLocalControl()) return false;
    if (!isRepeatMode(repeat)) return false;
    this.repeat = repeat;
    this.emit();
    this.flushSession();
    return true;
  }

  setShuffle(shuffle: boolean): boolean {
    if (this.blockLocalControl()) return false;
    const nextShuffle = Boolean(shuffle);
    if (nextShuffle && !this.shuffle) {
      // Shuffle is represented directly in the visible queue, so advancing never
      // skips over rows that the drawer presented as next up.
      this.queue = materializeShuffleUpcoming(this.queue, this.index, this.explicitNextCount);
    }
    this.shuffle = nextShuffle;
    this.emit();
    this.flushSession();
    return true;
  }

  replaceQueue(queue: readonly Track[]): boolean {
    if (this.blockLocalControl()) return false;
    const nextQueue = queue.slice();
    if (!this.current) {
      this.queue = this.shuffle ? materializeShuffleUpcoming(nextQueue, -1, 0) : nextQueue;
      this.index = -1;
      this.explicitNextCount = 0;
      this.emit();
      this.flushSession();
      return true;
    }

    const nextIndex = findMatchingTrackIndex(nextQueue, this.current, this.index);
    if (nextIndex < 0) return false;
    this.queue = this.shuffle ? materializeShuffleUpcoming(nextQueue, nextIndex, 0) : nextQueue;
    this.index = nextIndex;
    this.current = this.queue[nextIndex];
    this.explicitNextCount = 0;
    this.emit();
    this.flushSession();
    return true;
  }

  playNext(input: TrackInput): boolean {
    if (this.blockLocalControl()) return false;
    const additions = tracksFromInput(input);
    if (!additions.length) return false;
    this.explicitNextCount = clampExplicitNextCount(
      this.explicitNextCount,
      this.queue.length,
      this.index
    );
    const insertAt = clampInteger(
      this.index + 1 + this.explicitNextCount,
      0,
      this.queue.length
    );
    this.queue = [
      ...this.queue.slice(0, insertAt),
      ...additions,
      ...this.queue.slice(insertAt)
    ];
    this.explicitNextCount += additions.length;
    this.emit();
    this.flushSession();
    return true;
  }

  addToQueue(input: TrackInput): boolean {
    if (this.blockLocalControl()) return false;
    const additions = tracksFromInput(input);
    if (!additions.length) return false;
    this.queue = [...this.queue, ...additions];
    this.emit();
    this.flushSession();
    return true;
  }

  appendToQueue(input: TrackInput): boolean {
    return this.addToQueue(input);
  }

  /** Removes an upcoming item by its absolute index in snapshot.queue. */
  removeFromQueue(queueIndex: number): boolean {
    if (this.blockLocalControl()) return false;
    if (!Number.isInteger(queueIndex) || queueIndex <= this.index || queueIndex >= this.queue.length) return false;
    const explicitNextEnd = this.index + this.explicitNextCount;
    this.queue = this.queue.filter((_, index) => index !== queueIndex);
    if (queueIndex <= explicitNextEnd) {
      this.explicitNextCount = Math.max(0, this.explicitNextCount - 1);
    }
    this.emit();
    this.flushSession();
    return true;
  }

  /** Reorders upcoming items using absolute indexes in snapshot.queue. */
  moveQueueItem(fromQueueIndex: number, toQueueIndex: number): boolean {
    if (this.blockLocalControl()) return false;
    if (!Number.isInteger(fromQueueIndex) || !Number.isInteger(toQueueIndex)) return false;
    const firstUpcoming = this.index + 1;
    if (
      fromQueueIndex < firstUpcoming ||
      toQueueIndex < firstUpcoming ||
      fromQueueIndex >= this.queue.length ||
      toQueueIndex >= this.queue.length ||
      fromQueueIndex === toQueueIndex
    ) return false;

    const nextQueue = this.queue.slice();
    const [moved] = nextQueue.splice(fromQueueIndex, 1);
    nextQueue.splice(toQueueIndex, 0, moved);
    this.queue = nextQueue;
    this.emit();
    this.flushSession();
    return true;
  }

  clearUpcoming(): boolean {
    if (this.blockLocalControl()) return false;
    const nextQueue = this.current ? [this.current] : [];
    if (
      this.queue.length === nextQueue.length
      && (!this.current || (this.index === 0 && sameTrack(this.queue[0], this.current)))
    ) return false;
    // Collapse history as well as the future. Otherwise shuffle/repeat-all could
    // interpret a historical entry as the next candidate after a clear.
    this.queue = nextQueue;
    this.index = this.current ? 0 : -1;
    this.explicitNextCount = 0;
    this.emit();
    this.flushSession();
    return true;
  }

  async playQueuedItem(queueIndex: number): Promise<boolean> {
    if (this.blockLocalControl()) return false;
    if (!Number.isInteger(queueIndex) || queueIndex < 0 || queueIndex >= this.queue.length) return false;
    const explicitNextEnd = this.index + this.explicitNextCount;
    const remainingExplicit = queueIndex > this.index && queueIndex <= explicitNextEnd
      ? explicitNextEnd - queueIndex
      : 0;
    return this.playTrackInternal(
      this.queue[queueIndex],
      this.queue,
      queueIndex,
      true,
      remainingExplicit
    );
  }

  /**
   * Replaces local queue objects with current canonical records and drops stale
   * local entries. Transient Room tracks are deliberately preserved in memory.
   */
  reconcileQueue(canonicalTracks: readonly Track[]): QueueReconciliation {
    const canonical = buildCanonicalTrackLookup(canonicalTracks);
    const previousQueue = this.queue;
    const previousIndex = this.index;
    const previousExplicitNextEnd = previousIndex + this.explicitNextCount;
    const nextQueue: Track[] = [];
    let mappedCurrentIndex = -1;
    let remainingBeforeCurrent = 0;
    let mappedExplicitNextCount = 0;
    let removedEntries = 0;

    for (let queueIndex = 0; queueIndex < previousQueue.length; queueIndex += 1) {
      const queuedTrack = previousQueue[queueIndex];
      const replacement = isRemoteTrack(queuedTrack)
        ? queuedTrack
        : canonicalTrackForTrack(queuedTrack, canonical);
      if (!replacement) {
        removedEntries += 1;
        continue;
      }
      if (queueIndex === previousIndex) mappedCurrentIndex = nextQueue.length;
      if (queueIndex < previousIndex) remainingBeforeCurrent += 1;
      if (queueIndex > previousIndex && queueIndex <= previousExplicitNextEnd) {
        mappedExplicitNextCount += 1;
      }
      nextQueue.push(replacement);
    }

    let currentRemoved = false;
    let nextCurrent = this.current;
    if (this.current && !isRemoteTrack(this.current)) {
      nextCurrent = canonicalTrackForTrack(this.current, canonical);
      currentRemoved = !nextCurrent;
    }

    if (currentRemoved) {
      const replacementIndex = nextQueue.length
        ? clampInteger(remainingBeforeCurrent, 0, nextQueue.length - 1)
        : -1;
      this.releaseMediaSource();
      this.explicitNextCount = Math.max(0, mappedExplicitNextCount - (replacementIndex >= 0 ? 1 : 0));
      if (replacementIndex >= 0) {
        this.loadTrackPaused(nextQueue[replacementIndex], nextQueue, replacementIndex, 0, false);
      } else {
        this.queue = nextQueue;
        this.index = -1;
        this.current = null;
        this.position = 0;
        this.duration = 0;
        this.playing = false;
        this.explicitNextCount = 0;
        this.sourceReleased = true;
        this.emit();
      }
    } else {
      const previousCurrent = this.current;
      const sourcePathChanged = Boolean(
        previousCurrent
        && nextCurrent
        && !isRemoteTrack(previousCurrent)
        && !sameSourcePath(previousCurrent.path, nextCurrent.path)
      );
      const wasPlaying = this.playing;
      const preservedPosition = this.position;
      const sourceWasStarted = this.startedForSource;
      this.queue = nextQueue;
      this.current = nextCurrent;
      if (nextCurrent) {
        if (mappedCurrentIndex < 0 || !sameTrack(nextQueue[mappedCurrentIndex], nextCurrent)) {
          mappedCurrentIndex = findMatchingTrackIndex(nextQueue, nextCurrent, previousIndex);
        }
        if (mappedCurrentIndex < 0) {
          mappedCurrentIndex = clampInteger(previousIndex, 0, nextQueue.length);
          nextQueue.splice(mappedCurrentIndex, 0, nextCurrent);
        }
      }
      this.index = nextCurrent ? mappedCurrentIndex : -1;
      this.explicitNextCount = nextCurrent
        ? clampExplicitNextCount(mappedExplicitNextCount, nextQueue.length, mappedCurrentIndex)
        : 0;
      if (sourcePathChanged && nextCurrent) {
        this.loadTrackPaused(
          nextCurrent,
          nextQueue,
          mappedCurrentIndex,
          preservedPosition,
          sourceWasStarted
        );
        if (wasPlaying) {
          const generation = this.loadGeneration;
          void this.startCurrentPlayback(generation, false, true).then(() => this.flushSession());
        }
      } else {
        this.emit();
      }
    }

    this.flushSession();
    return {
      removedEntries,
      currentRemoved,
      queueLength: this.queue.length,
      currentIndex: this.index
    };
  }

  /**
   * Releases the current media file before a native delete/recycle operation.
   * Commit on success or roll back to restore the source and prior position.
   */
  prepareTrackRemoval(reference: TrackReference): TrackRemovalHandle | null {
    const wasCurrent = Boolean(this.current && trackMatchesReference(this.current, reference));
    const isQueued = this.queue.some((track) => trackMatchesReference(track, reference));
    if (!wasCurrent && !isQueued) return null;

    const handle: TrackRemovalHandle = Object.freeze({
      token: this.nextRemovalToken++,
      trackId: typeof reference === "number" ? reference : typeof reference === "string" ? null : reference.id,
      path: typeof reference === "string" ? reference : typeof reference === "number" ? null : reference.path,
      wasCurrent,
      wasPlaying: wasCurrent && this.playing
    });
    this.pendingRemovals.set(handle.token, {
      handle,
      reference,
      queue: this.queue.slice(),
      index: this.index,
      current: this.current,
      position: this.position,
      duration: this.duration,
      startedForSource: this.startedForSource,
      explicitNextCount: this.explicitNextCount
    });

    if (wasCurrent) {
      this.flushSession();
      this.releaseMediaSource();
      this.emit();
    }
    return handle;
  }

  async commitTrackRemoval(
    handle: TrackRemovalHandle,
    options: { playNext?: boolean } = {}
  ): Promise<boolean> {
    const pending = this.pendingRemovals.get(handle.token);
    if (!pending) return false;
    this.pendingRemovals.delete(handle.token);

    const previousQueue = this.queue;
    const previousIndex = this.index;
    const retainedExplicitNextCount = previousQueue
      .slice(previousIndex + 1, previousIndex + 1 + this.explicitNextCount)
      .filter((track) => !trackMatchesReference(track, pending.reference)).length;
    const removingCurrent = Boolean(this.current && trackMatchesReference(this.current, pending.reference));
    const remainingBeforeCurrent = previousQueue
      .slice(0, Math.max(0, previousIndex))
      .filter((track) => !trackMatchesReference(track, pending.reference)).length;
    const nextQueue = previousQueue.filter((track) => !trackMatchesReference(track, pending.reference));

    if (removingCurrent) {
      this.current = null;
      this.queue = nextQueue;
      this.index = -1;
      this.position = 0;
      this.duration = 0;
      this.playing = false;
      this.pendingSeekMs = null;
      this.explicitNextCount = 0;

      if (nextQueue.length) {
        const nextIndex = clampInteger(remainingBeforeCurrent, 0, nextQueue.length - 1);
        this.explicitNextCount = Math.max(0, retainedExplicitNextCount - (retainedExplicitNextCount > 0 ? 1 : 0));
        const shouldPlayNext = options.playNext ?? pending.handle.wasPlaying;
        if (shouldPlayNext) {
          const success = await this.playTrackInternal(
            nextQueue[nextIndex],
            nextQueue,
            nextIndex,
            true,
            this.explicitNextCount
          );
          if (!success) this.flushSession();
          return true;
        }
        this.loadTrackPaused(nextQueue[nextIndex], nextQueue, nextIndex, 0, false);
      } else {
        this.sourceReleased = true;
        this.emit();
      }
    } else {
      this.queue = nextQueue;
      this.explicitNextCount = retainedExplicitNextCount;
      if (this.current) {
        this.index = findMatchingTrackIndex(nextQueue, this.current, previousIndex);
        if (this.index < 0) {
          this.current = null;
          this.position = 0;
          this.duration = 0;
          this.playing = false;
          this.explicitNextCount = 0;
        }
      } else {
        this.index = -1;
        this.explicitNextCount = 0;
      }
      this.emit();
    }

    this.flushSession();
    return true;
  }

  async rollbackTrackRemoval(handle: TrackRemovalHandle): Promise<boolean> {
    const pending = this.pendingRemovals.get(handle.token);
    if (!pending) return false;
    this.pendingRemovals.delete(handle.token);
    if (!pending.handle.wasCurrent || !pending.current) return true;

    this.explicitNextCount = pending.explicitNextCount;
    this.loadTrackPaused(
      pending.current,
      pending.queue,
      pending.index,
      pending.position,
      pending.startedForSource
    );
    this.duration = pending.duration || this.duration;
    if (pending.handle.wasPlaying) {
      await this.startCurrentPlayback(this.loadGeneration, false, true);
    }
    this.flushSession();
    return true;
  }

  async removeTrack(
    reference: TrackReference,
    options: { playNext?: boolean } = {}
  ): Promise<boolean> {
    const handle = this.prepareTrackRemoval(reference);
    if (!handle) return false;
    return this.commitTrackRemoval(handle, options);
  }

  setLocalControlBlocked(blocked: boolean, onBlocked?: () => void) {
    const changed = this.localControlBlocked !== blocked;
    this.localControlBlocked = blocked;
    this.onBlockedLocalControl = onBlocked || null;
    if (!blocked && this.error === BLOCKED_MESSAGE) this.error = null;
    if (changed) this.emit();
  }

  setCurrentFavorite(favorite: boolean) {
    const trackId = this.current?.id;
    if (trackId === undefined) return;
    this.patchTrackFavorite(trackId, favorite);
  }

  /** Patches every queued copy without allowing a stale async result to affect a new current track. */
  patchTrackFavorite(trackId: number, favorite: boolean): boolean {
    if (!Number.isInteger(trackId)) return false;

    let changed = false;
    if (this.current?.id === trackId && this.current.favorite !== favorite) {
      this.current = { ...this.current, favorite };
      changed = true;
    }

    let queueChanged = false;
    const nextQueue = this.queue.map((track) => {
      if (track.id !== trackId || track.favorite === favorite) return track;
      queueChanged = true;
      return { ...track, favorite };
    });
    if (queueChanged) {
      this.queue = nextQueue;
      changed = true;
    }

    if (changed) this.emit();
    return changed;
  }

  clearError() {
    if (!this.error) return;
    this.error = null;
    this.emit();
  }

  private async replayCurrent(): Promise<boolean> {
    if (!this.current || this.blockLocalControl()) return false;
    return this.playTrackInternal(
      this.current,
      this.queue,
      this.index,
      true,
      this.explicitNextCount
    );
  }

  private async playTrackInternal(
    track: Track,
    queue: readonly Track[],
    requestedIndex: number,
    broadcast: boolean,
    explicitNextCount = 0,
    materializeShuffle = false
  ): Promise<boolean> {
    // From this point onward a missing current track represents an intentional
    // playback state, not an app that simply has not restored yet.
    this.sessionRestored = true;
    this.flushSession();
    const normalized = normalizeQueueForTrack(track, queue, requestedIndex);
    const materialized = this.shuffle && materializeShuffle
      ? materializeShuffleContext(normalized.queue, normalized.index)
      : normalized;
    this.explicitNextCount = clampExplicitNextCount(
      explicitNextCount,
      materialized.queue.length,
      materialized.index
    );
    this.loadTrackPaused(
      materialized.queue[materialized.index],
      materialized.queue,
      materialized.index,
      0,
      false
    );
    const success = await this.startCurrentPlayback(this.loadGeneration, true, broadcast);
    if (success) this.flushSession();
    return success;
  }

  private loadTrackPaused(
    track: Track,
    queue: readonly Track[],
    index: number,
    positionMs: number,
    startedForSource: boolean
  ) {
    this.audio.pause();
    this.loadGeneration += 1;
    this.queue = queue.slice();
    this.index = index;
    this.current = track;
    this.playing = false;
    this.error = null;
    this.position = Math.max(0, finiteNumber(positionMs, 0));
    this.duration = Math.max(0, finiteNumber(track.durationMs, 0));
    this.pendingSeekMs = this.position;
    this.startedForSource = startedForSource;
    this.sourceReleased = false;

    try {
      this.audio.src = audioSource(track.path);
      this.audio.load();
      this.applyPendingSeek();
    } catch (error) {
      this.reportPlaybackError(`Could not load this track: ${errorMessage(error)}`);
    }
    this.emit();
  }

  private async startCurrentPlayback(
    generation: number,
    markTrackStarted: boolean,
    broadcast: boolean
  ): Promise<boolean> {
    if (!this.current || generation !== this.loadGeneration) return false;
    try {
      await this.audio.play();
      if (generation !== this.loadGeneration || !this.current) return false;
      this.playing = !this.audio.paused;
      this.error = null;
      if (this.playing && markTrackStarted && !this.startedForSource) {
        this.startedForSource = true;
        this.emitTrackStarted(this.current);
      }
      this.emit();
      if (broadcast) this.emitLocalPlaybackChanged();
      return this.playing;
    } catch (error) {
      if (generation !== this.loadGeneration) return false;
      this.playing = false;
      this.reportPlaybackError(`Could not play this track: ${errorMessage(error)}`);
      return false;
    }
  }

  private stopInternal(broadcast: boolean) {
    this.audio.pause();
    this.pendingSeekMs = null;
    try {
      this.audio.currentTime = 0;
    } catch {
      // A not-yet-loaded or non-seekable stream can reject a reset.
    }
    this.position = 0;
    this.playing = false;
    this.startedForSource = false;
    this.emit();
    this.flushSession();
    if (broadcast) this.emitLocalPlaybackChanged();
  }

  private seekInternal(ms: number, broadcast: boolean) {
    const nextPosition = clampPosition(ms, this.duration || this.current?.durationMs);
    this.setPendingSeek(nextPosition);
    this.emit();
    this.scheduleSeekSessionFlush();
    if (broadcast) this.emitLocalPlaybackChanged();
  }

  private setPendingSeek(ms: number) {
    this.pendingSeekMs = Math.max(0, finiteNumber(ms, 0));
    this.position = this.pendingSeekMs;
    this.applyPendingSeek();
  }

  private applyPendingSeek(): boolean {
    if (this.pendingSeekMs === null || this.sourceReleased) return false;
    const targetMs = clampPosition(this.pendingSeekMs, this.duration || this.current?.durationMs);
    if (targetMs === 0 && this.audio.readyState === 0) {
      this.position = 0;
      return false;
    }
    try {
      this.audio.currentTime = targetMs / 1000;
      this.position = targetMs;
      this.pendingSeekMs = null;
      return true;
    } catch {
      // loadedmetadata/canplay will retry once the media becomes seekable.
      return false;
    }
  }

  private updateDurationFromMedia() {
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
      this.duration = this.audio.duration * 1000;
    } else if (!this.duration && this.current?.durationMs) {
      this.duration = this.current.durationMs;
    }
  }

  private applyVolume(volume: number) {
    const nextVolume = clampVolume(volume, DEFAULT_VOLUME);
    this.volume = nextVolume;
    try {
      this.audio.volume = nextVolume;
    } catch {
      this.volume = DEFAULT_VOLUME;
      this.audio.volume = DEFAULT_VOLUME;
    }
    safeStorageSet(VOLUME_STORAGE_KEY, String(this.volume));
  }

  private releaseMediaSource() {
    this.sourceReleased = true;
    this.loadGeneration += 1;
    this.pendingSeekMs = null;
    this.audio.pause();
    this.playing = false;
    try {
      this.audio.removeAttribute("src");
      this.audio.load();
    } catch {
      // Releasing is best-effort; pausing still drops active playback.
    }
  }

  private scheduleSessionFlush() {
    if (!this.current || !isPersistableTrack(this.current) || this.sessionWriteTimer !== null) return;
    const elapsed = Date.now() - this.lastSessionWriteAt;
    if (elapsed >= SESSION_WRITE_INTERVAL_MS) {
      this.flushSession();
      return;
    }
    this.sessionWriteTimer = window.setTimeout(() => {
      this.sessionWriteTimer = null;
      this.flushSession();
    }, SESSION_WRITE_INTERVAL_MS - elapsed);
  }

  private scheduleSeekSessionFlush() {
    if (this.seekWriteTimer !== null) window.clearTimeout(this.seekWriteTimer);
    this.seekWriteTimer = window.setTimeout(() => {
      this.seekWriteTimer = null;
      this.flushSession();
    }, SEEK_WRITE_DEBOUNCE_MS);
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  private blockLocalControl() {
    if (!this.localControlBlocked) return false;
    this.error = BLOCKED_MESSAGE;
    this.onBlockedLocalControl?.();
    this.emit();
    return true;
  }

  private reportPlaybackError(message: string) {
    this.error = message;
    this.playing = false;
    this.emit();
    window.dispatchEvent(new CustomEvent("loavy:playback-error", {
      detail: {
        message,
        trackId: this.current?.id ?? null,
        path: this.current?.path ?? null
      }
    }));
  }

  private emitTrackStarted(track: Track) {
    if (!isPersistableTrack(track)) return;
    window.dispatchEvent(new CustomEvent("loavy:track-started", {
      detail: {
        trackId: track.id,
        path: track.path,
        startedAt: Date.now()
      }
    }));
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

export function isRemoteTrack(track: Track) {
  return track.id <= 0 || track.fileExt.toLowerCase() === "stream" || isRemotePath(track.path);
}

function isPersistableTrack(track: Track) {
  return track.id > 0 && !isRemoteTrack(track);
}

function isRemotePath(path: string) {
  return /^(?:https?:|blob:|data:)/i.test(path.trim());
}

function audioSource(path: string) {
  return isRemotePath(path) ? path : convertFileSrc(path);
}

function tracksFromInput(input: TrackInput): Track[] {
  return Array.isArray(input) ? input.slice() : [input as Track];
}

/** Keeps history/current and explicit-next entries fixed while shuffling the visible remainder. */
function materializeShuffleUpcoming(
  queue: readonly Track[],
  currentIndex: number,
  explicitNextCount: number
) {
  const nextQueue = queue.slice();
  const fixedThrough = clampInteger(
    currentIndex + explicitNextCount,
    -1,
    nextQueue.length - 1
  );
  shuffleRange(nextQueue, fixedThrough + 1);
  return nextQueue;
}

/** Makes a newly selected context one complete, visible shuffle cycle. */
function materializeShuffleContext(queue: readonly Track[], currentIndex: number) {
  if (currentIndex < 0 || currentIndex >= queue.length) {
    return { queue: materializeShuffleUpcoming(queue, -1, 0), index: -1 };
  }
  const selected = queue[currentIndex];
  const upcoming = queue.filter((_, queueIndex) => queueIndex !== currentIndex);
  shuffleRange(upcoming, 0);
  return { queue: [selected, ...upcoming], index: 0 };
}

/** Starts a new shuffle cycle without immediately choosing the just-finished entry again. */
function materializeShuffleCycle(queue: readonly Track[], currentIndex: number) {
  if (!queue.length) return [];
  if (currentIndex < 0 || currentIndex >= queue.length) {
    return materializeShuffleUpcoming(queue, -1, 0);
  }
  const previousCurrent = queue[currentIndex];
  const nextQueue = queue.filter((_, queueIndex) => queueIndex !== currentIndex);
  shuffleRange(nextQueue, 0);
  nextQueue.push(previousCurrent);
  return nextQueue;
}

function shuffleRange<T>(items: T[], startIndex: number) {
  const start = clampInteger(startIndex, 0, items.length);
  for (let index = items.length - 1; index > start; index -= 1) {
    const swapIndex = start + Math.floor(Math.random() * (index - start + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
}

function normalizeQueueForTrack(track: Track, queue: readonly Track[], requestedIndex: number) {
  const nextQueue = queue.slice();
  let nextIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < nextQueue.length
    && sameTrack(nextQueue[requestedIndex], track)
    ? requestedIndex
    : findMatchingTrackIndex(nextQueue, track, requestedIndex);
  if (nextIndex < 0) {
    nextIndex = nextQueue.length;
    nextQueue.push(track);
  } else {
    nextQueue[nextIndex] = track;
  }
  return { queue: nextQueue, index: nextIndex };
}

function findMatchingTrackIndex(queue: readonly Track[], track: Track, preferredIndex = -1) {
  if (
    Number.isInteger(preferredIndex) &&
    preferredIndex >= 0 &&
    preferredIndex < queue.length &&
    sameTrack(queue[preferredIndex], track)
  ) return preferredIndex;
  return queue.findIndex((candidate) => sameTrack(candidate, track));
}

function sameTrack(left: Track | undefined | null, right: Track | undefined | null) {
  if (!left || !right) return false;
  if (left.id === right.id) return true;
  return normalizePath(left.path) === normalizePath(right.path);
}

function trackMatchesReference(track: Track, reference: TrackReference) {
  if (typeof reference === "number") return track.id === reference;
  if (typeof reference === "string") return normalizePath(track.path) === normalizePath(reference);
  return sameTrack(track, reference);
}

function normalizePath(path: string) {
  const trimmed = path.trim();
  return isRemotePath(trimmed)
    ? trimmed
    : trimmed.replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
}

function sameSourcePath(left: string, right: string) {
  const normalizeSource = (path: string) => path.trim().replace(/\//g, "\\").replace(/[\\]+$/, "");
  return normalizeSource(left) === normalizeSource(right);
}

function buildCanonicalTrackLookup(tracks: readonly Track[]) {
  const byId = new Map<number, Track>();
  const byPath = new Map<string, Track>();
  for (const track of tracks) {
    if (!isPersistableTrack(track)) continue;
    byId.set(track.id, track);
    byPath.set(normalizePath(track.path), track);
  }
  return { byId, byPath };
}

function canonicalTrackForReference(
  reference: StoredTrackReference,
  canonical: ReturnType<typeof buildCanonicalTrackLookup>
) {
  const byPath = canonical.byPath.get(normalizePath(reference.path));
  if (byPath) return byPath;
  return canonical.byId.get(reference.id) || null;
}

function canonicalTrackForTrack(
  track: Track,
  canonical: ReturnType<typeof buildCanonicalTrackLookup>
) {
  return canonical.byPath.get(normalizePath(track.path))
    || canonical.byId.get(track.id)
    || null;
}

function readStoredSession(): StoredPlaybackSession | null {
  const raw = safeStorageGet(AUDIO_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<StoredPlaybackSession>;
    if (
      candidate.version !== SESSION_VERSION ||
      typeof candidate.currentTrackId !== "number" ||
      !Number.isInteger(candidate.currentTrackId) ||
      candidate.currentTrackId <= 0 ||
      typeof candidate.currentPath !== "string" ||
      isRemotePath(candidate.currentPath) ||
      !Array.isArray(candidate.queue) ||
      !Number.isInteger(candidate.index) ||
      typeof candidate.shuffle !== "boolean" ||
      !isRepeatMode(candidate.repeat) ||
      typeof candidate.volume !== "number"
    ) return null;

    const queue = candidate.queue
      .slice(0, MAX_PERSISTED_QUEUE_LENGTH)
      .filter((item): item is StoredTrackReference => Boolean(item)
        && typeof item === "object"
        && typeof (item as StoredTrackReference).id === "number"
        && Number.isInteger((item as StoredTrackReference).id)
        && (item as StoredTrackReference).id > 0
        && typeof (item as StoredTrackReference).path === "string"
        && !isRemotePath((item as StoredTrackReference).path));

    return {
      version: SESSION_VERSION,
      currentTrackId: candidate.currentTrackId,
      currentPath: candidate.currentPath,
      queue,
      index: candidate.index as number,
      positionMs: Math.max(0, finiteNumber(candidate.positionMs, 0)),
      shuffle: candidate.shuffle,
      repeat: candidate.repeat,
      volume: clampVolume(candidate.volume, DEFAULT_VOLUME),
      explicitNextCount: clampInteger(
        finiteNumber(candidate.explicitNextCount, 0),
        0,
        Math.max(0, queue.length)
      ),
      savedAt: Math.max(0, finiteNumber(candidate.savedAt, 0))
    };
  } catch {
    return null;
  }
}

function readStoredVolume() {
  const raw = safeStorageGet(VOLUME_STORAGE_KEY);
  return clampVolume(raw === null ? DEFAULT_VOLUME : Number(raw), DEFAULT_VOLUME);
}

function safeStorageGet(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Playback remains functional if storage is unavailable or over quota.
  }
}

function safeStorageRemove(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore unavailable storage.
  }
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampVolume(value: unknown, fallback: number) {
  return Math.min(1, Math.max(0, finiteNumber(value, fallback)));
}

function clampPosition(value: unknown, duration?: number | null) {
  const position = Math.max(0, finiteNumber(value, 0));
  const durationMs = finiteNumber(duration, 0);
  return durationMs > 0 ? Math.min(position, durationMs) : position;
}

function clampInteger(value: number, minimum: number, maximum: number) {
  const integer = Number.isFinite(value) ? Math.round(value) : minimum;
  return Math.min(maximum, Math.max(minimum, integer));
}

function clampExplicitNextCount(value: number, queueLength: number, currentIndex: number) {
  const availableUpcoming = Math.max(0, queueLength - Math.max(0, currentIndex + 1));
  return clampInteger(value, 0, availableUpcoming);
}

function isRepeatMode(value: unknown): value is RepeatMode {
  return value === "off" || value === "all" || value === "one";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function describeMediaError(error: MediaError | null) {
  if (!error) return "The audio source could not be loaded.";
  const reason = {
    1: "Playback was aborted.",
    2: "A network error interrupted playback.",
    3: "The audio file could not be decoded.",
    4: "This audio format or source is not supported."
  }[error.code] || "The audio source could not be loaded.";
  return error.message ? `${reason} ${error.message}` : reason;
}
