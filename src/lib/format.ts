export function formatDuration(ms?: number | null): string {
  if (!ms || ms < 0) return "--:--";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function displayTrackTitle(track: { title?: string | null; fileName: string }) {
  return track.title?.trim() || track.fileName.replace(/\.[^.]+$/, "");
}

export function displayArtist(artist?: string | null) {
  return artist?.trim() || "Unknown Artist";
}

export function displayAlbum(album?: string | null) {
  return album?.trim() || "Unknown Album";
}

