import { LoaderCircle, Plus, RotateCw, Search, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent
} from "react";
import { createPortal } from "react-dom";
import type { LibraryFolderEntry, LibraryTrackCopyResult, Track } from "../types";
import { api } from "../lib/api";
import { displayArtist, displayTrackTitle } from "../lib/format";
import { errorMessage, useLibraryActions } from "../lib/LibraryContext";
import { ConfirmDialog, validateWindowsFolderName } from "./OverlayDialogs";
import { defaultAppearance, playlistKey, usePlaylistAppearances } from "../lib/playlistAppearance";
import { PlaylistArtwork } from "./PlaylistArtwork";

export type PlaylistPickerProps = {
  track: Track;
  onClose: () => void;
};

type Feedback = { tone: "info" | "error"; message: string };
type Conflict = Extract<LibraryTrackCopyResult, { status: "conflict" }>;

export function PlaylistPicker({ track, onClose }: PlaylistPickerProps) {
  const { notify } = useLibraryActions();
  const appearances = usePlaylistAppearances();
  const folderLabel = (folder: LibraryFolderEntry) => appearances.items[playlistKey(folder)]?.name || folder.name;
  const titleId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const loadRequestRef = useRef(0);
  const [folders, setFolders] = useState<LibraryFolderEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const trackTitle = displayTrackTitle(track);
  const trackArtist = displayArtist(track.artist);
  const nameValidation = validateWindowsFolderName(newName);
  const busy = busyKey !== null;

  const visibleFolders = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return [...folders]
      .filter((folder) => !query || [folderLabel(folder), folder.name, folder.relativePath, folder.path]
        .some((value) => value.toLocaleLowerCase().includes(query)))
      .sort((left, right) => {
        const preferred = Number(isPlaylistFolder(right)) - Number(isPlaylistFolder(left));
        return preferred || folderLabel(left).localeCompare(folderLabel(right), undefined, { sensitivity: "base" });
      });
  }, [folders, search, appearances.items]);

  async function loadFolders() {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await api.listPlaylistFolders();
      if (loadRequestRef.current === requestId) setFolders(next);
    } catch (error) {
      if (loadRequestRef.current !== requestId) return;
      const message = errorMessage(error);
      setLoadError(message);
      notify(`Could not load music folders: ${message}`, "error");
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }

  useEffect(() => {
    void loadFolders();
    return () => { loadRequestRef.current += 1; };
  }, []);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus();
    return () => restoreFocusRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    if (conflict) backdrop.setAttribute("inert", "");
    else backdrop.removeAttribute("inert");
    return () => backdrop.removeAttribute("inert");
  }, [conflict]);

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

  async function copyToFolder(folder: LibraryFolderEntry, keepBoth = false) {
    const key = folderKey(folder);
    setBusyKey(key);
    setFeedback(null);
    try {
      const result = await api.copyTrackToLibraryFolder(
        track.id,
        folder.rootId,
        folder.relativePath,
        keepBoth ? "keepBoth" : "report"
      );
      if (result.status === "conflict") {
        setConflict(result);
        return;
      }
      if (result.status === "alreadyPresent") {
        const message = `“${trackTitle}” is already in “${folderLabel(result.folder)}”.`;
        setFeedback({ tone: "info", message });
        notify(message, "info");
        return;
      }
      notify(`Added “${trackTitle}” to “${folderLabel(result.folder)}”.`, "success");
      onClose();
    } catch (error) {
      const message = `Could not copy “${trackTitle}” into “${folderLabel(folder)}”: ${errorMessage(error)}`;
      setFeedback({ tone: "error", message });
      notify(message, "error");
    } finally {
      setBusyKey(null);
    }
  }

  async function createAndAdd(event: FormEvent) {
    event.preventDefault();
    setNameTouched(true);
    if (nameValidation) return;
    setBusyKey("create");
    setFeedback(null);
    try {
      const result = await api.createPlaylistFolderWithTrack(newName.trim(), track.id);
      if (result.status === "alreadyExists") {
        setFolders((current) => includeFolder(current, result.folder));
        setSearch("");
        setCreating(false);
        const message = `A folder named “${result.folder.name}” already exists. Choose it from the list.`;
        setFeedback({ tone: "info", message });
        notify(message, "info");
        return;
      }
      const copy = result.copy;
      if (!copy || copy.status !== "copied") {
        throw new Error("The folder was created, but the copied track was not confirmed.");
      }
      notify(`Created “${result.folder.name}” and added “${trackTitle}”.`, "success");
      onClose();
    } catch (error) {
      const message = `Could not create the playlist folder: ${errorMessage(error)}`;
      setFeedback({ tone: "error", message });
      notify(message, "error");
    } finally {
      setBusyKey(null);
    }
  }

  const picker = (
    <div
      ref={backdropRef}
      className="dialogBackdrop playlistPickerBackdrop"
      onMouseDown={handleBackdrop}
    >
      <div
        ref={panelRef}
        className="dialogPanel playlistPicker"
        role="dialog"
        aria-modal={conflict ? undefined : true}
        aria-labelledby={titleId}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="dialogHeader playlistPickerHeader">
          <div>
            <h2 id={titleId}>Add to playlist</h2>
            <p className="playlistPickerTrack" title={trackTitle}>{trackTitle}</p>
            <p className="playlistPickerArtist" title={trackArtist}>{trackArtist}</p>
          </div>
          <button type="button" className="iconButton" onClick={onClose} disabled={busy} aria-label="Close playlist picker"><X size={18} /></button>
        </header>

        <div className="playlistPickerBody">
          {!loading && !loadError && (
            <label className="playlistPickerSearch">
              <Search size={16} aria-hidden="true" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search playlists..." aria-label="Search playlist folders" disabled={busy} />
            </label>
          )}

          {loading && <p className="playlistPickerStatus" role="status"><LoaderCircle className="spin" size={17} /> Loading music folders…</p>}
          {!loading && loadError && (
            <div className="playlistPickerError" role="alert">
              <p>Could not load music folders: {loadError}</p>
              <button type="button" className="secondaryAction" onClick={() => void loadFolders()}><RotateCw size={16} /> Try again</button>
            </div>
          )}

          {!loading && !loadError && (
            <ul className="playlistPickerList" aria-label="Music folders">
              {visibleFolders.map((folder) => {
                const key = folderKey(folder);
                return (
                  <li key={key}>
                    <button type="button" className="playlistPickerOption" disabled={busy} onClick={() => void copyToFolder(folder)} title={folder.path}>
                      <PlaylistArtwork appearance={appearances.items[playlistKey(folder)] || defaultAppearance(folder)} />
                      <span><strong>{folderLabel(folder)}</strong><small className="playlistPickerPath">{appearances.items[playlistKey(folder)]?.description || "Your collection"}</small></span>
                      <small>{songCount(folder.indexedTrackCount)}</small>
                      {busyKey === key && <LoaderCircle className="spin" size={16} aria-label="Copying song" />}
                    </button>
                  </li>
                );
              })}
              {!visibleFolders.length && <li className="playlistPickerEmpty">{search ? "No folders match that search." : "No eligible music folders were found."}</li>}
            </ul>
          )}

          {!loading && !loadError && (
            <div className="playlistPickerFooter">
              {creating ? (
                <form className="playlistPickerCreateForm" onSubmit={(event) => void createAndAdd(event)}>
                  <label htmlFor={`${titleId}-name`}>Playlist folder name</label>
                  <input id={`${titleId}-name`} autoFocus maxLength={120} value={newName} disabled={busy} aria-invalid={Boolean(nameTouched && nameValidation)} aria-describedby={nameTouched && nameValidation ? `${titleId}-name-error` : undefined} onChange={(event) => setNewName(event.target.value)} onBlur={() => setNameTouched(true)} />
                  {nameTouched && nameValidation && <p className="fieldError" id={`${titleId}-name-error`}>{nameValidation}</p>}
                  <div className="playlistPickerCreateActions">
                    <button type="button" className="secondaryAction" disabled={busy} onClick={() => { setCreating(false); setNewName(""); setNameTouched(false); }}>Cancel</button>
                    <button type="submit" className="primaryAction" disabled={busy || Boolean(nameValidation)}>{busyKey === "create" && <LoaderCircle className="spin" size={16} />} Create and add</button>
                  </div>
                </form>
              ) : (
                <button type="button" className="playlistPickerCreate" disabled={busy} onClick={() => { setCreating(true); setFeedback(null); }}><Plus size={17} /> Create new playlist</button>
              )}
            </div>
          )}

          <p className={feedback?.tone === "error" ? "playlistPickerFeedback error" : "playlistPickerFeedback"} aria-live="polite">{feedback?.message || ""}</p>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {createPortal(picker, document.body)}
      {conflict && (
        <ConfirmDialog
          title={`Keep both files in “${folderLabel(conflict.folder)}”?`}
          description={`A different file with the same name already exists. Loavy will save this copy as “${conflict.suggestedFileName}” and will never overwrite the existing song.`}
          confirmLabel="Keep both"
          busy={busy}
          onConfirm={() => { const next = conflict; setConflict(null); void copyToFolder(next.folder, true); }}
          onClose={() => setConflict(null)}
        />
      )}
    </>
  );
}

function folderKey(folder: LibraryFolderEntry) {
  return `${folder.rootId}:${folder.relativePath.toLocaleLowerCase()}`;
}

function isPlaylistFolder(folder: LibraryFolderEntry) {
  return folder.name.toLocaleUpperCase() === "PLAYLISTS"
    || folder.relativePath.split(/[\\/]/).some((part) => part.toLocaleUpperCase() === "PLAYLISTS");
}

function songCount(count: number) {
  return count === 1 ? "1 song" : `${count} songs`;
}

function includeFolder(folders: LibraryFolderEntry[], folder: LibraryFolderEntry) {
  return folders.some((candidate) => folderKey(candidate) === folderKey(folder)) ? folders : [folder, ...folders];
}
