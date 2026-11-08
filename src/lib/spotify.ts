import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { audioEngine } from "./audioEngine";

export const SPOTIFY_REDIRECT = "http://127.0.0.1:43891/spotify/callback";
export type SpotifyImage = { url: string };
export type SpotifyTrack = { id: string; uri: string; name: string; duration_ms: number; is_local?: boolean; is_playable?: boolean; type?: string; artists: { name: string }[]; album?: { name: string; images: SpotifyImage[] }; external_urls?: { spotify?: string } };
export type SpotifyPlaylist = { id: string; uri: string; name: string; description?: string; images: SpotifyImage[]; owner?: { display_name?: string; id?: string }; items?: { total?: number }; tracks?: { total?: number }; external_urls?: { spotify?: string } };
export type SpotifyDevice = { id: string | null; name: string; type: string; is_active: boolean; is_restricted: boolean; volume_percent?: number | null; supports_volume?: boolean };
export type SpotifyPlayback = { is_playing: boolean; progress_ms: number; item: SpotifyTrack | null; device: SpotifyDevice; repeat_state?: "off" | "context" | "track"; shuffle_state?: boolean; actions?: { disallows?: Record<string, boolean> } };
type Profile = { id: string; display_name?: string; images?: SpotifyImage[]; external_urls?: { spotify?: string } };
type State = {
  connected: boolean; connecting: boolean; disconnecting: boolean; busy: boolean; error: string | null; profile: Profile | null;
  playlists: SpotifyPlaylist[]; playlistMore: boolean; selectedPlaylist: SpotifyPlaylist | null;
  items: SpotifyTrack[]; itemsMore: boolean; query: string; results: SpotifyTrack[]; searching: boolean; resultsMore: boolean;
  devices: SpotifyDevice[]; selectedDevice: string; playback: SpotifyPlayback | null; active: boolean;
  sdkState: "idle" | "loading" | "ready" | "unavailable"; sdkMessage: string | null; sdkDeviceId: string;
  roomBlocked: boolean; offline: boolean;
};
const empty: State = { connected: false, connecting: false, disconnecting: false, busy: false, error: null, profile: null, playlists: [], playlistMore: false, selectedPlaylist: null, items: [], itemsMore: false, query: "", results: [], searching: false, resultsMore: false, devices: [], selectedDevice: "", playback: null, active: false, sdkState: "idle", sdkMessage: null, sdkDeviceId: "", roomBlocked: false, offline: false };
let state = empty;
const listeners = new Set<() => void>();
let generation = 0, searchGeneration = 0, collectionGeneration = 0, itemOffset = 0;
let searchOffset = 0;
let refreshTask: Promise<void> | null = null, lastPolled = 0;
let sdk: SDKPlayer | null = null, sdkScriptPromise: Promise<void> | null = null;
function update(patch: Partial<State>) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function requireOnline() { if (state.offline) throw new Error("Turn off Offline mode in Settings to use Spotify."); if (!state.connected) throw new Error("Connect your Spotify account first."); }
function requirePlayback() { requireOnline(); if (state.roomBlocked) throw new Error("Leave or stop your Jam before starting Spotify playback."); }
async function request<T>(path: string, method = "GET", body: unknown = null) { requireOnline(); return invoke<T>("spotify_request", { method, path, body }); }
async function action(task: () => Promise<void>) {
  if (state.busy) return;
  const currentGeneration = generation;
  update({ busy: true, error: null });
  try { await task(); } catch (error) { if (currentGeneration === generation) update({ error: message(error) }); }
  finally { if (currentGeneration === generation) update({ busy: false }); }
}
function query(params: Record<string, string | number>) { return new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString(); }
function deviceQuery(usePlayingDevice = false) {
  const id = usePlayingDevice ? state.playback?.device?.id || state.selectedDevice : state.selectedDevice || state.playback?.device?.id;
  if (!id) throw new Error("Choose a Spotify device first. Open Spotify and start a song if no devices appear.");
  const device = state.devices.find(device => device.id === id);
  if (device?.is_restricted) throw new Error("Spotify does not allow playback control on this device.");
  return `device_id=${encodeURIComponent(id)}`;
}
async function refresh(includeDevices = false) {
  // A control action needs a fresh read after any older poll has finished.
  while (refreshTask) await refreshTask;
  if (!state.connected || state.offline) return;
  const revision = generation;
  const task = (async () => {
    try {
      const [playback, devices] = await Promise.all([request<SpotifyPlayback | null>("/me/player"), includeDevices ? request<{ devices: SpotifyDevice[] }>("/me/player/devices") : Promise.resolve(null)]);
      if (revision !== generation) return;
      update({ playback, ...(devices ? { devices: devices.devices.filter(device => !!device.id) } : {}) });
      if (playback?.is_playing && state.active && audioEngine.snapshot().playing) void audioEngine.toggle();
    } catch (error) { if (revision === generation) update({ error: message(error) }); }
  })();
  refreshTask = task;
  try { await task; } finally { if (refreshTask === task) refreshTask = null; }
}
async function playlists(append = false) {
  const revision = generation;
  const page = await request<{ items: (SpotifyPlaylist | null)[]; next: string | null }>(`/me/playlists?${query({ limit: 20, offset: append ? state.playlists.length : 0 })}`);
  if (revision !== generation) return;
  const items = page.items.filter((item): item is SpotifyPlaylist => !!item);
  update({ playlists: append ? [...state.playlists, ...items] : items, playlistMore: !!page.next });
}
async function playlistItems(playlist: SpotifyPlaylist, append: boolean, revision: number) {
  const page = await request<{ items: { item?: SpotifyTrack | null; track?: SpotifyTrack | null }[]; next: string | null }>(`/playlists/${encodeURIComponent(playlist.id)}/items?${query({ limit: 50, offset: append ? itemOffset : 0 })}`);
  if (revision !== collectionGeneration || !state.connected || state.selectedPlaylist?.id !== playlist.id) return;
  const tracks = page.items.map(entry => entry.item ?? entry.track).filter((track): track is SpotifyTrack => !!track && track.type !== "episode");
  itemOffset = (append ? itemOffset : 0) + page.items.length;
  update({ items: append ? [...state.items, ...tracks] : tracks, itemsMore: !!page.next });
}
async function pauseForLocal() {
  const revision = generation;
  const wasActive = state.active;
  update({ active: false });
  if (wasActive && state.playback?.is_playing) {
    try { await request("/me/player/pause?" + deviceQuery(true), "PUT"); if (revision === generation) update({ playback: state.playback ? { ...state.playback, is_playing: false } : null }); }
    catch (error) { if (revision === generation) { const detail = `Spotify could not be paused: ${message(error)}`; update({ error: detail }); window.dispatchEvent(new CustomEvent("loavy:playback-error", { detail: { message: detail } })); } }
  }
}
export const spotify = {
  get: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async initialize() {
    const revision = generation;
    try { const status = await invoke<{ connected: boolean; connecting: boolean }>("spotify_status"); if (revision !== generation || state.disconnecting) return; update({ connected: status.connected, connecting: status.connecting }); if (status.connected) await this.load(); }
    catch { /* Older native hosts and browser previews keep the disconnected setup screen. */ }
  },
  async connect(clientId: string) {
    if (state.offline) { update({ error: "Turn off Offline mode in Settings to connect Spotify." }); return; }
    if (!/^[a-f\d]{32}$/i.test(clientId.trim())) { update({ error: "Enter the 32-character Spotify Client ID. You do not need a Client Secret." }); return; }
    if (state.connecting || state.disconnecting) return;
    const revision = ++generation;
    update({ connecting: true, error: null });
    try {
      await invoke("spotify_connect", { clientId: clientId.trim() });
      if (revision !== generation) return;
      update({ connected: true, connecting: false }); await this.load();
    } catch (error) { if (revision === generation) update({ connecting: false, error: message(error) }); }
  },
  async disconnect() {
    if (state.disconnecting) return;
    generation++; searchGeneration++; collectionGeneration++;
    const wasActive = state.active, playback = state.playback;
    try { sdk?.disconnect(); } catch {} sdk = null;
    update({ ...empty, disconnecting: true, roomBlocked: state.roomBlocked, offline: state.offline });
    // Best effort: never leave this app's selected device playing after disconnect.
    if (wasActive && playback?.is_playing && playback.device?.id) { try { await invoke("spotify_request", { method: "PUT", path: `/me/player/pause?device_id=${encodeURIComponent(playback.device.id)}`, body: null }); } catch {} }
    try { await invoke("spotify_disconnect"); } catch (error) { update({ error: message(error) }); }
    finally { update({ disconnecting: false }); }
  },
  async load() { await action(async () => { const revision = generation; const profile = await request<Profile>("/me"); if (revision !== generation) return; update({ profile }); await Promise.all([playlists(), refresh(true)]); }); },
  async morePlaylists() { await action(() => playlists(true)); },
  async openPlaylist(playlist: SpotifyPlaylist) {
    if (state.busy) return;
    searchGeneration++;
    const revision = ++collectionGeneration; itemOffset = 0;
    update({ selectedPlaylist: playlist, items: [], itemsMore: false, query: "", results: [], searching: false, resultsMore: false, error: null });
    await action(() => playlistItems(playlist, false, revision));
  },
  closePlaylist() { collectionGeneration++; update({ selectedPlaylist: null, items: [], itemsMore: false, error: null }); },
  async moreItems() { const playlist = state.selectedPlaylist; if (playlist) await action(() => playlistItems(playlist, true, collectionGeneration)); },
  async search(value: string) {
    const revision = ++searchGeneration, authRevision = generation;
    searchOffset = 0;
    update({ query: value, results: [], searching: !!value.trim(), resultsMore: false, error: null });
    if (!value.trim()) return;
    try {
      const result = await request<{ tracks: { items: SpotifyTrack[]; next?: string | null } }>(`/search?${query({ q: value.trim(), type: "track", limit: 10, offset: 0 })}`);
      if (revision === searchGeneration && authRevision === generation) { searchOffset = result.tracks.items.length; update({ results: result.tracks.items, searching: false, resultsMore: !!result.tracks.next }); }
    } catch (error) { if (revision === searchGeneration && authRevision === generation) update({ error: message(error), searching: false }); }
  },
  async moreSearch() {
    if (state.searching || !state.resultsMore || !state.query.trim()) return;
    const revision = searchGeneration, authRevision = generation, value = state.query;
    update({ searching: true, error: null });
    try {
      const result = await request<{ tracks: { items: SpotifyTrack[]; next?: string | null } }>(`/search?${query({ q: value.trim(), type: "track", limit: 10, offset: searchOffset })}`);
      if (revision === searchGeneration && authRevision === generation) {
        searchOffset += result.tracks.items.length;
        const ids = new Set(state.results.map(track => track.uri));
        update({ results: [...state.results, ...result.tracks.items.filter(track => !ids.has(track.uri))], searching: false, resultsMore: !!result.tracks.next && result.tracks.items.length > 0 });
      }
    } catch (error) { if (revision === searchGeneration && authRevision === generation) update({ searching: false, error: message(error) }); }
  },
  clearError() { update({ error: null }); },
  selectDevice(id: string) { update({ selectedDevice: id }); },
  async refresh() { await action(() => refresh(true)); },
  async play(track?: SpotifyTrack, playlist?: SpotifyPlaylist) {
    await action(async () => {
      requirePlayback();
      if (track?.is_local || track?.is_playable === false) throw new Error("This song is not available for Spotify streaming on this account.");
      if (state.selectedDevice === state.sdkDeviceId && sdk) await sdk.activateElement();
      const target = deviceQuery(), revision = generation;
      let body: unknown = null;
      if (playlist) body = { context_uri: playlist.uri, ...(track ? { offset: { uri: track.uri } } : {}) };
      else if (track) body = { uris: [track.uri] };
      if (audioEngine.snapshot().playing) await audioEngine.toggle();
      await request("/me/player/play?" + target, "PUT", body);
      if (revision !== generation) return;
      update({ active: true }); await refresh();
    });
  },
  async pause() { await action(async () => { requirePlayback(); await request("/me/player/pause?" + deviceQuery(true), "PUT"); update({ playback: state.playback ? { ...state.playback, is_playing: false } : null }); await refresh(); }); },
  async toggle() { if (state.playback?.is_playing) await this.pause(); else await this.play(); },
  async skip(direction: "next" | "previous") { await action(async () => { requirePlayback(); await request(`/me/player/${direction}?` + deviceQuery(true), "POST"); await refresh(); }); },
  async seek(position: number) { await action(async () => { requirePlayback(); const ms = Math.max(0, Math.min(state.playback?.item?.duration_ms || 0, Math.round(position))); await request(`/me/player/seek?position_ms=${ms}&` + deviceQuery(true), "PUT"); update({ playback: state.playback ? { ...state.playback, progress_ms: ms } : null }); }); },
  async volume(percent: number) { await action(async () => { requirePlayback(); await request(`/me/player/volume?volume_percent=${Math.round(Math.max(0, Math.min(100, percent)))}&` + deviceQuery(true), "PUT"); await refresh(); }); },
  async transfer() { await action(async () => { requirePlayback(); const id = state.selectedDevice; if (!id) throw new Error("Choose a Spotify device first."); await request("/me/player", "PUT", { device_ids: [id], play: false }); update({ active: true }); await refresh(true); }); },
  async open(url = "https://open.spotify.com") { try { await invoke("spotify_open", { url }); } catch (error) { update({ error: message(error) }); } },
  async enableSDK() {
    if (state.sdkState === "loading") return;
    const revision = generation;
    update({ sdkState: "loading", sdkMessage: null, error: null });
    try {
      requirePlayback();
      if (!navigator.requestMediaKeySystemAccess) throw new Error("This desktop WebView cannot play Spotify's protected audio. Choose a Spotify Connect device below.");
      await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [{ initDataTypes: ["cenc"], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }]);
      await loadSDK();
      if (revision !== generation) return;
      sdk?.disconnect();
      const player = new window.Spotify!.Player({ name: "Loavy Player", volume: .65, enableMediaSession: false, getOAuthToken: callback => { void invoke<string>("spotify_sdk_token").then(token => { if (revision === generation) callback(token); }).catch(error => { if (revision === generation) update({ sdkMessage: message(error), error: message(error) }); }); } });
      sdk = player;
      const ready = new Promise<string>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("Spotify could not initialize playback here. Use a Spotify Connect device instead.")), 15_000);
        player.addListener("ready", ({ device_id }: { device_id: string }) => { clearTimeout(timer); resolve(device_id); });
        for (const event of ["initialization_error", "authentication_error", "account_error", "playback_error"]) player.addListener(event, ({ message: detail }: { message: string }) => { clearTimeout(timer); const error = new Error(event === "account_error" ? "Spotify playback requires a Premium subscription." : detail); reject(error); if (revision === generation) update({ sdkMessage: error.message, error: error.message }); });
        player.addListener("not_ready", () => { if (revision === generation) update({ sdkState: "unavailable", sdkDeviceId: "", selectedDevice: state.selectedDevice === state.sdkDeviceId ? "" : state.selectedDevice, sdkMessage: "Loavy's Spotify device is offline. Reconnect it, or choose another device." }); });
        player.addListener("player_state_changed", () => { if (revision === generation) void refresh(); });
        void player.connect().then(connected => { if (!connected) { clearTimeout(timer); reject(new Error("Spotify could not connect this player. Choose another device.")); } }).catch(error => { clearTimeout(timer); reject(error); });
      });
      const deviceId = await ready;
      if (revision !== generation) { player.disconnect(); return; }
      update({ sdkState: "ready", sdkDeviceId: deviceId, selectedDevice: deviceId, sdkMessage: null });
      await refresh(true);
    } catch (error) {
      if (revision !== generation) return;
      sdk?.disconnect(); sdk = null;
      const detail = error instanceof DOMException && error.name === "NotSupportedError" ? "Spotify's protected playback is unavailable in this desktop WebView. You can still browse here and play on a Spotify Connect device." : message(error);
      update({ sdkState: "unavailable", sdkMessage: detail, sdkDeviceId: "" });
    }
  },
  setRoomBlocked(blocked: boolean) { if (blocked === state.roomBlocked) return; if (blocked) void pauseForLocal(); update({ roomBlocked: blocked }); },
  setOffline(offline: boolean) { if (offline === state.offline) return; if (offline) void pauseForLocal(); update({ offline }); },
  returnToLocal() { void pauseForLocal(); },
};
export const useSpotify = () => useSyncExternalStore(spotify.subscribe, spotify.get, spotify.get);
export function installSpotify() {
  void spotify.initialize();
  const unsubscribe = audioEngine.subscribe(() => { if (state.active && audioEngine.snapshot().playing) void pauseForLocal(); });
  const timer = window.setInterval(() => { if (!state.connected || state.offline || Date.now() - lastPolled < (document.hidden ? 30_000 : 8_000)) return; lastPolled = Date.now(); void refresh(); }, 2000);
  return () => { unsubscribe(); clearInterval(timer); };
}
type SDKPlayer = { connect(): Promise<boolean>; disconnect(): void; activateElement(): Promise<void>; addListener(name: string, callback: (event: any) => void): boolean };
declare global { interface Window { Spotify?: { Player: new (options: { name: string; volume: number; enableMediaSession: boolean; getOAuthToken(callback: (token: string) => void): void }) => SDKPlayer }; onSpotifyWebPlaybackSDKReady?: () => void } }
function loadSDK() {
  if (window.Spotify) return Promise.resolve();
  if (!sdkScriptPromise) sdkScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => { script.remove(); sdkScriptPromise = null; reject(new Error("Spotify's player did not load. Check your connection and retry.")); }, 15_000);
    window.onSpotifyWebPlaybackSDKReady = () => { clearTimeout(timer); resolve(); };
    script.src = "https://sdk.scdn.co/spotify-player.js"; script.async = true;
    script.onerror = () => { clearTimeout(timer); script.remove(); sdkScriptPromise = null; reject(new Error("Could not load Spotify's player. Choose a Spotify Connect device or retry.")); };
    document.head.append(script);
  });
  return sdkScriptPromise;
}
