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

const names = ["After hours", "Soft focus", "Somewhere, elsewhere", "Golden hour", "On repeat", "A little louder", "Sunday morning", "The long way home"];
const folders: LibraryFolderEntry[] = names.map((name, i) => ({ rootId: 1, name, relativePath: name, path: `C:\\Music\\${name}`, directTrackCount: 60, indexedTrackCount: 60 }));
const tracks: Track[] = folders.flatMap((folder, f) => Array.from({ length: 60 }, (_, i) => ({ id: f * 60 + i + 1, path: `${folder.path}\\${i}.mp3`, fileName: `${i}.mp3`, fileExt: "mp3", fileSize: 100, modifiedAt: 0, title: ["Late night conversations (a very long title that should never hide the controls)", "Weightless", "Everything in its right place", "A walk through the city"][i % 4], artist: ["Unknown Artist", "Marconi Union", "Radiohead", "Nujabes"][i % 4], album: "Selected works", durationMs: 217000, favorite: i % 3 === 0, dateAdded: 0, playCount: 0 })));
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
browser.__TAURI_INTERNALS__ = {
  transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; },
  convertFileSrc: (path: string) => path,
  async invoke(command: string, args: any = {}) {
    mock.commands.push(command);
    if (command === "plugin:event|listen") { const handlers = listeners.get(args.event) || new Set(); handlers.add(args.handler); listeners.set(args.event, handlers); return args.handler; }
    if (command === "plugin:event|unlisten") listeners.get(args.event)?.delete(args.eventId);
    if (command === "list_tracks") return tracks;
    if (command === "list_music_folders") return [{ id: 1, path: "C:\\Music", enabled: true, createdAt: 0 }];
    if (["list_albums", "list_artists", "list_fetchers"].includes(command)) return [];
    if (command === "get_scan_state") return { running: false, cancelRequested: false };
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
navigation.view("playlists");
createRoot(document.getElementById("root")!).render(location.search.includes("full-app") ? <App /> : <Harness />);
