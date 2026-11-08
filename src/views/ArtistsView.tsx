import { ChevronRight, UserRound } from "lucide-react";
import { Cover } from "../components/Cover";
import type { Artist, Track } from "../types";

type Props = {
  artists: Artist[];
  onOpenArtist: (artist: Artist) => void;
  searching?: boolean;
  tracks?: Track[];
};

export function ArtistsView({ artists, onOpenArtist, searching = false, tracks = [] }: Props) {
  const covers = new Map<string, string>();
  for (const track of tracks) if (track.artist && track.coverPath && !covers.has(track.artist)) covers.set(track.artist, track.coverPath);
  if (!artists.length) {
    return <section className="emptyState"><h2>No artists found</h2><p>{searching ? "Try a different artist name." : "Artist browsing will appear after a scan."}</p></section>;
  }

  return (
    <section className="artistCollection">
      <header className="collectionIntro"><span className="libraryEyebrow">YOUR LIBRARY</span><h2>Artists</h2><p>{artists.length} {artists.length === 1 ? "artist" : "artists"}</p></header>
      <div className="artistList artistCardGrid">
      {artists.map((artist) => (
        <button className="artistRow" key={artist.name} onClick={() => onOpenArtist(artist)} title={`Open ${artist.name}`}>
          <div className="artistAvatar">{covers.has(artist.name) ? <Cover path={covers.get(artist.name)} title={artist.name} size="lg" /> : <UserRound size={40} strokeWidth={1} />}</div>
          <div>
            <h3>{artist.name}</h3>
            <p>{artist.trackCount} tracks / {artist.albumCount} albums</p>
          </div>
          <ChevronRight size={18} className="rowChevron" />
        </button>
      ))}
      </div>
    </section>
  );
}
