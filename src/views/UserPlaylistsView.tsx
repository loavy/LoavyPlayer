import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowUpRight, AudioLines, FolderOpen, ListMusic, LoaderCircle, Pause, Pencil, Play, Plus, Search, Shuffle } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { PromptDialog, validateWindowsFolderName } from "../components/OverlayDialogs";
import { PlaylistArtwork, PlaylistBanner, playlistStyle } from "../components/PlaylistArtwork";
import { PlaylistEditor } from "../components/PlaylistEditor";
import { VirtualSongList } from "../components/VirtualSongList";
import { api } from "../lib/api";
import { audioEngine } from "../lib/audioEngine";
import { errorMessage, useLibraryActions } from "../lib/LibraryContext";
import { defaultAppearance, playlistKey, retryPlaylistAppearances, usePlaylistAppearances } from "../lib/playlistAppearance";
import { navigation, useNavigation } from "../lib/navigation";
import { useAudioSelector } from "../lib/useAudio";
import { displayTrackTitle } from "../lib/format";
import type { LibraryFolderEntry, Track } from "../types";

type Props = { tracks: Track[]; onOpenFolders: () => void };

export function UserPlaylistsView({ tracks, onOpenFolders }: Props) {
  const { notify } = useLibraryActions();
  const appearances = usePlaylistAppearances();
  const [folders, setFolders] = useState<LibraryFolderEntry[]>([]);
  const selectedKey = useNavigation().route.playlist;
  const selected = useMemo(() => folders.find((folder) => playlistKey(folder) === selectedKey) || null, [folders, selectedKey]);
  const pageRef = useRef<HTMLElement>(null);
  const playback = useAudioSelector((audio) => ({ key: audio.playlistKey, current: audio.current, playing: audio.playing }),
    (a, b) => a.key === b.key && a.current === b.current && a.playing === b.playing);
  const [editing, setEditing] = useState<LibraryFolderEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("name");
  const deferredQuery = useDeferredValue(query);
  const revisionRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const folderRefs = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusRef = useRef<string | null>(null);

  const loadFolders = useCallback(async (showLoading = false) => {
    const revision = ++revisionRef.current;
    if (showLoading) setLoading(true);
    setLoadError(null);
    try {
      const next = await api.listPlaylistFolders();
      if (revision !== revisionRef.current) return;
      setFolders(next);
    } catch (reason) {
      if (revision === revisionRef.current) setLoadError(errorMessage(reason));
    } finally {
      if (revision === revisionRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFolders(true);
    const unlisten = listen<{ kind: string }>("library://changed", (event) => {
      if (event.payload.kind !== "track-played") void loadFolders();
    }).catch(() => null);
    return () => { revisionRef.current++; void unlisten.then((remove) => remove?.()); };
  }, [loadFolders]);

  const normalizedTracks = useMemo(() => tracks.map((track) => ({ track, path: normalizePath(track.path) })), [tracks]);
  const folderTracks = useCallback((folder: LibraryFolderEntry) => {
    const prefix = `${normalizePath(folder.path)}\\`;
    return normalizedTracks.filter(({ path }) => path.startsWith(prefix)).map(({ track }) => track);
  }, [normalizedTracks]);
  const selectedTracks = useMemo(() => selected ? folderTracks(selected) : [], [selected, folderTracks]);
  const covers = useMemo(() => {
    const withCovers = normalizedTracks.filter(({ track }) => track.coverPath);
    return new Map(folders.map((folder) => {
      const prefix = `${normalizePath(folder.path)}\\`;
      return [playlistKey(folder), withCovers.find(({ path }) => path.startsWith(prefix))?.track.coverPath];
    }));
  }, [folders, normalizedTracks]);
  const appearanceFor = (folder: LibraryFolderEntry) => appearances.items[playlistKey(folder)] || defaultAppearance(folder);
  const visible = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    return folders.filter((folder) => {
      const look = appearances.items[playlistKey(folder)];
      return !needle || `${look?.name || folder.name} ${look?.description || ""}`.toLocaleLowerCase().includes(needle);
    }).sort((a, b) => sort === "tracks" ? b.indexedTrackCount - a.indexedTrackCount :
      (appearances.items[playlistKey(a)]?.name || a.name).localeCompare(appearances.items[playlistKey(b)]?.name || b.name, undefined, { numeric: true, sensitivity: "base" }));
  }, [folders, appearances.items, deferredQuery, sort]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (selectedKey) headingRef.current?.focus();
      else if (returnFocusRef.current) folderRefs.current.get(returnFocusRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedKey]);

  function open(folder: LibraryFolderEntry) {
    returnFocusRef.current = playlistKey(folder);
    navigation.navigate({ ...navigation.current(), view: "playlists", playlist: playlistKey(folder) });
  }
  function play(folder: LibraryFolderEntry, shuffle = false) {
    if (!shuffle && playback.key === playlistKey(folder) && playback.current) { void audioEngine.toggle(); return; }
    const queue = folderTracks(folder);
    if (shuffle) for (let index = queue.length - 1; index > 0; index--) {
      const swap = Math.floor(Math.random() * (index + 1));
      [queue[index], queue[swap]] = [queue[swap], queue[index]];
    }
    if (queue.length) void audioEngine.playTrack(queue[0], queue, 0, playlistKey(folder));
  }
  async function reveal(folder: LibraryFolderEntry) {
    try { await api.revealLibraryFolder(folder.rootId, folder.relativePath); }
    catch (reason) { notify(`Could not open this folder: ${errorMessage(reason)}`, "error"); }
  }
  async function create(name: string) {
    setBusy(true);
    try {
      const result = await api.createPlaylistFolder(name);
      await loadFolders(false);
      setCreating(false); open(result.folder);
      setEditing(result.folder);
      notify(result.status === "created" ? `Created “${result.folder.name}”.` : `Opened “${result.folder.name}”.`, "success");
    } catch (reason) { notify(`Could not create playlist: ${errorMessage(reason)}`, "error"); }
    finally { setBusy(false); }
  }

  const editor = editing && appearances.loaded && <PlaylistEditor key={playlistKey(editing)} folder={editing} appearance={appearanceFor(editing)} fallback={covers.get(playlistKey(editing))}
    onClose={() => setEditing(null)} onSaved={() => notify("Playlist updated. Looking good.", "success")} />;

  if (selected) {
    const look = appearanceFor(selected);
    const minutes = Math.round(selectedTracks.reduce((total, track) => total + (track.durationMs || 0), 0) / 60000);
    const active = playback.key === selectedKey && !!playback.current;
    return <section className="playlistDetailView" ref={pageRef} style={playlistStyle(look)} data-playlist-source="folder">
      <header className="playlistHero">
        <PlaylistBanner appearance={look} />
        <button className="playlistBackButton" onClick={() => navigation.view("playlists")} aria-label="Back to playlists"><ArrowLeft size={18} /></button>
        <button className="playlistHeroCover" onClick={() => setEditing(selected)} disabled={!appearances.loaded} aria-label="Edit playlist cover"><PlaylistArtwork appearance={look} fallback={covers.get(selectedKey!)} /><span><Pencil size={18} /> Change cover</span></button>
        <div className="playlistHeroText"><span className="playlistEyebrow">YOUR PLAYLIST</span>
          <h2 ref={headingRef} tabIndex={-1}>{look.name}</h2>
          {look.description && <p>{look.description}</p>}
          <div className="playlistHeroMeta"><span>Made by you</span><i />{selectedTracks.length} songs{minutes > 0 && <><i />{minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`}</>}</div>
        </div>
      </header>
      <div className="playlistActionBar">
        <button className="playlistPlayButton" onClick={() => play(selected)} disabled={!selectedTracks.length}>{active && playback.playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />} {active && playback.playing ? "Pause" : active ? "Resume" : "Play"}</button>
        <button className="iconButton" onClick={() => play(selected, true)} disabled={!selectedTracks.length} aria-label="Shuffle playlist" title="Shuffle"><Shuffle size={20} /></button>
        <button className="secondaryAction playlistEditButton" onClick={() => setEditing(selected)} disabled={!appearances.loaded}><Pencil size={15} /> Edit playlist</button>
        <button className="playlistFolderLink" onClick={() => void reveal(selected)} title={selected.path}><FolderOpen size={16} /><span>Open folder</span><ArrowUpRight size={13} /></button>
      </div>
      <div className="playlistTrackHost">
        {selectedTracks.length ? <VirtualSongList tracks={selectedTracks} playbackQueue={selectedTracks} scrollParentRef={pageRef} playlistKey={selectedKey!} /> :
          <section className="emptyState compactEmpty"><ListMusic size={32} /><h2>A fresh start.</h2><p>Add a song from its menu to start this playlist.</p></section>}
      </div>
      {editor}
    </section>;
  }

  return <section className="userPlaylistsView" data-playlist-source="folder">
    <header className="playlistsIntro"><div><span>CURATED BY YOU</span><h2>Every mood. Every moment.</h2><p>Your music, in collections that feel like you.</p></div>
      <button className="primaryAction" onClick={() => setCreating(true)}><Plus size={17} /> New playlist</button>
    </header>
    <div className="playlistCollectionToolbar">
      <label className="playlistSearch"><Search size={16} /><input aria-label="Find a playlist" placeholder="Find a playlist" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <span>{visible.length} playlists</span>
      <select aria-label="Sort playlists" value={sort} onChange={(event) => setSort(event.target.value)}><option value="name">Name A–Z</option><option value="tracks">Most songs</option></select>
      <button className="iconButton" title="Browse folders" aria-label="Browse folders" onClick={onOpenFolders}><FolderOpen size={17} /></button>
    </div>
    {appearances.error && <p className="playlistAppearanceError" role="status">Your saved playlist style could not be loaded. <button className="secondaryAction" onClick={() => void retryPlaylistAppearances().catch(() => undefined)}>Try again</button></p>}
    {loading ? <div className="emptyState"><LoaderCircle size={28} className="spin" /><p>Finding your collections…</p></div> :
      loadError ? <div className="emptyState" role="alert"><h2>Could not load playlists</h2><p>{loadError}</p><button className="secondaryAction" onClick={() => void loadFolders(true)}>Try again</button></div> :
      visible.length ? <div className="playlistGrid" role="list" aria-label="Your playlists">
        {visible.map((folder) => {
          const key = playlistKey(folder); const look = appearanceFor(folder);
          const active = playback.key === key && !!playback.current;
          return <div className={`playlistGridItem${active ? " activePlaylist" : ""}`} role="listitem" key={key} style={playlistStyle(look)}>
            <button className="playlistCard" onClick={() => open(folder)} ref={(node) => { if (node) folderRefs.current.set(key, node); else folderRefs.current.delete(key); }}>
              <PlaylistArtwork appearance={look} fallback={covers.get(key)} />
              <strong title={look.name}>{look.name}</strong>{active ? <span className="playlistPlayingStatus" title={displayTrackTitle(playback.current!)}><AudioLines size={13} />{playback.playing ? "Playing" : "Paused"} · {displayTrackTitle(playback.current!)}</span> : <span>{folder.indexedTrackCount} songs{look.description ? ` · ${look.description}` : " · Your collection"}</span>}
            </button>
            <button className="playlistCardEdit" onClick={() => setEditing(folder)} disabled={!appearances.loaded} aria-label={`Edit ${look.name}`}><Pencil size={15} /></button>
            <button className="playlistCardPlay" onClick={() => play(folder)} disabled={!folder.indexedTrackCount} aria-label={`${active && playback.playing ? "Pause" : active ? "Resume" : "Play"} ${look.name}`}>{active && playback.playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>
          </div>;
        })}
      </div> : <div className="emptyState"><ListMusic size={38} /><h2>{query ? "No playlists found" : "Make room for your favorites."}</h2><p>{query ? "Try a different name." : "Create a playlist, add a few songs, and make it yours."}</p>{!query && <button className="primaryAction" onClick={() => setCreating(true)}><Plus size={16} /> New playlist</button>}</div>}
    {creating && <PromptDialog title="A new collection" description="Give your playlist a name. You can add artwork and color next." label="Playlist name" submitLabel="Create playlist" busy={busy} validate={validateWindowsFolderName} onSubmit={(name) => void create(name)} onClose={() => !busy && setCreating(false)} />}
    {editor}
  </section>;
}

function normalizePath(path: string) { return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase(); }
