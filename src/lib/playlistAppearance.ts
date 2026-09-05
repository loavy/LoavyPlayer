import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import type { LibraryFolderEntry } from "../types";

export type PlaylistAppearance = {
  name: string;
  description: string;
  color: string;
  coverPath: string | null;
  bannerPath: string | null;
  bannerPosition: number;
};
export const PLAYLIST_COLORS = ["#71b6a1", "#b1a0dc", "#e8a77c", "#8cb4d8", "#d991ab", "#d3bc79", "#a5ba84", "#a0a6b1"];
const STORAGE_KEY = "playlistAppearances.v1";
type Snapshot = { items: Record<string, PlaylistAppearance>; loaded: boolean; error: string | null };
let snapshot: Snapshot = { items: {}, loaded: false, error: null };
let loading: Promise<void> | null = null;
let saving = Promise.resolve();
const listeners = new Set<() => void>();
const subscribe = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
function publish(next: Snapshot) { snapshot = next; listeners.forEach((callback) => callback()); }

export function playlistKey(folder: LibraryFolderEntry) {
  return `${folder.rootId}:${folder.relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase()}`;
}

export function defaultAppearance(folder: LibraryFolderEntry): PlaylistAppearance {
  const hash = [...playlistKey(folder)].reduce((value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) | 0, 0);
  return { name: folder.name, description: "", color: PLAYLIST_COLORS[Math.abs(hash) % PLAYLIST_COLORS.length], coverPath: null, bannerPath: null, bannerPosition: 50 };
}

function normalize(value: unknown): PlaylistAppearance | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<PlaylistAppearance>;
  if (typeof item.name !== "string" || !item.name.trim()) return null;
  return {
    name: item.name.slice(0, 120), description: typeof item.description === "string" ? item.description.slice(0, 500) : "",
    color: typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : PLAYLIST_COLORS[0],
    coverPath: typeof item.coverPath === "string" ? item.coverPath : null,
    bannerPath: typeof item.bannerPath === "string" ? item.bannerPath : null,
    bannerPosition: typeof item.bannerPosition === "number" && Number.isFinite(item.bannerPosition) ? Math.max(0, Math.min(100, item.bannerPosition)) : 50
  };
}

async function load() {
  if (snapshot.loaded) return;
  if (!loading) loading = api.getSetting(STORAGE_KEY).then((raw) => {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Playlist appearance settings could not be read.");
    const items = Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      const item = normalize(value); return item ? [[key, item]] : [];
    }));
    publish({ items, loaded: true, error: null });
  }).catch((error) => {
    publish({ ...snapshot, error: String(error) });
    throw error;
  }).finally(() => { loading = null; });
  return loading;
}

export function usePlaylistAppearances() {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => { void load().catch(() => undefined); }, []);
  return state;
}

export function retryPlaylistAppearances() { return load(); }

export function savePlaylistAppearance(folder: LibraryFolderEntry, appearance: PlaylistAppearance | null) {
  const task = saving.catch(() => undefined).then(async () => {
    await load();
    const items = { ...snapshot.items };
    if (appearance) {
      const validated = normalize(appearance);
      if (!validated) throw new Error("Enter a playlist name.");
      items[playlistKey(folder)] = validated;
    } else delete items[playlistKey(folder)];
    await api.setSetting(STORAGE_KEY, JSON.stringify(items));
    publish({ items, loaded: true, error: null });
  });
  saving = task;
  return task;
}
