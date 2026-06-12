import { ChevronRight, Folder, FolderOpen, Home, Play, Rows3 } from "lucide-react";
import { useMemo, useState } from "react";
import { VirtualSongList } from "../components/VirtualSongList";
import { audioEngine } from "../lib/audioEngine";
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
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const roots = useMemo(() => folders.map((folder) => normalize(folder.path)), [folders]);

  const folderTracks = useMemo(
    () => currentFolder ? tracks.filter((track) => isInside(parentPath(track.path), currentFolder)) : [],
    [currentFolder, tracks]
  );

  const directTracks = useMemo(
    () => currentFolder ? folderTracks.filter((track) => normalize(parentPath(track.path)).toLocaleLowerCase() === normalize(currentFolder).toLocaleLowerCase()) : [],
    [currentFolder, folderTracks]
  );

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
    void audioEngine.playTrack(folderTracks[0], folderTracks, 0);
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
    <section className="folderBrowser">
      <header className="folderToolbar">
        <div className="folderBreadcrumbs">
          <button onClick={() => setCurrentFolder(null)} title="Music folders"><Home size={16} /></button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.path}>
              <ChevronRight size={14} />
              <button onClick={() => setCurrentFolder(crumb.path)}>{crumb.label}</button>
            </span>
          ))}
        </div>
        {currentFolder && (
          <button className="primaryAction" onClick={playFolder} disabled={!folderTracks.length}>
            <Play size={16} fill="currentColor" /> Play folder
          </button>
        )}
      </header>

      <div className="folderBrowserContent">
        <div className="folderGrid">
          {childFolders.map((folder) => (
            <button className="folderCard" key={folder} onClick={() => setCurrentFolder(folder)}>
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
            <VirtualSongList tracks={directTracks} />
          </div>
        )}

        {currentFolder && !childFolders.length && !directTracks.length && (
          <section className="emptyState"><h2>This folder is empty</h2><p>Run a library scan after adding music.</p></section>
        )}
      </div>
    </section>
  );
}
