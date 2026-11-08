import { useSyncExternalStore } from "react";

export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Bass boost": [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  Rock: [4, 3, 1, -1, -2, 0, 2, 3, 4, 3],
  Pop: [-1, 1, 3, 4, 3, 1, -1, -1, 1, 2],
  Jazz: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  Electronic: [5, 4, 1, 0, -2, 0, 1, 3, 4, 4],
  Vocals: [-3, -2, -1, 1, 3, 4, 3, 1, -1, -2],
  "Late night": [-4, -2, 0, 1, 2, 2, 0, -2, -3, -4]
};
export type AudioPreferences = { eqEnabled: boolean; preset: string; bands: number[]; gapless: boolean; crossfade: number; visualizer: boolean };
const KEY = "loavy.audioPreferences.v1";
const defaults: AudioPreferences = { eqEnabled: false, preset: "Flat", bands: [...EQ_PRESETS.Flat], gapless: true, crossfade: 0, visualizer: true };
const listeners = new Set<() => void>();
function read(): AudioPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!value || !Array.isArray(value.bands) || value.bands.length !== 10) return defaults;
    return { eqEnabled: value.eqEnabled === true, preset: typeof value.preset === "string" && value.preset.length < 60 ? value.preset : "Custom", bands: value.bands.map((gain: unknown) => typeof gain === "number" && Number.isFinite(gain) ? Math.max(-12, Math.min(12, gain)) : 0), gapless: value.gapless !== false, crossfade: typeof value.crossfade === "number" && Number.isFinite(value.crossfade) ? Math.max(0, Math.min(12, value.crossfade)) : 0, visualizer: value.visualizer !== false };
  } catch { return defaults; }
}
let preferences = read();
export const audioPreferences = {
  get: () => preferences,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  update(update: Partial<AudioPreferences>) {
    preferences = { ...preferences, ...update };
    try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch { /* Preferences still apply for this session. */ }
    listeners.forEach((listener) => listener());
  },
  preset(name: string) { if (EQ_PRESETS[name]) this.update({ preset: name, bands: [...EQ_PRESETS[name]], eqEnabled: true }); },
  band(index: number, gain: number) { if (index < 0 || index >= 10 || !Number.isFinite(gain)) return; this.update({ preset: "Custom", bands: preferences.bands.map((value, i) => i === index ? Math.max(-12, Math.min(12, gain)) : value), eqEnabled: true }); }
};
export const useAudioPreferences = () => useSyncExternalStore(audioPreferences.subscribe, audioPreferences.get, audioPreferences.get);
