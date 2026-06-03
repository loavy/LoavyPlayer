import { FolderPlus, ListMusic, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { Playlist, Track } from "../types";
import { displayArtist, displayTrackTitle } from "../lib/format";

type Props = {
  playlists: Playlist[];
  tracks: Track[];
  onCreatePlaylist: (name: string) => Promise<void>;
  onAddTrack: (playlistId: number, trackId: number) => Promise<void>;
  onOpenPlaylist: (playlistId: number) => Promise<void>;
};

export function PlaylistsView({ playlists, tracks, onCreatePlaylist, onAddTrack, onOpenPlaylist }: Props) {
  const [name, setName] = useState("");
  const [selectedPlaylist, setSelectedPlaylist] = useState<number | null>(playlists[0]?.id || null);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(tracks[0]?.id || null);
  const sortedTracks = useMemo(
    () => [...tracks].sort((a, b) => displayTrackTitle(a).localeCompare(displayTrackTitle(b))),
    [tracks]
  );

  async function createPlaylist() {
    const trimmed = name.trim();
    if (!trimmed) return;
    await onCreatePlaylist(trimmed);
    setName("");
  }

  async function addTrack() {
    if (!selectedPlaylist || !selectedTrack) return;
    await onAddTrack(selectedPlaylist, selectedTrack);
  }

  return (
    <section className="playlistLayout">
      <div className="settingsPanel playlistComposer">
        <header><FolderPlus size={19} /><h2>Create playlist folder</h2></header>
        <div className="playlistCreateRow">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Playlist name" />
          <button className="primaryAction" onClick={() => void createPlaylist()} disabled={!name.trim()}>
            <Plus size={17} /> Create
          </button>
        </div>
        <div className="playlistCreateRow">
          <select value={selectedPlaylist || ""} onChange={(event) => setSelectedPlaylist(Number(event.target.value) || null)}>
            <option value="">Choose playlist</option>
            {playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
          </select>
          <select value={selectedTrack || ""} onChange={(event) => setSelectedTrack(Number(event.target.value) || null)}>
            <option value="">Choose song</option>
            {sortedTracks.map((track) => (
              <option key={track.id} value={track.id}>
                {displayTrackTitle(track)} - {displayArtist(track.artist)}
              </option>
            ))}
          </select>
          <button className="secondaryAction" onClick={() => void addTrack()} disabled={!selectedPlaylist || !selectedTrack}>
            <Plus size={17} /> Add
          </button>
        </div>
      </div>

      <div className="playlistGrid">
        {playlists.map((playlist) => (
          <button className="playlistCard" key={playlist.id} onClick={() => void onOpenPlaylist(playlist.id)}>
            <ListMusic size={22} />
            <strong>{playlist.name}</strong>
            <span>{playlist.trackCount} songs</span>
          </button>
        ))}
        {!playlists.length && (
          <section className="emptyState">
            <h2>No playlists yet</h2>
            <p>Create a playlist folder, then add songs to it.</p>
          </section>
        )}
      </div>
    </section>
  );
}
