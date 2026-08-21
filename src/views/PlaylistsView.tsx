import { ChevronRight, Folder, FolderOpen, FolderPlus, Home, ListPlus, MoreHorizontal, Pencil, Play, Rows3, Trash2 } from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, MenuItem, MenuSeparator, type MenuPoint } from "../components/ContextMenu";
import { ConfirmDialog, PromptDialog, validateWindowsFolderName } from "../components/OverlayDialogs";
import { VirtualSongList } from "../components/VirtualSongList";
import { Switch } from "../components/Switch";
import { api } from "../lib/api";
import { audioEngine } from "../lib/audioEngine";
import { errorMessage, useLibraryActions } from "../lib/LibraryContext";
import { useAudioSelector } from "../lib/useAudio";
import type { FolderInspection, LibraryFolderEntry, LibraryFolderListing, MusicFolder, Track } from "../types";

type Location = { rootId: number; relativePath: string; path: string; rootName: string };
type FolderMenu = { entry: LibraryFolderEntry; point: MenuPoint };

type Props = {
  folders: MusicFolder[];
  tracks: Track[];
  onOpenSettings: () => void;
};

function normalize(path: string) {
  return path.replace(/[\\/]+$/, "").replace(/\//g, "\\");
}

function parentPath(path: string) {
  const normalized = normalize(path);
  const separator = normalized.lastIndexOf("\\");
  return separator >= 2 ? normalized.slice(0, separator) : normalized;
}

function baseName(path: string) {
  return normalize(path).split("\\").pop() || path;
}

function isInside(path: string, folder: string) {
  const normalizedPath = normalize(path).toLocaleLowerCase();
  const normalizedFolder = normalize(folder).toLocaleLowerCase();
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}\\`);
}

function sameRelativePath(left: string, right: string) {
  const normalizeRelative = (value: string) => value
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLocaleLowerCase();
  return normalizeRelative(left) === normalizeRelative(right);
}

export function FoldersView({ folders, tracks, onOpenSettings }: Props) {
  const currentPath = useAudioSelector((snapshot) => snapshot.current?.path || null);
  const { refreshLibrary, notify } = useLibraryActions();
  const [location, setLocation] = useState<Location | null>(null);
  const [listing, setListing] = useState<LibraryFolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [continueAcrossFolders, setContinueAcrossFolders] = useState(() => localStorage.getItem("loavy.continueAcrossFolders") === "true");
  const [prompt, setPrompt] = useState<{ kind: "create" | "rename"; entry?: LibraryFolderEntry } | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderMenu | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ entry: LibraryFolderEntry; inspection: FolderInspection } | null>(null);
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<Array<Location | null>>([null]);
  const historyIndexRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    if (!location) {
      setListing(null);
      return;
    }
    const requestedRootId = location.rootId;
    const requestedRelativePath = location.relativePath;
    setLoading(true);
    api.listLibraryFolder(requestedRootId, requestedRelativePath)
      .then((next) => {
        if (!disposed) {
          setListing(next);
          setLocation((current) => current
            && current.rootId === requestedRootId
            && sameRelativePath(current.relativePath, requestedRelativePath)
            ? { ...current, path: next.path }
            : current);
        }
      })
      .catch((error) => !disposed && notify(errorMessage(error), "error"))
      .finally(() => !disposed && setLoading(false));
    return () => { disposed = true; };
  }, [location?.rootId, location?.relativePath, notify, revision]);

  useEffect(() => {
    if (!continueAcrossFolders || !currentPath) return;
    const root = folders.find((folder) => isInside(currentPath, folder.path));
    if (!root) return;
    const playingFolder = parentPath(currentPath);
    const relativePath = normalize(playingFolder).slice(normalize(root.path).length).replace(/^\\/, "").replace(/\\/g, "/");
    const next = { rootId: root.id, relativePath, path: playingFolder, rootName: baseName(root.path) };
    if (location?.rootId === next.rootId && sameRelativePath(location.relativePath, next.relativePath)) return;
    setListing(null);
    setFolderMenu(null);
    setLocation(next);
  }, [continueAcrossFolders, currentPath, folders]);

  const folderTracks = useMemo(() => location ? tracks.filter((track) => isInside(parentPath(track.path), location.path)) : [], [location, tracks]);
  const directTracks = useMemo(() => location ? folderTracks.filter((track) => normalize(parentPath(track.path)).toLocaleLowerCase() === normalize(location.path).toLocaleLowerCase()) : [], [folderTracks, location]);
  const continuationQueue = useMemo(() => location ? [...folderTracks, ...tracks.filter((track) => !isInside(parentPath(track.path), location.path))] : tracks, [folderTracks, location, tracks]);
  const visibleListing = location
    && listing?.rootId === location.rootId
    && sameRelativePath(listing.relativePath, location.relativePath)
    ? listing
    : null;
  const breadcrumbs = useMemo(() => {
    if (!location) return [];
    const parts = location.relativePath ? location.relativePath.split("/") : [];
    const values = [{ label: location.rootName, relativePath: "" }];
    parts.forEach((part, index) => values.push({ label: part, relativePath: parts.slice(0, index + 1).join("/") }));
    return values;
  }, [location]);

  function navigate(next: Location | null, push = true) {
    if (push) {
      const history = historyRef.current.slice(0, historyIndexRef.current + 1);
      history.push(next);
      historyRef.current = history;
      historyIndexRef.current = history.length - 1;
    }
    setListing(null);
    setFolderMenu(null);
    setLocation(next);
  }

  function openRoot(folder: MusicFolder) {
    navigate({ rootId: folder.id, relativePath: "", path: folder.path, rootName: baseName(folder.path) });
  }

  function openEntry(entry: LibraryFolderEntry) {
    if (!location) return;
    navigate({ rootId: entry.rootId, relativePath: entry.relativePath, path: entry.path, rootName: location.rootName });
  }

  function openBreadcrumb(relativePath: string) {
    if (!location) return;
    const path = relativePath ? `${folders.find((folder) => folder.id === location.rootId)?.path || ""}\\${relativePath.replace(/\//g, "\\")}` : folders.find((folder) => folder.id === location.rootId)?.path || location.path;
    navigate({ ...location, relativePath, path });
  }

  function handleMouseNavigation(event: MouseEvent<HTMLElement>) {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    const nextIndex = historyIndexRef.current + (event.button === 3 ? -1 : 1);
    if (nextIndex < 0 || nextIndex >= historyRef.current.length) return;
    historyIndexRef.current = nextIndex;
    navigate(historyRef.current[nextIndex], false);
  }

  function playFolder() {
    if (!folderTracks.length) return;
    const queue = continueAcrossFolders ? continuationQueue : folderTracks;
    void audioEngine.playTrack(folderTracks[0], queue, 0);
  }

  function queueFolder(path = location?.path) {
    if (!path) return false;
    const additions = tracks.filter((track) => isInside(parentPath(track.path), path));
    if (!additions.length) return false;
    const added = audioEngine.addToQueue(additions);
    if (added) notify("Folder added to the queue.", "success");
    return added;
  }

  function changeFolderContinuation(enabled: boolean) {
    if (!audioEngine.replaceQueue(enabled ? continuationQueue : folderTracks)) return;
    setContinueAcrossFolders(enabled);
    localStorage.setItem("loavy.continueAcrossFolders", String(enabled));
  }

  async function createOrRename(name: string) {
    if (!location || !prompt) return;
    setBusy(true);
    try {
      if (prompt.kind === "create") {
        await api.createLibraryFolder(location.rootId, location.relativePath, name);
        notify("Folder created.", "success");
      } else if (prompt.entry) {
        await api.renameLibraryFolder(prompt.entry.rootId, prompt.entry.relativePath, name);
        notify("Folder renamed. Indexed songs kept their library data.", "success");
        await refreshLibrary();
      }
      setPrompt(null);
      setRevision((value) => value + 1);
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function inspectDelete(entry: LibraryFolderEntry) {
    setFolderMenu(null);
    try {
      setDeleteTarget({ entry, inspection: await api.inspectLibraryFolder(entry.rootId, entry.relativePath) });
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  }

  async function deleteFolder() {
    if (!deleteTarget) return;
    setBusy(true);
    const current = audioEngine.snapshot().current;
    const currentInside = current && isInside(parentPath(current.path), deleteTarget.entry.path) ? current : null;
    const handle = currentInside ? audioEngine.prepareTrackRemoval(currentInside) : null;
    try {
      const result = await api.deleteLibraryFolderToTrash(deleteTarget.entry.rootId, deleteTarget.entry.relativePath);
      if (handle) await audioEngine.commitTrackRemoval(handle, { playNext: false });
      await refreshLibrary();
      setDeleteTarget(null);
      setRevision((value) => value + 1);
      notify(result.alreadyMissing ? "The missing folder was removed from Loavy." : "Folder moved to the Recycle Bin.", "success");
    } catch (error) {
      if (handle) await audioEngine.rollbackTrackRemoval(handle);
      notify(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  if (!folders.length) {
    return (
      <section className="emptyState">
        <span className="emptyStateIcon"><FolderOpen size={42} /></span>
        <h2>No music folders yet</h2>
        <p>Add a music folder in Settings, then scan it to start browsing.</p>
        <button className="primaryAction" onClick={onOpenSettings}>Open Settings</button>
      </section>
    );
  }

  return (
    <section className="folderBrowser" onAuxClick={handleMouseNavigation}>
      <header className="folderToolbar">
        <div className="folderBreadcrumbs">
          <button onClick={() => navigate(null)} title="Music folders"><Home size={16} /></button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.relativePath || "root"}><ChevronRight size={14} /><button onClick={() => openBreadcrumb(crumb.relativePath)}>{crumb.label}</button></span>
          ))}
        </div>
        <div className="folderToolbarActions">
          <label className="folderContinueToggle">
            <span><strong>Folder flow</strong><small>Continue into another folder</small></span>
            <Switch checked={continueAcrossFolders} onChange={changeFolderContinuation} label="Continue playing into another folder" />
          </label>
          {location && <button className="secondaryAction" onClick={() => setPrompt({ kind: "create" })}><FolderPlus size={16} /> New folder</button>}
          {location && <button className="secondaryAction" onClick={() => void api.revealLibraryFolder(location.rootId, location.relativePath).catch((error) => notify(errorMessage(error), "error"))}><FolderOpen size={16} /> Open</button>}
          {location && <button className="secondaryAction" onClick={() => queueFolder()} disabled={!folderTracks.length}><ListPlus size={16} /> Queue</button>}
          {location && <button className="primaryAction" onClick={playFolder} disabled={!folderTracks.length} aria-label="Play folder"><Play size={16} fill="currentColor" /></button>}
        </div>
      </header>

      <div className="folderBrowserContent">
        {!location ? (
          <div className="folderGrid rootFolderGrid">
            {folders.map((folder) => (
              <button className="folderCard" key={folder.id} onClick={() => openRoot(folder)}>
                <span className="folderIcon"><Folder size={24} fill="currentColor" /></span>
                <span><strong>{baseName(folder.path)}</strong><small>{tracks.filter((track) => isInside(track.path, folder.path)).length} indexed songs</small></span>
                <ChevronRight size={18} />
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="folderGrid">
              {visibleListing?.folders.map((entry) => (
                <div className="folderCardWrap" key={entry.relativePath}>
                  <button className="folderCard" onClick={() => openEntry(entry)}>
                    <span className="folderIcon"><Folder size={24} fill="currentColor" /></span>
                    <span><strong>{entry.name}</strong><small>{entry.indexedTrackCount} indexed songs</small></span>
                    <ChevronRight size={18} />
                  </button>
                  <button className="folderCardMenu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setFolderMenu({ entry, point: { x: rect.right, y: rect.bottom } }); }} aria-label={`Actions for ${entry.name}`}><MoreHorizontal size={17} /></button>
                </div>
              ))}
            </div>
            {directTracks.length > 0 && (
              <div className="folderSongs">
                <div className="folderSectionTitle"><Rows3 size={16} /><span>Songs in this folder</span><strong>{directTracks.length}</strong></div>
                <VirtualSongList tracks={directTracks} playbackQueue={continueAcrossFolders ? continuationQueue : directTracks} />
              </div>
            )}
            {!loading && !visibleListing?.folders.length && !directTracks.length && <section className="emptyState compactEmpty"><FolderOpen size={36} /><h2>This folder is empty</h2><p>Create a subfolder or add music here, then scan your library.</p></section>}
          </>
        )}
      </div>

      {folderMenu && (
        <ContextMenu point={folderMenu.point} label={`Actions for ${folderMenu.entry.name}`} onClose={() => setFolderMenu(null)}>
          <MenuItem icon={<Play size={16} />} disabled={!folderMenu.entry.indexedTrackCount} onSelect={() => { const songs = tracks.filter((track) => isInside(parentPath(track.path), folderMenu.entry.path)); if (songs.length) void audioEngine.playTrack(songs[0], songs, 0); setFolderMenu(null); }}>Play folder</MenuItem>
          <MenuItem icon={<ListPlus size={16} />} disabled={!folderMenu.entry.indexedTrackCount} onSelect={() => { queueFolder(folderMenu.entry.path); setFolderMenu(null); }}>Add folder to queue</MenuItem>
          <MenuSeparator />
          <MenuItem icon={<FolderOpen size={16} />} onSelect={() => { void api.revealLibraryFolder(folderMenu.entry.rootId, folderMenu.entry.relativePath).catch((error) => notify(errorMessage(error), "error")); setFolderMenu(null); }}>Open in File Explorer</MenuItem>
          <MenuItem icon={<Pencil size={16} />} onSelect={() => { setPrompt({ kind: "rename", entry: folderMenu.entry }); setFolderMenu(null); }}>Rename folder</MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 size={16} />} onSelect={() => void inspectDelete(folderMenu.entry)}>Move folder to Recycle Bin</MenuItem>
        </ContextMenu>
      )}

      {prompt && <PromptDialog title={prompt.kind === "create" ? "Create folder" : "Rename folder"} description="Folder names are validated for Windows and cannot leave your configured music root." label="Folder name" initialValue={prompt.entry?.name || ""} submitLabel={prompt.kind === "create" ? "Create folder" : "Rename folder"} busy={busy} validate={validateWindowsFolderName} onSubmit={(value) => void createOrRename(value)} onClose={() => setPrompt(null)} />}
      {deleteTarget && <ConfirmDialog title={`Move “${deleteTarget.entry.name}” to the Recycle Bin?`} description="The folder and its contents will be removed from Loavy. You can restore them from the Windows Recycle Bin." detail={<><strong>{deleteTarget.inspection.indexedTrackCount} indexed songs</strong><span>{deleteTarget.inspection.descendantFolderCount} nested folders</span><code>{deleteTarget.inspection.path}</code></>} confirmLabel="Move to Recycle Bin" danger busy={busy} onConfirm={() => void deleteFolder()} onClose={() => setDeleteTarget(null)} />}
    </section>
  );
}
