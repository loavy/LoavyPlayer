import { useSyncExternalStore } from "react";
import { api } from "./api";
import { audioEngine } from "./audioEngine";
import { displayAlbum, displayArtist, displayTrackTitle } from "./format";
import type { Track } from "../types";

export type ListeningEntry = { day: string; trackId: number; title: string; artist: string; album: string; milliseconds: number; plays: number };
type StatsState = { entries: ListeningEntry[]; loaded: boolean; error: string | null };
const KEY = "listeningHistory.v1";
const listeners = new Set<() => void>();
let state: StatsState = { entries: [], loaded: false, error: null };
let loading: Promise<void> | null = null;
let dirty = false;
let revision = 0;
let writing = false;
export function localDay(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function publish() { listeners.forEach((listener) => listener()); }
function valid(entry: ListeningEntry) { return entry && /^\d{4}-\d{2}-\d{2}$/.test(entry.day) && Number.isInteger(entry.trackId) && entry.trackId > 0 && typeof entry.title === "string" && typeof entry.artist === "string" && typeof entry.album === "string" && Number.isFinite(entry.milliseconds) && entry.milliseconds >= 0 && Number.isFinite(entry.plays) && entry.plays >= 0; }
function merge(entries: ListeningEntry[]) {
  const earliest = new Date(); earliest.setDate(earliest.getDate() - 365);
  const cutoff = localDay(earliest);
  const map = new Map<string, ListeningEntry>();
  for (const entry of entries) {
    if (!valid(entry) || entry.day < cutoff) continue;
    const key = `${entry.day}:${entry.trackId}`, previous = map.get(key);
    map.set(key, previous ? { ...entry, milliseconds: previous.milliseconds + entry.milliseconds, plays: previous.plays + entry.plays } : { ...entry });
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-12000);
}
export const listeningStats = {
  get: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async load() {
    if (state.loaded) return;
    if (!loading) loading = (async () => {
      try {
        const saved = await api.getSetting(KEY);
        const entries = saved ? JSON.parse(saved) : [];
        if (!Array.isArray(entries)) throw new Error("Invalid listening history");
        state = { entries: merge([...entries, ...state.entries]), loaded: true, error: null };
      } catch { state = { ...state, loaded: false, error: "Could not load your listening history. Retry to keep recording." }; }
      finally { loading = null; publish(); }
    })();
    return loading;
  },
  record(track: Track, milliseconds: number, plays = 0) {
    if (track.id <= 0 || !Number.isFinite(milliseconds) || milliseconds < 0 || (!milliseconds && !plays)) return;
    const entry: ListeningEntry = { day: localDay(), trackId: track.id, title: displayTrackTitle(track), artist: displayArtist(track.artist), album: displayAlbum(track.album), milliseconds: Math.round(milliseconds), plays };
    const entries = state.entries.slice();
    const index = entries.findIndex((item) => item.day === entry.day && item.trackId === entry.trackId);
    if (index >= 0) entries[index] = { ...entry, milliseconds: entries[index].milliseconds + entry.milliseconds, plays: entries[index].plays + plays };
    else entries.push(entry);
    state = { ...state, entries: entries.length > 12000 ? merge(entries) : entries };
    dirty = true; revision++; publish();
  },
  async flush() {
    if (!dirty || !state.loaded || writing) return;
    writing = true; const savedRevision = revision;
    try {
      await api.setSetting(KEY, JSON.stringify(state.entries));
      dirty = revision !== savedRevision;
      if (state.error) { state = { ...state, error: null }; publish(); }
    } catch { state = { ...state, error: "Listening history could not be saved. Your current session is still available." }; publish(); }
    finally { writing = false; if (dirty && revision !== savedRevision) void listeningStats.flush(); }
  }
};
export const useListeningStats = () => useSyncExternalStore(listeningStats.subscribe, listeningStats.get, listeningStats.get);

/** Counts monotonic elapsed time while audible playback advances, never seek distance. */
export function installListeningStats() {
  void listeningStats.load();
  let previous = audioEngine.snapshot();
  let lastTick = performance.now();
  let sessionMs = 0, credited = false, lastWrite = lastTick;
  const tick = () => {
    const now = performance.now(), current = audioEngine.snapshot();
    const elapsed = Math.max(0, Math.min(120_000, now - lastTick)); lastTick = now;
    if (previous.playing && previous.current && previous.current.id > 0) {
      // Paused, stalled and replaced sources do not accumulate artificial listening time.
      const same = current.current?.id === previous.current.id && current.current?.path === previous.current.path;
      const progressed = same && current.position > previous.position && current.position - previous.position < elapsed + 1200;
      if (progressed) {
        const heard = Math.min(elapsed, current.position - previous.position);
        sessionMs += heard;
        const threshold = Math.max(1, Math.min(30_000, (previous.current.durationMs || previous.duration || 60_000) / 2));
        const play = !credited && sessionMs >= threshold ? 1 : 0;
        if (play) credited = true;
        listeningStats.record(previous.current, heard, play);
      }
    }
    if (current.current?.id !== previous.current?.id || current.current?.path !== previous.current?.path) { sessionMs = 0; credited = false; }
    if ((previous.playing && !current.playing) || now - lastWrite > 10_000) { lastWrite = now; void listeningStats.flush(); }
    previous = current;
  };
  const onStarted = () => { tick(); sessionMs = 0; credited = false; };
  const flush = () => { tick(); void listeningStats.flush(); };
  const unsubscribe = audioEngine.subscribe(tick);
  const timer = window.setInterval(tick, 1000);
  window.addEventListener("loavy:track-started", onStarted);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", flush);
  return () => { unsubscribe(); clearInterval(timer); window.removeEventListener("loavy:track-started", onStarted); window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", flush); flush(); };
}
