import "./playlist-harness";
import { spotify } from "../src/lib/spotify";
import { audioEngine } from "../src/lib/audioEngine";
import { navigation } from "../src/lib/navigation";
import { installMediaSession } from "../src/lib/mediaSession";
const browser = window as any;
const originalInvoke = browser.__TAURI_INTERNALS__.invoke;
const art = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="${color}"/><circle cx="185" cy="95" r="65" fill="#e2d1b6"/><path d="M0 220L120 120 300 260V300H0" fill="#142d33"/></svg>`)}`;
const song = (id: string, name: string) => ({ id, uri: `spotify:track:${id}`, type: "track", name, duration_ms: 210000, artists: [{ name: "Preview artist" }], album: { name: "Evening light", images: [{ url: art("#395b68") }] }, external_urls: { spotify: `https://open.spotify.com/track/${id}` } });
const songs = [song("1234567890123456789012", "First light"), song("2234567890123456789012", "A quiet place"), song("3234567890123456789012", "Still here")];
const playlists = Array.from({ length: 6 }, (_, i) => ({ id: `${i}123456789012345678901`, uri: `spotify:playlist:${i}123456789012345678901`, name: ["After the rain", "Sunday mornings", "Somewhere new", "Night drive", "Quiet company", "On the way"][i], images: [{ url: art(["#41645b", "#7e6a85", "#956858", "#3b555f", "#69785b", "#735848"][i]) }], owner: { id: "loavy-test", display_name: "Loavy listener" }, items: { total: 3 }, external_urls: { spotify: `https://open.spotify.com/playlist/${i}123456789012345678901` } }));
const device = { id: "desktop-device", name: "Living room PC", type: "Computer", is_active: true, is_restricted: false, volume_percent: 60, supports_volume: true };
let connected = false, connectGeneration = 0;
let playback: any = { is_playing: false, progress_ms: 32000, item: songs[0], device, actions: { disallows: {} } };
const mock = browser.spotifyTest = { service: spotify, audio: audioEngine, navigation, calls: [] as { command: string; args: any }[], failPlayback: false, noDevices: false, songs, playlists, local: browser.playlistTest.folders, sdkConnected: false, sdkToken: "memory-only-test-token", pendingSearch: false, connected: () => connected };
Object.defineProperty(navigator, "requestMediaKeySystemAccess", { configurable: true, value: async () => { throw new DOMException("Not supported", "NotSupportedError"); } });
browser.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
  if (!command.startsWith("spotify_")) return originalInvoke(command, args);
  mock.calls.push({ command, args });
  if (command === "spotify_status") return { connected, connecting: false };
  if (command === "spotify_connect") { const revision = ++connectGeneration; await new Promise(resolve => setTimeout(resolve, 250)); if (revision !== connectGeneration) throw new Error("Spotify sign-in cancelled."); connected = true; return; }
  if (command === "spotify_disconnect") { connectGeneration++; connected = false; return; }
  if (command === "spotify_sdk_token") return mock.sdkToken;
  if (command === "spotify_open") return;
  if (command === "spotify_request") {
    if (!connected) throw new Error("Connect your Spotify account first.");
    const url = new URL(`https://api.spotify.com/v1${args.path}`), endpoint = url.pathname.slice(3);
    if (endpoint === "/me") return { id: "loavy-test", display_name: "Loavy listener" };
    if (endpoint === "/me/playlists") return { items: url.searchParams.get("offset") === "0" ? playlists : [{ ...playlists[0], id: "9123456789012345678901", name: "One more playlist" }], next: url.searchParams.get("offset") === "0" ? "https://api.spotify.com/v1/me/playlists?offset=6" : null };
    if (endpoint.endsWith("/items")) return url.searchParams.get("offset") === "0" ? { items: [{ item: songs[0] }, { item: null }, { item: songs[1] }], next: "https://api.spotify.com/v1/next" } : { items: [{ track: songs[2] }], next: null };
    if (endpoint === "/search") { const search = url.searchParams.get("q"); if (search === "pages") return { tracks: { items: url.searchParams.get("offset") === "0" ? songs.slice(0,2) : songs.slice(1), next: url.searchParams.get("offset") === "0" ? "https://api.spotify.com/v1/search?offset=2" : null } }; await new Promise(resolve => setTimeout(resolve, search === "old" ? 180 : 20)); return { tracks: { items: [song("4234567890123456789012", search || "Search")] } }; }
    if (endpoint === "/me/player/devices") return { devices: mock.noDevices ? [] : [device, { ...device, id: "restricted", name: "Restricted speaker", is_restricted: true }, ...(mock.sdkConnected ? [{ ...device, id: "sdk-device", name: "Loavy Player" }] : [])] };
    if (endpoint === "/me/player" && args.method === "GET") return structuredClone(playback);
    if (mock.failPlayback) throw new Error("Spotify denied access. Playback needs Premium; development apps require your account on their allowlist.");
    if (endpoint === "/me/player/play") { playback = { ...playback, is_playing: true, item: songs.find(song => song.uri === (args.body?.uris?.[0] || args.body?.offset?.uri)) || songs[0], device: { ...device, id: url.searchParams.get("device_id") || device.id } }; return null; }
    if (endpoint === "/me/player/pause") { playback.is_playing = false; return null; }
    if (endpoint === "/me/player/seek") { playback.progress_ms = Number(url.searchParams.get("position_ms")); return null; }
    if (endpoint === "/me/player/next") { playback.item = songs[1]; return null; }
    if (endpoint === "/me/player/previous") { playback.item = songs[0]; return null; }
    if (endpoint === "/me/player/volume") { playback.device.volume_percent = Number(url.searchParams.get("volume_percent")); return null; }
    if (endpoint === "/me/player") { if (args.method === "PUT" && args.body?.device_ids?.length) playback.device = { ...device, id: args.body.device_ids[0] }; return null; }
    throw new Error(`Unhandled Spotify fixture: ${args.method} ${endpoint}`);
  }
};
mock.enableFakeSDK = () => {
  Object.defineProperty(navigator, "requestMediaKeySystemAccess", { configurable: true, value: async () => ({}) });
  browser.Spotify = { Player: class {
    handlers = new Map(); constructor(private options: any) {}
    addListener(name: string, callback: any) { this.handlers.set(name, callback); return true; }
    async connect() { mock.sdkConnected = true; this.options.getOAuthToken((token: string) => { if (token !== mock.sdkToken) throw Error("Bad SDK token"); }); setTimeout(() => this.handlers.get("ready")?.({ device_id: "sdk-device" }), 20); return true; }
    disconnect() { mock.sdkConnected = false; }
    async activateElement() {}
  } };
};
mock.startLocal = () => audioEngine.playTrack({ id: 55, path: "C:\\Music\\local.mp3", fileName: "local.mp3", fileExt: "mp3", fileSize: 100, modifiedAt: 0, title: "Local song", durationMs: 300000, favorite: false, dateAdded: 0, playCount: 0 });
installMediaSession();
navigation.view("spotify");
