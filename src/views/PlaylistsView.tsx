import { ChevronRight, Folder, FolderOpen, Home, Play, Rows3 } from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { VirtualSongList } from "../components/VirtualSongList";
import { Switch } from "../components/Switch";
import { audioEngine } from "../lib/audioEngine";
import { useAudio } from "../lib/useAudio";
import type { MusicFolder, Track } from "../types";

type Props = {
  folders: MusicFolder[];
  tracks: Track[];
};

function normalize(path: string) {
  return path.replace(/[\\/]+$/, "").replace(/\//g, "\\");
}

function parentPath(path: string) {
  const normalized = normalize(path);
  const separator = normalized.lastIndexOf("\\");
  return separator > 2 ? normalized.slice(0, separator) : normalized;
}

function baseName(path: string) {
  return normalize(path).split("\\").pop() || path;
}

function isInside(path: string, folder: string) {
  const normalizedPath = normalize(path).toLocaleLowerCase();
  const normalizedFolder = normalize(folder).toLocaleLowerCase();
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}\\`);
}

export function PlaylistsView({ folders, tracks }: Props) {
  const audio = useAudio();
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const historyRef = useRef<Array<string | null>>([null]);
  const historyIndexRef = useRef(0);
  const [continueAcrossFolders, setContinueAcrossFolders] = useState(
    () => localStorage.getItem("loavy.continueAcrossFolders") === "true"
  );
  const roots = useMemo(() => folders.map((folder) => normalize(folder.path)), [folders]);

  useEffect(() => {
    if (!continueAcrossFolders || !audio.current?.path) return;

    const playingFolder = parentPath(audio.current.path);
    if (!roots.some((root) => isInside(playingFolder, root))) return;

    setCurrentFolder((folder) =>
      folder && normalize(folder).toLocaleLowerCase() === normalize(playingFolder).toLocaleLowerCase()
        ? folder
        : playingFolder
    );
  }, [audio.current?.path, continueAcrossFolders, roots]);

  const folderTracks = useMemo(
    () => currentFolder ? tracks.filter((track) => isInside(parentPath(track.path), currentFolder)) : [],
    [currentFolder, tracks]
  );

  const directTracks = useMemo(
    () => currentFolder ? folderTracks.filter((track) => normalize(parentPath(track.path)).toLocaleLowerCase() === normalize(currentFolder).toLocaleLowerCase()) : [],
    [currentFolder, folderTracks]
  );

  const continuationQueue = useMemo(() => {
    if (!currentFolder) return tracks;
    const tracksOutsideFolder = tracks.filter((track) => !isInside(parentPath(track.path), currentFolder));
    return [...folderTracks, ...tracksOutsideFolder];
  }, [currentFolder, folderTracks, tracks]);

  const childFolders = useMemo(() => {
    if (!currentFolder) return roots;
    const children = new Map<string, number>();
    for (const track of folderTracks) {
      const directory = normalize(parentPath(track.path));
      if (directory.toLocaleLowerCase() === normalize(currentFolder).toLocaleLowerCase()) continue;
      const relative = directory.slice(normalize(currentFolder).length + 1);
      const child = `${normalize(currentFolder)}\\${relative.split("\\")[0]}`;
      children.set(child, (children.get(child) || 0) + 1);
    }
    return [...children.keys()].sort((a, b) => baseName(a).localeCompare(baseName(b)));
  }, [currentFolder, folderTracks, roots]);

  const breadcrumbs = useMemo(() => {
    if (!currentFolder) return [];
    const root = roots.find((candidate) => isInside(currentFolder, candidate));
    if (!root) return [{ label: baseName(currentFolder), path: currentFolder }];
    const relative = normalize(currentFolder).slice(root.length).replace(/^\\/, "");
    const crumbs = [{ label: baseName(root), path: root }];
    if (!relative) return crumbs;
    let path = root;
    for (const part of relative.split("\\")) {
      path = `${path}\\${part}`;
      crumbs.push({ label: part, path });
    }
    return crumbs;
  }, [currentFolder, roots]);

  function countTracks(folder: string) {
    return tracks.filter((track) => isInside(parentPath(track.path), folder)).length;
  }

  function playFolder() {
    if (!folderTracks.length) return;
    const queue = continueAcrossFolders ? continuationQueue : folderTracks;
    void audioEngine.playTrack(folderTracks[0], queue, 0);
  }

  function navigateTo(folder: string | null) {
    const history = historyRef.current.slice(0, historyIndexRef.current + 1);
    if (history[history.length - 1] === folder) return;
    history.push(folder);
    historyRef.current = history;
    historyIndexRef.current = history.length - 1;
    setCurrentFolder(folder);
  }

  function handleMouseNavigation(event: MouseEvent<HTMLElement>) {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    const nextIndex = historyIndexRef.current + (event.button === 3 ? -1 : 1);
    if (nextIndex < 0 || nextIndex >= historyRef.current.length) return;
    historyIndexRef.current = nextIndex;
    setCurrentFolder(historyRef.current[nextIndex]);
  }

  function changeFolderContinuation(enabled: boolean) {
    setContinueAcrossFolders(enabled);
    localStorage.setItem("loavy.continueAcrossFolders", String(enabled));
    audioEngine.replaceQueue(enabled ? continuationQueue : folderTracks);
  }

  if (!folders.length) {
    return (
      <section className="emptyState">
        <FolderOpen size={42} />
        <h2>No music folders yet</h2>
        <p>Add a music folder in Settings to browse it like a playlist.</p>
      </section>
    );
  }

  return (
    <section className="folderBrowser" onAuxClick={handleMouseNavigation}>
      <header className="folderToolbar">
        <div className="folderBreadcrumbs">
          <button onClick={() => navigateTo(null)} title="Music folders"><Home size={16} /></button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.path}>
              <ChevronRight size={14} />
              <button onClick={() => navigateTo(crumb.path)}>{crumb.label}</button>
            </span>
          ))}
        </div>
        <div className="folderToolbarActions">
          <label className="folderContinueToggle">
            <span>
              <strong>Folder flow</strong>
              <small>Continue into another folder</small>
            </span>
            <Switch
              checked={continueAcrossFolders}
              onChange={changeFolderContinuation}
              label="Continue playing into another folder"
            />
          </label>
          {currentFolder && (
            <button
              className="primaryAction"
              onClick={playFolder}
              disabled={!folderTracks.length}
              aria-label="Play folder"
              title="Play folder"
            >
              <Play size={16} fill="currentColor" />
            </button>
          )}
        </div>
      </header>

      <div className="folderBrowserContent">
        <div className="folderGrid">
          {childFolders.map((folder) => (
            <button className="folderCard" key={folder} onClick={() => navigateTo(folder)}>
              <span className="folderIcon"><Folder size={24} fill="currentColor" /></span>
              <span>
                <strong>{baseName(folder)}</strong>
                <small>{countTracks(folder)} songs</small>
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
        </div>

        {currentFolder && directTracks.length > 0 && (
          <div className="folderSongs">
            <div className="folderSectionTitle"><Rows3 size={16} /><span>Songs in this folder</span><strong>{directTracks.length}</strong></div>
            <VirtualSongList
              tracks={directTracks}
              playbackQueue={continueAcrossFolders ? continuationQueue : directTracks}
            />
          </div>
        )}

        {currentFolder && !childFolders.length && !directTracks.length && (
          <section className="emptyState"><h2>This folder is empty</h2><p>Run a library scan after adding music.</p></section>
        )}
      </div>
    </section>
  );
}
