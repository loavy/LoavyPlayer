import type { Track } from "../types";
import { VirtualSongList } from "../components/VirtualSongList";

type Props = {
  tracks: Track[];
  collectionFilter?: { type: "album" | "artist"; value: string } | null;
  onClearCollectionFilter?: () => void;
};

export function SongsView({ tracks, collectionFilter, onClearCollectionFilter }: Props) {
  if (!tracks.length) {
    return (
      <section className="emptyState">
        <h2>{collectionFilter ? "No songs in this collection" : "No songs yet"}</h2>
        <p>{collectionFilter ? "Try another album or artist." : "Select a music folder in Settings, then scan your library."}</p>
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
