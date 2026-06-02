import { UserRound } from "lucide-react";
import type { Artist } from "../types";

export function ArtistsView({ artists }: { artists: Artist[] }) {
  if (!artists.length) {
    return <section className="emptyState"><h2>No artists found</h2><p>Artist browsing will appear after a scan.</p></section>;
  }

  return (
    <section className="artistList">
      {artists.map((artist) => (
        <article className="artistRow" key={artist.name}>
          <div className="artistAvatar"><UserRound size={22} /></div>
          <div>
            <h3>{artist.name}</h3>
            <p>{artist.trackCount} tracks • {artist.albumCount} albums</p>
          </div>
        </article>
      ))}
    </section>
  );
}

