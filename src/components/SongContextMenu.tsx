import {
  Disc3,
  FolderOpen,
  Heart,
  ListMusic,
  ListPlus,
  Play,
  SkipForward,
  Trash2,
  UserRound
} from "lucide-react";
import { useState } from "react";
import type { LibraryChange, Track, TrackDeleteResult } from "../types";
import { api } from "../lib/api";
import { audioEngine } from "../lib/audioEngine";
import { displayTrackTitle } from "../lib/format";
import { errorMessage, useLibraryActions } from "../lib/LibraryContext";
import { ConfirmDialog } from "./OverlayDialogs";
import { ContextMenu, MenuItem, MenuSeparator, type MenuPoint } from "./ContextMenu";
import { PlaylistPicker } from "./PlaylistPicker";

export type SongContextMenuProps = {
  track: Track;
  point: MenuPoint;
  onClose: () => void;
  onNavigate?: () => void;
  playbackQueue?: readonly Track[];
  queueIndex?: number;
};

export function SongContextMenu({
  track,
  point,
  onClose,
  onNavigate,
  playbackQueue,
  queueIndex
}: SongContextMenuProps) {
  const { notify, openAlbum, openArtist } = useLibraryActions();
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const localTrack = !isRemoteTrack(track);
  const title = displayTrackTitle(track);
  const artist = track.artist?.trim();
  const album = track.album?.trim();

  function closeThen(action: () => unknown | Promise<unknown>) {
    onClose();
    void Promise.resolve()
      .then(action)
      .catch((error) => notify(errorMessage(error), "error"));
  }

  function play() {
    const requestedQueue = playbackQueue?.length ? [...playbackQueue] : [track];
    const requestedMatch = requestedQueue.findIndex((candidate) => sameTrack(candidate, track));
    const queue = requestedMatch >= 0 ? requestedQueue : [track];
    const matchingIndex = requestedMatch >= 0 ? requestedMatch : 0;
    const requestedIndex = queueIndex ?? matchingIndex;
    const index = requestedIndex >= 0
      && requestedIndex < queue.length
      && sameTrack(queue[requestedIndex], track)
      ? requestedIndex
      : Math.max(0, matchingIndex);
    closeThen(() => audioEngine.playTrack(track, queue, index));
  }

  function playNext() {
    closeThen(() => audioEngine.playNext(track));
  }

  function addToQueue() {
    closeThen(() => audioEngine.addToQueue(track));
  }

  async function toggleFavorite() {
    const favorite = !track.favorite;
    try {
      await api.setTrackFavorite(track.id, favorite);
      audioEngine.patchTrackFavorite(track.id, favorite);
      window.dispatchEvent(new CustomEvent("loavy:favorite-changed", {
        detail: { trackId: track.id, favorite }
      }));
      notify(favorite ? `Added “${title}” to Favorites.` : `Removed “${title}” from Favorites.`, "success");
    } catch (error) {
      notify(`Could not update Favorites: ${errorMessage(error)}`, "error");
    }
  }

  async function revealTrack() {
    try {
      await api.revealTrack(track.id);
    } catch (error) {
      notify(`Could not show “${title}” in File Explorer: ${errorMessage(error)}`, "error");
    }
  }

  async function deleteTrack() {
    setDeleting(true);
    let removal: ReturnType<typeof audioEngine.prepareTrackRemoval> = null;
    try {
      removal = audioEngine.prepareTrackRemoval(track);
    } catch (error) {
      notify(`Could not prepare “${title}” for deletion: ${errorMessage(error)}`, "error");
      setDeleting(false);
      return;
    }

    let result: TrackDeleteResult;
    try {
      result = await api.deleteTrackToTrash(track.id);
    } catch (error) {
      let rollbackMessage = "";
      if (removal) {
        try {
          const restored = await audioEngine.rollbackTrackRemoval(removal);
          if (!restored) rollbackMessage = " Playback state also could not be restored.";
        } catch (rollbackError) {
          rollbackMessage = ` Playback state also could not be restored: ${errorMessage(rollbackError)}`;
        }
      }
      notify(`Could not move “${title}” to the Recycle Bin: ${errorMessage(error)}${rollbackMessage}`, "error");
      setDeleting(false);
      return;
    }

    let queueWarning = "";
    if (removal) {
      try {
        const committed = await audioEngine.commitTrackRemoval(removal);
        if (!committed) queueWarning = "The playback queue changed before the deleted song could be removed from it.";
      } catch (error) {
        queueWarning = `The song was deleted, but the playback queue could not update: ${errorMessage(error)}`;
      }
    }

    const detail: LibraryChange = {
      kind: "track-deleted",
      trackIds: [track.id],
      rootId: null
    };
    window.dispatchEvent(new CustomEvent<LibraryChange>("loavy:library-changed", { detail }));
    window.dispatchEvent(new CustomEvent("loavy:track-deleted", { detail }));
    notify(
      result.alreadyMissing
        ? `“${title}” was already missing and has been removed from Loavy.`
        : `Moved “${title}” to the Recycle Bin.`,
      "success"
    );
    if (queueWarning) notify(queueWarning, "error");
    onClose();
  }

  if (showPlaylistPicker) {
    return <PlaylistPicker track={track} onClose={onClose} />;
  }

  if (showDeleteConfirmation) {
    return (
      <ConfirmDialog
        title="Delete song from disk?"
        description="The audio file will be removed from Loavy and moved to the Windows Recycle Bin."
        detail={(
          <div className="songDeleteDetail">
            <strong>{title}</strong>
            <span className="songDeletePath">{track.path}</span>
          </div>
        )}
        confirmLabel="Move to Recycle Bin"
        busy={deleting}
        danger
        onConfirm={() => void deleteTrack()}
        onClose={onClose}
      />
    );
  }

  return (
    <ContextMenu point={point} label={`Actions for ${title}`} onClose={onClose}>
      <MenuItem icon={<Play size={17} />} onSelect={play}>Play</MenuItem>
      <MenuItem icon={<SkipForward size={17} />} onSelect={playNext}>Play next</MenuItem>
      <MenuItem icon={<ListPlus size={17} />} onSelect={addToQueue}>Add to queue</MenuItem>

      {localTrack && <MenuSeparator />}
      {localTrack && (
        <MenuItem icon={<ListMusic size={17} />} onSelect={() => setShowPlaylistPicker(true)}>
          Add to playlist…
        </MenuItem>
      )}
      {localTrack && (
        <MenuItem icon={<Heart size={17} fill={track.favorite ? "currentColor" : "none"} />} onSelect={() => closeThen(toggleFavorite)}>
          {track.favorite ? "Remove from Favorites" : "Add to Favorites"}
        </MenuItem>
      )}

      {(artist || album) && <MenuSeparator />}
      {artist && (
        <MenuItem icon={<UserRound size={17} />} onSelect={() => closeThen(() => {
          openArtist(artist);
          onNavigate?.();
        })}>
          Go to artist
        </MenuItem>
      )}
      {album && (
        <MenuItem icon={<Disc3 size={17} />} onSelect={() => closeThen(() => {
          openAlbum(album);
          onNavigate?.();
        })}>
          Go to album
        </MenuItem>
      )}

      {localTrack && <MenuSeparator />}
      {localTrack && (
        <MenuItem icon={<FolderOpen size={17} />} onSelect={() => closeThen(revealTrack)}>
          Show in File Explorer
        </MenuItem>
      )}
      {localTrack && (
        <MenuItem danger icon={<Trash2 size={17} />} onSelect={() => setShowDeleteConfirmation(true)}>
          Delete song from disk…
        </MenuItem>
      )}
    </ContextMenu>
  );
}

export function isRemoteTrack(track: Track) {
  return track.id <= 0
    || /^https?:\/\//i.test(track.path)
    || track.fileExt.trim().toLocaleLowerCase() === "stream";
}

function sameTrack(left: Track, right: Track) {
  return left.id > 0 && right.id > 0
    ? left.id === right.id
    : left.path === right.path;
}
