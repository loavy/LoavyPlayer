import type { Track } from "../types";
import { VirtualSongList } from "../components/VirtualSongList";

type Props = {
  tracks: Track[];
};

export function SongsView({ tracks }: Props) {
  if (!tracks.length) {
    return (
      <section className="emptyState">
        <h2>No songs yet</h2>
        <p>Select a music folder in Settings, then scan your library.</p>
      </section>
    );
  }

  return <VirtualSongList tracks={tracks} />;
}
