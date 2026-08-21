import { ArrowLeft, ListMusic, LoaderCircle, Pencil, Play, Plus, Shuffle, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { VirtualSongList } from "../components/VirtualSongList";
import { ConfirmDialog, PromptDialog, validateDisplayName } from "../components/OverlayDialogs";
import { api } from "../lib/api";
import { audioEngine } from "../lib/audioEngine";
import { errorMessage, useLibraryActions } from "../lib/LibraryContext";
import type { Playlist, Track } from "../types";

type PromptMode = { kind: "create" } | { kind: "rename"; playlist: Playlist };

export function UserPlaylistsView() {
  const { notify } = useLibraryActions();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selected, setSelected] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<PromptMode | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Playlist | null>(null);

  const refreshPlaylists = useCallback(async (preferredId?: number | null) => {
    const next = await api.listPlaylists();
    setPlaylists(next);
    const targetId = preferredId === undefined ? selected?.id : preferredId;
    const nextSelected = targetId ? next.find((playlist) => playlist.id === targetId) || null : null;
    setSelected(nextSelected);
    if (nextSelected) setTracks(await api.listPlaylistTracks(nextSelected.id));
    else setTracks([]);
  }, [selected?.id]);

  useEffect(() => {
    let disposed = false;
    api.listPlaylists()
      .then((next) => !disposed && setPlaylists(next))
      .catch((error) => !disposed && notify(errorMessage(error), "error"))
      .finally(() => !disposed && setLoading(false));

    function onPlaylistsChanged() {
      void refreshPlaylists().catch((error) => notify(errorMessage(error), "error"));
    }
    function onLibraryChanged() {
      void refreshPlaylists().catch((error) => notify(errorMessage(error), "error"));
    }
    function onFavoriteChanged(event: Event) {
      const detail = (event as CustomEvent<{ trackId: number; favorite: boolean }>).detail;
      if (!detail || !Number.isInteger(detail.trackId)) return;
      setTracks((current) => current.map((track) => track.id === detail.trackId
        ? { ...track, favorite: detail.favorite }
        : track));
    }
    window.addEventListener("loavy:playlists-changed", onPlaylistsChanged);
    window.addEventListener("loavy:library-changed", onLibraryChanged);
    window.addEventListener("loavy:favorite-changed", onFavoriteChanged);
    return () => {
      disposed = true;
      window.removeEventListener("loavy:playlists-changed", onPlaylistsChanged);
      window.removeEventListener("loavy:library-changed", onLibraryChanged);
      window.removeEventListener("loavy:favorite-changed", onFavoriteChanged);
    };
  }, [notify, refreshPlaylists]);

  async function openPlaylist(playlist: Playlist) {
    setSelected(playlist);
    setLoading(true);
    try {
      setTracks(await api.listPlaylistTracks(playlist.id));
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setLoading(false);
    }
  }

  async function submitPrompt(name: string) {
    setBusy(true);
    try {
      if (prompt?.kind === "rename") {
        const renamed = await api.renamePlaylist(prompt.playlist.id, name);
        await refreshPlaylists(renamed.id);
        notify("Playlist renamed.", "success");
      } else {
        const created = await api.createPlaylist(name);
        await refreshPlaylists(created.id);
        notify("Playlist created.", "success");
      }
      setPrompt(null);
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function deletePlaylist() {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await api.deletePlaylist(confirmDelete.id);
      setConfirmDelete(null);
      await refreshPlaylists(null);
      notify("Playlist deleted. Your music files were not changed.", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function removeTrack(track: Track) {
    if (!selected) return;
    try {
      await api.removeTrackFromPlaylist(selected.id, track.id);
      const next = tracks.filter((candidate) => candidate.id !== track.id);
      setTracks(next);
      setSelected({ ...selected, trackCount: Math.max(0, selected.trackCount - 1), updatedAt: Date.now() });
      setPlaylists((current) => current.map((playlist) => playlist.id === selected.id ? { ...playlist, trackCount: Math.max(0, playlist.trackCount - 1), updatedAt: Date.now() } : playlist));
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function moveTrack(_track: Track, index: number, direction: -1 | 1) {
    if (!selected) return;
    const target = index + direction;
    if (target < 0 || target >= tracks.length) return;
    const next = [...tracks];
    [next[index], next[target]] = [next[target], next[index]];
    setTracks(next);
    try {
      await api.reorderPlaylistTracks(selected.id, next.map((track) => track.id));
    } catch (error) {
      setTracks(tracks);
      notify(errorMessage(error), "error");
    }
  }

  function play(shuffle = false) {
    if (!tracks.length) return;
    const queue = shuffle ? shuffleTracks(tracks) : tracks;
    void audioEngine.playTrack(queue[0], queue, 0);
  }

  if (selected) {
    return (
      <section className="playlistDetailView">
        <header className="playlistDetailHeader">
          <button className="iconButton" onClick={() => { setSelected(null); setTracks([]); }} aria-label="Back to playlists"><ArrowLeft size={19} /></button>
          <span className="playlistHeroIcon"><ListMusic size={30} /></span>
          <div><span>Playlist</span><h2>{selected.name}</h2><p>{tracks.length} {tracks.length === 1 ? "song" : "songs"} · created {new Date(selected.createdAt).toLocaleDateString()}</p></div>
          <div className="playlistDetailActions">
            <button className="primaryAction" onClick={() => play(false)} disabled={!tracks.length}><Play size={17} fill="currentColor" /> Play</button>
            <button className="secondaryAction" onClick={() => play(true)} disabled={!tracks.length}><Shuffle size={17} /> Shuffle</button>
            <button className="iconButton" onClick={() => setPrompt({ kind: "rename", playlist: selected })} aria-label="Rename playlist"><Pencil size={17} /></button>
            <button className="iconButton dangerAction" onClick={() => setConfirmDelete(selected)} aria-label="Delete playlist"><Trash2 size={17} /></button>
          </div>
        </header>
        <div className="playlistTrackHost">
          {loading ? <div className="inlineLoading"><LoaderCircle className="spin" size={22} /> Loading playlist</div> : tracks.length ? (
            <VirtualSongList tracks={tracks} playbackQueue={tracks} onRemoveTrack={removeTrack} onMoveTrack={moveTrack} />
          ) : (
            <section className="emptyState compactEmpty"><ListMusic size={38} /><h2>This playlist is empty</h2><p>Open a song menu and choose Add to playlist.</p></section>
          )}
        </div>
        {prompt?.kind === "rename" && <PromptDialog title="Rename playlist" label="Playlist name" initialValue={prompt.playlist.name} submitLabel="Save name" busy={busy} validate={validateDisplayName} onSubmit={(value) => void submitPrompt(value)} onClose={() => setPrompt(null)} />}
        {confirmDelete && <ConfirmDialog title={`Delete “${confirmDelete.name}”?`} description="This removes the playlist only. Your music files stay where they are." confirmLabel="Delete playlist" danger busy={busy} onConfirm={() => void deletePlaylist()} onClose={() => setConfirmDelete(null)} />}
      </section>
    );
  }

  if (loading) return <section className="emptyState"><LoaderCircle className="spin" size={32} /><h2>Loading playlists</h2></section>;

  return (
    <section className="userPlaylistsView">
      <header className="playlistsIntro">
        <div><span>Your library</span><h2>Playlists</h2><p>Build collections without moving or copying any music files.</p></div>
        <button className="primaryAction" onClick={() => setPrompt({ kind: "create" })}><Plus size={17} /> Create playlist</button>
      </header>
      {playlists.length ? (
        <div className="playlistGrid">
          {playlists.map((playlist) => (
            <button className="playlistCard" key={playlist.id} onClick={() => void openPlaylist(playlist)}>
              <span className="playlistCardIcon"><ListMusic size={26} /></span>
              <strong>{playlist.name}</strong>
              <span>{playlist.trackCount} {playlist.trackCount === 1 ? "song" : "songs"}</span>
              <small>Updated {relativeDate(playlist.updatedAt)}</small>
            </button>
          ))}
        </div>
      ) : (
        <section className="emptyState compactEmpty">
          <span className="emptyStateIcon"><ListMusic size={42} /></span>
          <h2>Create your first playlist</h2>
          <p>Group songs for a mood, activity, or anything else—your folders stay untouched.</p>
          <button className="primaryAction" onClick={() => setPrompt({ kind: "create" })}><Plus size={17} /> Create playlist</button>
        </section>
      )}
      {prompt?.kind === "create" && <PromptDialog title="New playlist" description="Give this collection a memorable name." label="Playlist name" submitLabel="Create playlist" busy={busy} validate={validateDisplayName} onSubmit={(value) => void submitPrompt(value)} onClose={() => setPrompt(null)} />}
    </section>
  );
}

function shuffleTracks(tracks: Track[]) {
  const next = [...tracks];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [next[index], next[target]] = [next[target], next[index]];
  }
  return next;
}

function relativeDate(timestamp: number) {
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString();
}
