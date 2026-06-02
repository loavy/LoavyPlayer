import { Cover } from "../components/Cover";
import { displayArtist } from "../lib/format";
import type { Album } from "../types";

type Props = {
  albums: Album[];
  onOpenAlbum: (album: Album) => void;
};

export function AlbumsView({ albums, onOpenAlbum }: Props) {
  if (!albums.length) {
    return <section className="emptyState"><h2>No albums found</h2><p>Album groupings will appear after a scan.</p></section>;
  }

  return (
    <section className="cardGrid">
      {albums.map((album) => (
        <button
          className="mediaCard"
          key={`${album.artist}-${album.title}`}
          onClick={() => onOpenAlbum(album)}
          title={`Open ${album.title}`}
        >
          <Cover path={album.coverPath} title={album.title} size="lg" />
          <h3>{album.title}</h3>
          <p>{displayArtist(album.artist)}</p>
          <small>{album.trackCount} tracks{album.year ? ` / ${album.year}` : ""}</small>
        </button>
      ))}
    </section>
  );
}
