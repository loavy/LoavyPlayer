import { createRoot } from "react-dom/client";
import { useState } from "react";
import { LyricsPanel } from "../src/components/LyricsPanel";
import { RoomView } from "../src/views/RoomView";
import App from "../src/App";
import { LibraryActionsProvider } from "../src/lib/LibraryContext";
import { audioEngine } from "../src/lib/audioEngine";
import { parseLrc, activeLyricIndex, shiftLyrics, plainLyrics, lyricWaveWords } from "../src/lib/lyrics";
import { parseJamAddress, jamInvite } from "../src/lib/jam";
import { editableLyricLines, setWordTiming } from "../src/lib/wordTiming";
import type { Track } from "../src/types";
import "../src/styles.css";
import "../src/redesign.css";
import "../src/desktop.css";
import "../src/audio-glass.css";
import "../src/listening-redesign.css";
import "../src/afterglow.css";
import "../src/jam-room.css";
Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });

const track: Track = { id: 1, path: "C:\\Music\\test.mp3", fileName: "test.mp3", fileExt: "mp3", fileSize: 100, modifiedAt: 0, title: "Somewhere together", artist: "Loavy sessions", album: "Our evening", durationMs: 180000, favorite: false, dateAdded: 0, playCount: 0 };
const lines = Array.from({ length: 35 }, (_, i) => `[${String(Math.floor(i * 4 / 60)).padStart(2, "0")}:${String(i * 4 % 60).padStart(2, "0")}.00]${["The room is full of familiar voices", "We watch the city lights", "A song for the way home", "Stay here a little longer"][i % 4]}`).join("\n");
const stopped = { running: false, connectedUsers: 0, networkAddresses: [], users: [] };
const disconnected = { connected: false, allowGuestControl: false };
const mock = (window as any).jamTest = {
  track, parseLrc, activeLyricIndex, shiftLyrics, plainLyrics, lyricWaveWords, editableLyricLines, setWordTiming, parseJamAddress, jamInvite, audioEngine,
  status: { ...stopped } as any, client: { ...disconnected } as any,
  lyrics: { trackId: 1, syncedText: lines, plainText: null, source: "manual" },
  fail: "", calls: [] as { command: string; args: any }[], notices: [] as string[], clipboard: "",
  delayLyrics: false, resolveLyrics: null as any,
  delayMatch: false, matches: [] as any[],
  settings: {} as Record<string, string>, lookupResult: null as any, searchResults: [] as any[],
  delayLookup: false, resolveLookup: null as any,
};
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<string, Set<number>>();
let callbackId = 0;
mock.emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((id) => callbacks.get(id)?.({ event, payload }));
const paused = new WeakMap<HTMLMediaElement, boolean>();
const sources = new WeakMap<HTMLMediaElement, string>();
Object.defineProperty(HTMLMediaElement.prototype, "paused", { get() { return paused.get(this) ?? true; } });
Object.defineProperty(HTMLMediaElement.prototype, "src", { get() { return sources.get(this) || ""; }, set(value) { sources.set(this, value); } });
HTMLMediaElement.prototype.play = async function () { mock.currentMedia = this; paused.set(this, false); this.dispatchEvent(new Event("play")); };
HTMLMediaElement.prototype.pause = function () { if (paused.get(this) === false) { paused.set(this, true); this.dispatchEvent(new Event("pause")); } };
HTMLMediaElement.prototype.load = function () {};
Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value: string) => { mock.clipboard = value; }, readText: async () => mock.clipboard } });
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; },
  convertFileSrc: (path: string) => path,
  async invoke(command: string, args: any = {}) {
    mock.calls.push({ command, args });
    if (command === "plugin:event|listen") { const handlers = listeners.get(args.event) || new Set(); handlers.add(args.handler); listeners.set(args.event, handlers); return args.handler; }
    if (command === "plugin:event|unlisten") listeners.get(args.event)?.delete(args.eventId);
    if (command === "list_tracks") return [track];
    if (["list_albums", "list_artists", "list_fetchers", "list_music_folders", "list_playlist_folders"].includes(command)) return [];
    if (command === "get_scan_state") return { running: false, cancelRequested: false };
    if (command === "get_downloader_status") { const health = { state: "ready", version: "test" }; return { running: false, ytDlp: health, ffmpeg: health, jsRuntime: health, spotdl: health }; }
    if (command === "find_room_playback_track") return mock.delayMatch ? new Promise(resolve => mock.matches.push(resolve)) : null;
    if (mock.fail === command) throw new Error(`Test failure: ${command}`);
    if (command === "get_setting") return mock.settings[args.key] ?? null;
    if (command === "set_setting") { mock.settings[args.update.key] = args.update.value; return null; }
    if (command === "lookup_online_lyrics") return mock.delayLookup ? new Promise(resolve => mock.resolveLookup = resolve) : mock.lookupResult;
    if (command === "search_online_lyrics") return mock.searchResults;
    if (command === "export_track_lyrics") return `C:/Lyrics/test.${args.format}`;
    if (command === "get_track_lyrics") {
      if (mock.delayLyrics) return new Promise((resolve) => { mock.resolveLyrics = resolve; });
      return mock.lyrics;
    }
    if (command === "save_track_lyrics") return mock.lyrics = { ...args.request };
    if (command === "import_track_lyrics") return null;
    if (command === "get_room_status") return mock.status;
    if (command === "get_room_client_status") return mock.client;
    if (command === "get_default_guest_song_folder") return "C:\\Music\\Guests";
    if (command === "create_room") return mock.status = { ...args.request, running: true, connectedUsers: 1, shareAddr: "192.168.1.5", users: [{ id: 1, displayName: "Alex", remoteAddr: "192.168.1.6", joinedAt: Date.now() }], networkAddresses: [{ interfaceName: "Wi-Fi", address: "192.168.1.5", joinAddress: "192.168.1.5:39177" }] };
    if (command === "stop_room") mock.status = { ...stopped };
    if (command === "room_kick_user") mock.status = { ...mock.status, connectedUsers: 0, users: [] };
    if (command === "room_join") { mock.client = { connected: true, allowGuestControl: false, host: args.request.host, port: args.request.port, roomName: args.request.roomName, displayName: args.request.displayName }; return { success: true, message: "Joined Jam." }; }
    if (command === "room_leave") mock.client = { ...disconnected };
    if (command === "room_join_probe") return { success: true, message: "Connection details checked." };
    if (command === "discover_rooms") return [{ name: "Friends", host: "192.168.1.5", port: 40123, connectedUsers: 1, maxUsers: 4, allowGuestControl: false }];
    return null;
  }
};
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
const actions = { notify: (message: string) => mock.notices.push(message), refreshLibrary: async () => {}, openArtist: () => {}, openAlbum: () => {} };
function Harness() {
  const [view, setView] = useState("lyrics");
  const [selected, setSelected] = useState<Track | null>(track);
  mock.view = setView; mock.select = setSelected;
  return <LibraryActionsProvider value={actions}><main style={{ height: "100dvh", padding: 24, overflow: "auto" }}>
    {view === "lyrics" ? <div style={{ height: "calc(100dvh - 48px)", maxWidth: 900, margin: "auto", background: "#18231f", borderRadius: 24 }}><LyricsPanel track={selected} /></div> : <RoomView onError={(message) => { if (message) mock.notices.push(message); }} />}
  </main></LibraryActionsProvider>;
}
document.documentElement.dataset.motion = "reduced";
void audioEngine.playTrack(track, [track], 0);
createRoot(document.getElementById("root")!).render(location.search.includes("full-app") ? <App /> : <Harness />);
