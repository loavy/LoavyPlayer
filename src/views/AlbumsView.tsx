import { Disc3, ArrowUpRight } from "lucide-react";
import { Cover } from "../components/Cover";
import { displayArtist } from "../lib/format";
import type { Album } from "../types";

type Props = {
  albums: Album[];
  onOpenAlbum: (album: Album) => void;
  searching?: boolean;
};

export function AlbumsView({ albums, onOpenAlbum, searching = false }: Props) {
  if (!albums.length) {
    return <section className="emptyState"><span className="emptyRecord"><Disc3 size={36} strokeWidth={1.3} /></span><h2>No albums found</h2><p>{searching ? "Try a different album or artist." : "Album groupings will appear after a scan."}</p></section>;
  }

  return (
    <section className="albumCollection">
      <header className="collectionIntro"><span className="libraryEyebrow">YOUR LIBRARY</span><h2>Albums</h2><p>{albums.length} {albums.length === 1 ? "album" : "albums"}</p></header>
      <div className="cardGrid">
      {albums.map((album) => (
        <button
          className="mediaCard"
          key={`${album.artist}-${album.title}`}
          onClick={() => onOpenAlbum(album)}
          title={`Open ${album.title}`}
        >
          <span className="albumCardArtwork"><Cover path={album.coverPath} title={album.title} size="lg" /><span className="albumOpenIcon" aria-hidden="true"><ArrowUpRight size={20} /></span></span>
          <h3>{album.title}</h3>
          <p>{displayArtist(album.artist)}</p>
          <small>{album.trackCount} tracks{album.year ? ` / ${album.year}` : ""}</small>
        </button>
      ))}
      </div>
    </section>
  );
}
