import { LoaderCircle, Plus, RotateCw, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent
} from "react";
import { createPortal } from "react-dom";
import type { Playlist, Track } from "../types";
import { api } from "../lib/api";
import { errorMessage, useLibraryActions } from "../lib/LibraryContext";
import { displayTrackTitle } from "../lib/format";
import { validateDisplayName } from "./OverlayDialogs";

export type PlaylistPickerProps = {
  track: Track;
  onClose: () => void;
  onAdded?: (playlist: Playlist) => void;
};

type Feedback = {
  tone: "info" | "error";
  message: string;
};

export function PlaylistPicker({ track, onClose, onAdded }: PlaylistPickerProps) {
  const { notify } = useLibraryActions();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const loadRequestRef = useRef(0);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyPlaylistId, setBusyPlaylistId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const trackTitle = displayTrackTitle(track);
  const normalizedNewName = normalizePlaylistName(newName);
  const duplicateName = playlists.find(
    (playlist) => normalizePlaylistName(playlist.name) === normalizedNewName
  );
  const nameValidation = validateDisplayName(newName) || (
    duplicateName ? `A playlist named “${duplicateName.name}” already exists. Choose it above.` : null
  );
  const showNameValidation = Boolean(nameValidation && (nameTouched || duplicateName));
  const busy = busyPlaylistId !== null;

  async function loadPlaylists() {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await api.listPlaylists();
      if (loadRequestRef.current === requestId) setPlaylists(next);
    } catch (error) {
      if (loadRequestRef.current !== requestId) return;
      const message = errorMessage(error);
      setLoadError(message);
      notify(`Could not load playlists: ${message}`, "error");
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }

  useEffect(() => {
    void loadPlaylists();
    return () => {
      loadRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();

    return () => restoreFocusRef.current?.focus();
  }, []);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])"
    ) || [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (!busy && event.target === event.currentTarget) onClose();
  }

  async function addToPlaylist(playlist: Playlist) {
    setBusyPlaylistId(playlist.id);
    setFeedback(null);
    try {
      const tracks = await api.listPlaylistTracks(playlist.id);
      if (tracks.some((candidate) => candidate.id === track.id)) {
        const message = `“${trackTitle}” is already in “${playlist.name}”.`;
        setFeedback({ tone: "info", message });
        notify(message, "info");
        return;
      }

      await api.addTrackToPlaylist(playlist.id, track.id);
      announcePlaylistChange(track.id);
      notify(`Added “${trackTitle}” to “${playlist.name}”.`, "success");
      onAdded?.({ ...playlist, trackCount: playlist.trackCount + 1, updatedAt: Date.now() });
      onClose();
    } catch (error) {
      const message = `Could not add “${trackTitle}” to “${playlist.name}”: ${errorMessage(error)}`;
      setFeedback({ tone: "error", message });
      notify(message, "error");
    } finally {
      setBusyPlaylistId(null);
    }
  }

  async function createAndAdd(event: FormEvent) {
    event.preventDefault();
    setNameTouched(true);
    if (nameValidation) {
      if (duplicateName) {
        const message = `A playlist named “${duplicateName.name}” already exists. Choose it from the list instead.`;
        setFeedback({ tone: "info", message });
        notify(message, "info");
      }
      return;
    }

    setBusyPlaylistId(-1);
    setFeedback(null);
    let created: Playlist | null = null;
    try {
      created = await api.createPlaylist(newName.trim());
      await api.addTrackToPlaylist(created.id, track.id);
      announcePlaylistChange(track.id);
      notify(`Created “${created.name}” and added “${trackTitle}”.`, "success");
      onAdded?.({ ...created, trackCount: 1, updatedAt: Date.now() });
      onClose();
    } catch (error) {
      const prefix = created
        ? `“${created.name}” was created, but the song could not be added`
        : "Could not create the playlist";
      const message = `${prefix}: ${errorMessage(error)}`;
      setFeedback({ tone: "error", message });
      notify(message, "error");
      if (created) {
        setPlaylists((current) => [created as Playlist, ...current]);
        setCreating(false);
        setNewName("");
      }
    } finally {
      setBusyPlaylistId(null);
    }
  }

  return createPortal(
    <div className="dialogBackdrop playlistPickerBackdrop" onMouseDown={handleBackdrop}>
      <div
        ref={panelRef}
        className="dialogPanel playlistPicker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="dialogHeader playlistPickerHeader">
          <div>
            <h2 id={titleId}>Add to playlist</h2>
            <p className="playlistPickerTrack" title={trackTitle}>{trackTitle}</p>
          </div>
          <button type="button" className="iconButton" onClick={onClose} disabled={busy} aria-label="Close playlist picker">
            <X size={18} />
          </button>
        </header>

        <div className="playlistPickerBody">
          {loading && (
            <p className="playlistPickerStatus" role="status">
              <LoaderCircle className="spin" size={17} aria-hidden="true" />
              Loading playlists…
            </p>
          )}

          {!loading && loadError && (
            <div className="playlistPickerError" role="alert">
              <p>Could not load playlists: {loadError}</p>
              <button type="button" className="secondaryAction" onClick={() => void loadPlaylists()}>
                <RotateCw size={16} aria-hidden="true" />
                Try again
              </button>
            </div>
          )}

          {!loading && !loadError && (
            <>
              <ul className="playlistPickerList" aria-label="Your playlists">
                {playlists.map((playlist) => (
                  <li key={playlist.id}>
                    <button
                      type="button"
                      className="playlistPickerOption"
                      disabled={busy}
                      onClick={() => void addToPlaylist(playlist)}
                    >
                      <span>{playlist.name}</span>
                      <small>{playlist.trackCount === 1 ? "1 song" : `${playlist.trackCount} songs`}</small>
                      {busyPlaylistId === playlist.id && <LoaderCircle className="spin" size={16} aria-label="Adding song" />}
                    </button>
                  </li>
                ))}
                {!playlists.length && !creating && (
                  <li className="playlistPickerEmpty">No playlists yet. Create your first one below.</li>
                )}
              </ul>

              {creating ? (
                <form className="playlistPickerCreateForm" onSubmit={(event) => void createAndAdd(event)}>
                  <label htmlFor={`${titleId}-name`}>Playlist name</label>
                  <input
                    id={`${titleId}-name`}
                    autoFocus
                    maxLength={120}
                    value={newName}
                    disabled={busy}
                    aria-invalid={showNameValidation}
                    aria-describedby={showNameValidation ? `${titleId}-name-error` : undefined}
                    onChange={(event) => setNewName(event.target.value)}
                    onBlur={() => setNameTouched(true)}
                  />
                  {showNameValidation && nameValidation && (
                    <p className="fieldError" id={`${titleId}-name-error`}>{nameValidation}</p>
                  )}
                  <div className="playlistPickerCreateActions">
                    <button
                      type="button"
                      className="secondaryAction"
                      disabled={busy}
                      onClick={() => {
                        setCreating(false);
                        setNewName("");
                        setNameTouched(false);
                      }}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="primaryAction" disabled={busy || Boolean(nameValidation)}>
                      {busyPlaylistId === -1 && <LoaderCircle className="spin" size={16} aria-hidden="true" />}
                      Create and add
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className="playlistPickerCreate"
                  disabled={busy}
                  onClick={() => {
                    setCreating(true);
                    setFeedback(null);
                  }}
                >
                  <Plus size={17} aria-hidden="true" />
                  Create new playlist
                </button>
              )}
            </>
          )}

          <p
            className={feedback?.tone === "error" ? "playlistPickerFeedback error" : "playlistPickerFeedback"}
            aria-live="polite"
          >
            {feedback?.message || ""}
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
}

function normalizePlaylistName(name: string) {
  return name.trim().toLocaleLowerCase();
}

function announcePlaylistChange(trackId: number) {
  const detail = { kind: "playlist-updated", trackIds: [trackId] };
  window.dispatchEvent(new CustomEvent("loavy:playlists-changed", { detail }));
}
