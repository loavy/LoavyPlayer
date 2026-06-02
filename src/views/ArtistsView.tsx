import { ChevronRight, UserRound } from "lucide-react";
import type { Artist } from "../types";

type Props = {
  artists: Artist[];
  onOpenArtist: (artist: Artist) => void;
};

export function ArtistsView({ artists, onOpenArtist }: Props) {
  if (!artists.length) {
    return <section className="emptyState"><h2>No artists found</h2><p>Artist browsing will appear after a scan.</p></section>;
  }

  return (
    <section className="artistList">
      {artists.map((artist) => (
        <button className="artistRow" key={artist.name} onClick={() => onOpenArtist(artist)} title={`Open ${artist.name}`}>
          <div className="artistAvatar"><UserRound size={22} /></div>
          <div>
            <h3>{artist.name}</h3>
            <p>{artist.trackCount} tracks / {artist.albumCount} albums</p>
          </div>
          <ChevronRight size={18} className="rowChevron" />
        </button>
      ))}
    </section>
  );
}
