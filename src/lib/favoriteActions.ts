import { api } from "./api";
import { audioEngine } from "./audioEngine";

const mutations = new Map<number, Promise<boolean>>();

/**
 * Serializes optimistic favorite changes per track so controls in the full
 * player, context menu, keyboard shortcut, and Mini Player cannot commit
 * out-of-order values to SQLite.
 */
export function toggleAudioTrackFavorite(trackId: number, favoriteHint?: boolean): Promise<boolean> {
  if (!Number.isInteger(trackId) || trackId <= 0) {
    return Promise.reject(new Error("Favorites are only available for local library songs."));
  }

  const pendingMutation = mutations.get(trackId);
  const previousMutation = pendingMutation ?? Promise.resolve(false);
  let mutation: Promise<boolean>;
  mutation = previousMutation
    .catch(() => false)
    .then(async (queuedFavorite) => {
      const snapshot = audioEngine.snapshot();
      const track = snapshot.current?.id === trackId
        ? snapshot.current
        : snapshot.queue.find((candidate) => candidate.id === trackId);
      const previousFavorite = track?.favorite ?? (pendingMutation ? queuedFavorite : favoriteHint);
      if (previousFavorite === undefined) {
        throw new Error("This song is no longer available in the playback queue.");
      }
      const favorite = !previousFavorite;
      audioEngine.patchTrackFavorite(trackId, favorite);
      try {
        await api.setTrackFavorite(trackId, favorite);
        window.dispatchEvent(new CustomEvent("loavy:favorite-changed", {
          detail: { trackId, favorite }
        }));
        return favorite;
      } catch (error) {
        audioEngine.patchTrackFavorite(trackId, previousFavorite);
        throw error;
      }
    })
    .finally(() => {
      if (mutations.get(trackId) === mutation) mutations.delete(trackId);
    });
  mutations.set(trackId, mutation);
  return mutation;
}
