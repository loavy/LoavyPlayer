import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { UserPlaylistsView } from "../src/views/UserPlaylistsView";
import { VirtualSongList } from "../src/components/VirtualSongList";
import { PlaylistPicker } from "../src/components/PlaylistPicker";
import { Sidebar } from "../src/components/Sidebar";
import { PlayerBar } from "../src/components/PlayerBar";
import { LibraryActionsProvider } from "../src/lib/LibraryContext";
import { installMouseNavigation, navigation, useNavigation } from "../src/lib/navigation";
import { audioEngine } from "../src/lib/audioEngine";
import App from "../src/App";
import type { LibraryFolderEntry, Track, ViewKey } from "../src/types";
import "../src/styles.css";
import "../src/redesign.css";
import "../src/desktop.css";
import "../src/audio-glass.css";
import "../src/spotify.css";
import "../src/listening-redesign.css";
import "../src/afterglow.css";
import "../src/jam-room.css";
import "../src/downloader.css";
import "../src/spotify-studio.css";
// These UI regressions intentionally exercise the native media fallback. Real DSP is checked by audio-browser.mjs.
Object.defineProperty(window, "AudioContext", { value: undefined, configurable: true });

const names = ["After hours", "Soft focus", "Somewhere, elsewhere", "Golden hour", "On repeat", "A little louder", "Sunday morning", "The long way home"];
const designPreview = location.search.includes("design");
// Local vector fixtures exercise real image rendering without remote artwork.
const designCovers = names.map((name, index) => {
  const hue = [192, 258, 158, 30, 216, 352, 46, 178][index];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><defs><linearGradient id="sky" x2=".8" y2="1"><stop stop-color="hsl(${hue},32%,41%)"/><stop offset="1" stop-color="hsl(${hue+20},35%,10%)"/></linearGradient><radialGradient id="sun"><stop stop-color="#f4dfb0" stop-opacity=".8"/><stop offset="1" stop-color="#e4c9a0" stop-opacity="0"/></radialGradient></defs><rect width="600" height="600" fill="url(#sky)"/><circle cx="${370-index*16}" cy="210" r="170" fill="url(#sun)"/><circle cx="${370-index*16}" cy="210" r="63" fill="#ebd8ac" opacity=".64"/><path d="M0 370 Q130 240 280 370 T600 320 V600 H0Z" fill="hsl(${hue},25%,13%)" opacity=".7"/><path d="M0 440 Q180 310 350 430 T600 390 V600 H0Z" fill="hsl(${hue},25%,8%)" opacity=".85"/><path d="M0 510 Q170 410 320 500 T600 460 V600 H0Z" fill="#060b0d" opacity=".8"/><text x="36" y="49" fill="#fff" opacity=".7" font-family="sans-serif" font-size="12" letter-spacing="5">LOAVY SESSIONS / 0${index+1}</text><text x="36" y="550" fill="#fff" opacity=".9" font-family="sans-serif" font-weight="300" font-size="28">${name}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
});
const folders: LibraryFolderEntry[] = names.map((name, i) => ({ rootId: 1, name, relativePath: name, path: `C:\\Music\\${name}`, directTrackCount: 60, indexedTrackCount: 60 }));
const tracks: Track[] = folders.flatMap((folder, f) => Array.from({ length: 60 }, (_, i) => ({ id: f * 60 + i + 1, path: `${folder.path}\\${i}.mp3`, fileName: `${i}.mp3`, fileExt: "mp3", fileSize: 100, modifiedAt: 0, title: ["Late night conversations (a very long title that should never hide the controls)", "Weightless", "Everything in its right place", "A walk through the city"][i % 4], artist: ["Unknown Artist", "Marconi Union", "Radiohead", "Nujabes"][i % 4], album: "Selected works", durationMs: 217000, favorite: i % 3 === 0, dateAdded: 0, playCount: 0 })));
if (designPreview) tracks.forEach((track, index) => { const albumIndex = Math.floor(index / 60); track.album = names[albumIndex]; track.coverPath = designCovers[albumIndex]; track.lastPlayedAt = albumIndex < 4 ? Date.now() - index * 60_000 : null; });
const browser = window as any;
const mock = browser.playlistTest = { failSave: false, imageResult: null as string | null, commands: [] as string[], notices: [] as string[], folders, snapshot: () => audioEngine.snapshot(), next: () => audioEngine.next(), navigation, sessionWrites: 0, volumeBurst: () => { for (let i = 0; i < 30; i++) audioEngine.setVolume(i / 30); } };
const setItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (key, value) { if (key === "loavy.playbackSession") mock.sessionWrites++; setItem.call(this, key, value); };
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<string, Set<number>>();
let callbackId = 0;
const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((id) => callbacks.get(id)?.({ event, payload }));
// Deterministic media events test UI/source tracking without reading user audio.
const paused = new WeakMap<HTMLMediaElement, boolean>();
const sources = new WeakMap<HTMLMediaElement, string>();
Object.defineProperty(HTMLMediaElement.prototype, "paused", { get() { return paused.get(this) ?? true; } });
Object.defineProperty(HTMLMediaElement.prototype, "src", { get() { return sources.get(this) || ""; }, set(value) { sources.set(this, value); } });
HTMLMediaElement.prototype.play = async function () { paused.set(this, false); this.dispatchEvent(new Event("play")); };
HTMLMediaElement.prototype.pause = function () { if (paused.get(this) === false) { paused.set(this, true); this.dispatchEvent(new Event("pause")); } };
HTMLMediaElement.prototype.load = function () {};
// Room previews: ?room=hosting shows a live Jam with guests, ?room=guest shows a joined Jam.
const hostingRoom = { running: true, name: "Friday Night", port: 39177, maxUsers: 6, connectedUsers: 3, allowGuestControl: true, guestSongDir: "C:\\Music\\Jam", shareAddr: "192.168.1.5", localJoin: "192.168.1.5:39177", networkAddresses: [{ interfaceName: "Wi-Fi", address: "192.168.1.5", joinAddress: "192.168.1.5:39177" }, { interfaceName: "Tailscale", address: "100.92.14.7", joinAddress: "100.92.14.7:39177" }], users: [{ id: 1, displayName: "Marina", remoteAddr: "192.168.1.6", joinedAt: Date.now() - 1800000 }, { id: 2, displayName: "Theo", remoteAddr: "192.168.1.9", joinedAt: Date.now() - 900000 }, { id: 3, displayName: "Bia", remoteAddr: "100.92.14.9", joinedAt: Date.now() - 120000 }] };
const roomMode = new URLSearchParams(location.search).get("room");
const roomPreview: { status: any; client: any } = {
  status: roomMode === "hosting" ? hostingRoom : { running: false, connectedUsers: 0, networkAddresses: [], users: [] },
  client: roomMode === "guest" ? { connected: true, allowGuestControl: false, host: "192.168.1.5", port: 39177, roomName: "Friday Night", displayName: "Renata" } : { connected: false, allowGuestControl: false }
};
browser.__TAURI_INTERNALS__ = {
  transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; },
  convertFileSrc: (path: string) => path,
  async invoke(command: string, args: any = {}) {
    mock.commands.push(command);
    if (command === "plugin:event|listen") { const handlers = listeners.get(args.event) || new Set(); handlers.add(args.handler); listeners.set(args.event, handlers); return args.handler; }
    if (command === "plugin:event|unlisten") listeners.get(args.event)?.delete(args.eventId);
    if (command === "list_tracks") return location.search.includes("empty") ? [] : tracks;
    if (command === "list_music_folders") return [{ id: 1, path: "C:\\Music", enabled: true, createdAt: 0 }];
    if (command === "list_albums") return location.search.includes("empty") ? [] : designPreview ? names.map((title, index) => ({ title, artist: ["Marconi Union", "Nujabes", "Radiohead", "Loavy sessions"][index % 4], trackCount: 60, coverPath: designCovers[index] })) : [{ title: "Selected works", artist: "Various artists", trackCount: tracks.length }];
    if (command === "list_artists") return location.search.includes("empty") ? [] : [...new Set(tracks.map((track) => track.artist))].map((name) => ({ name, trackCount: tracks.filter((track) => track.artist === name).length, albumCount: 1 }));
    if (command === "list_fetchers") return [];
    if (command === "get_scan_state") return { running: false, cancelRequested: false };
    if (command === "get_track_lyrics") return { trackId: args.trackId, source: "manual", updatedAt: 0, syncedText: "[00:00.00]The city settles into the night\n[00:15.00]And every light becomes a melody\n[00:30.00]Stay here a little longer\n[00:45.00]Let the world go quiet\n[01:00.00]We have nowhere else to be" };
    if (command === "get_room_status") return roomPreview.status;
    if (command === "get_room_client_status") return roomPreview.client;
    if (command === "get_default_guest_song_folder") return "C:\\Music\\Jam";
    if (command === "discover_rooms") return [{ name: "Friday Night", host: "192.168.1.5", port: 39177, connectedUsers: 3, maxUsers: 6, allowGuestControl: true }, { name: "Study Room", host: "10.8.0.2", port: 39177, connectedUsers: 1, maxUsers: 4, allowGuestControl: false }];
    if (command === "create_room") return roomPreview.status = { ...hostingRoom, name: args.request.name, maxUsers: args.request.maxUsers, allowGuestControl: args.request.allowGuestControl };
    if (command === "stop_room") roomPreview.status = { running: false, connectedUsers: 0, networkAddresses: [], users: [] };
    if (command === "room_kick_user") roomPreview.status = { ...roomPreview.status, users: roomPreview.status.users.filter((user: any) => user.id !== args.userId), connectedUsers: roomPreview.status.connectedUsers - 1 };
    if (command === "room_join") { roomPreview.client = { connected: true, allowGuestControl: false, host: args.request.host, port: args.request.port, roomName: args.request.roomName, displayName: args.request.displayName }; return { success: true, message: "Joined Jam." }; }
    if (command === "room_leave") roomPreview.client = { connected: false, allowGuestControl: false };
    if (command === "room_join_probe") return { success: true, message: "Connection details checked." };
    if (command === "get_downloader_status") { const health = { state: "ready", version: "test", expectedVersion: "test", detail: null }; return { running: false, ytDlp: health, ffmpeg: health, jsRuntime: health, spotdl: health }; }
    if (command === "mark_track_played") { emit("library://changed", { kind: "track-played", trackIds: [args.trackId], rootId: null }); return { trackId: args.trackId, lastPlayedAt: Date.now(), playCount: 1 }; }
    if (command === "list_library_folder") return { rootId: 1, relativePath: args.relativePath, path: args.relativePath ? `C:\\Music\\${args.relativePath}` : "C:\\Music", folders: args.relativePath ? [] : folders };
    if (command === "list_playlist_folders") return folders;
    if (command === "get_setting") return localStorage.getItem(args.key);
    if (command === "set_setting") { if (mock.failSave) throw new Error("Storage unavailable"); localStorage.setItem(args.update.key, args.update.value); }
    if (command === "import_playlist_image") return mock.imageResult;
    if (command === "copy_track_to_library_folder") return { status: "copied", folder: folders.find((folder) => folder.relativePath === args.relativePath) };
    if (command === "create_playlist_folder") { const folder = { ...folders[0], name: args.name, relativePath: args.name, path: `C:\\Music\\${args.name}`, directTrackCount: 0, indexedTrackCount: 0 }; folders.push(folder); return { status: "created", folder }; }
    return null;
  }
};
browser.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
function Harness() {
  const { route: { view } } = useNavigation();
  const setView = (view: ViewKey) => navigation.view(view);
  useEffect(installMouseNavigation, []);
  const [picker, setPicker] = useState(false);
  browser.playlistTest.openPicker = () => setPicker(true);
  return <LibraryActionsProvider value={{ notify: (message) => mock.notices.push(message), refreshLibrary: async () => {}, openArtist: () => {}, openAlbum: () => {} }}>
    <div className="appShell"><Sidebar active={view} onSelect={setView} compact={false} /><main className="mainPane">
      <header className="topBar"><div className="titleGroup"><div><h1>{view === "songs" ? "Songs" : "Playlists"}</h1><div className="topMeta"><span>480 songs</span><span>8 collections</span></div></div></div><div className="topBarSearch"><label className="searchBox"><Search size={16} /><input placeholder="Search your library" /></label></div></header>
      <div className="contentArea">{view === "songs" ? <div className="songStack"><VirtualSongList tracks={tracks} /></div> : <UserPlaylistsView tracks={tracks} onOpenFolders={() => {}} />}</div>
    </main><PlayerBar /></div>
    {picker && <PlaylistPicker track={tracks[0]} onClose={() => setPicker(false)} />}
  </LibraryActionsProvider>;
}
document.documentElement.dataset.background = "solid";
navigation.view(location.search.includes("empty") ? "songs" : designPreview ? "home" : "playlists");
createRoot(document.getElementById("root")!).render(location.search.includes("full-app") ? <App /> : <Harness />);
