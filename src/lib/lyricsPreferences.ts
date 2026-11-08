import { useSyncExternalStore } from "react";

type Preferences = { size: "small" | "normal" | "large"; align: "left" | "center"; focus: boolean; wave: boolean; offsets: Record<string, number> };
const key = "loavy.lyricsReading.v1";
function read(): Preferences {
  const defaults: Preferences = { size: "normal", align: "left", focus: true, wave: true, offsets: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved || typeof saved !== "object") return defaults;
    const offsets: Record<string, number> = {};
    Object.entries(saved.offsets || {}).slice(-200).forEach(([id, value]) => { if (/^[1-9]\d*$/.test(id) && typeof value === "number" && Number.isFinite(value)) offsets[id] = Math.max(-10000, Math.min(10000, value)); });
    return { size: ["small", "normal", "large"].includes(saved.size) ? saved.size : "normal", align: saved.align === "center" ? "center" : "left", focus: typeof saved.focus === "boolean" ? saved.focus : true, wave: typeof saved.wave === "boolean" ? saved.wave : true, offsets };
  } catch { return defaults; }
}
let state = read();
const listeners = new Set<() => void>();
function publish() { try { localStorage.setItem(key, JSON.stringify(state)); } catch {} listeners.forEach(listener => listener()); }
export const lyricsPreferences = {
  get: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  update(patch: Partial<Pick<Preferences, "size" | "align" | "focus" | "wave">>) { state = { ...state, ...patch }; publish(); },
  offset(trackId: number, milliseconds: number) {
    if (trackId <= 0 || !Number.isFinite(milliseconds)) return;
    const entries = Object.entries(state.offsets).filter(([id]) => id !== String(trackId));
    if (milliseconds) entries.push([String(trackId), Math.max(-10000, Math.min(10000, milliseconds))]);
    state = { ...state, offsets: Object.fromEntries(entries.slice(-200)) }; publish();
  },
};
export const useLyricsPreferences = () => useSyncExternalStore(lyricsPreferences.subscribe, lyricsPreferences.get, lyricsPreferences.get);
