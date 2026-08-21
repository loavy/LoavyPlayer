import type { Track } from "../types";
import { VirtualSongList } from "../components/VirtualSongList";

type Props = {
  tracks: Track[];
  collectionFilter?: { type: "album" | "artist"; value: string } | null;
  onClearCollectionFilter?: () => void;
  emptyKind?: "library" | "favorites" | "recent" | "search";
};

export function SongsView({ tracks, collectionFilter, onClearCollectionFilter, emptyKind = "library" }: Props) {
  if (!tracks.length) {
    const content = collectionFilter
      ? { title: "No songs in this collection", text: "Try another album or artist." }
      : emptyKind === "favorites"
        ? { title: "No favorites yet", text: "Use the heart or a song's menu to keep your favorites close." }
        : emptyKind === "recent"
          ? { title: "Nothing played recently", text: "Songs you play will appear here." }
          : emptyKind === "search"
            ? { title: "No matches", text: "Try a different title, artist, album, or genre." }
            : { title: "No songs yet", text: "Select a music folder in Settings, then scan your library." };
    return (
      <section className="emptyState">
        <h2>{content.title}</h2>
        <p>{content.text}</p>
        {collectionFilter && onClearCollectionFilter && (
          <button className="secondaryAction" onClick={onClearCollectionFilter}>Show all songs</button>
        )}
      </section>
    );
  }

  return (
    <section className="songStack">
      {collectionFilter && (
        <div className="collectionHeader">
          <div>
            <span>{collectionFilter.type}</span>
            <strong>{collectionFilter.value}</strong>
          </div>
          {onClearCollectionFilter && <button className="secondaryAction" onClick={onClearCollectionFilter}>Show all songs</button>}
        </div>
      )}
      <VirtualSongList tracks={tracks} />
    </section>
  );
}
