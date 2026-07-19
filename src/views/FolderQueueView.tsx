import { ChevronDown, ChevronRight, Folder, ListMusic, Music2, Play, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { audioEngine } from "../lib/audioEngine";
import { displayArtist, displayTrackTitle } from "../lib/format";
import type { Track } from "../types";

type Selection =
  | { kind: "folder"; path: string }
  | { kind: "track"; id: number };

const STORAGE_KEY = "loavy.folderQueueSelection";

function loadSelection(): Selection[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Selection => Boolean(item) && typeof item === "object" && (
      ((item as Selection).kind === "folder" && typeof (item as { path?: unknown }).path === "string") ||
      ((item as Selection).kind === "track" && Number.isInteger((item as { id?: unknown }).id))
    ));
  } catch {
    return [];
  }
}

function normalize(path: string) {
  return path.replace(/[\\/]+$/, "").replace(/\//g, "\\");
}

function parentPath(path: string) {
  const value = normalize(path);
  const separator = value.lastIndexOf("\\");
  return separator > 2 ? value.slice(0, separator) : value;
}

function baseName(path: string) {
  return normalize(path).split("\\").pop() || path;
}

function isInside(path: string, folder: string) {
  const value = normalize(path).toLocaleLowerCase();
  const root = normalize(folder).toLocaleLowerCase();
  return value === root || value.startsWith(`${root}\\`);
}

export function FolderQueueView({ tracks }: { tracks: Track[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection[]>(loadSelection);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  }, [selection]);
  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const track of tracks) {
      const folder = parentPath(track.path);
      counts.set(folder, (counts.get(folder) || 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [tracks]);

  const selectedTracks = useMemo(() => {
    const queue: Track[] = [];
    const ids = new Set<number>();
    for (const item of selection) {
      const additions = item.kind === "track"
        ? tracks.filter((track) => track.id === item.id)
        : tracks.filter((track) => isInside(parentPath(track.path), item.path));
      for (const track of additions) {
        if (!ids.has(track.id)) {
          ids.add(track.id);
          queue.push(track);
        }
      }
    }
    return queue;
  }, [selection, tracks]);

  function add(item: Selection) {
    const key = item.kind === "folder" ? `folder:${normalize(item.path).toLocaleLowerCase()}` : `track:${item.id}`;
    setSelection((current) => current.some((entry) =>
      entry.kind === "folder"
        ? key === `folder:${normalize(entry.path).toLocaleLowerCase()}`
        : key === `track:${entry.id}`
    ) ? current : [...current, item]);
  }

  function toggleFolder(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  function playSelection() {
    if (selectedTracks.length) void audioEngine.playTrack(selectedTracks[0], selectedTracks, 0);
  }

  return (
    <section className="folderQueueView">
      <div className="folderQueueIntro">
        <div><h2>Choose what plays next</h2><p>Add complete folders or individual songs. Items play in the order shown on the right.</p></div>
        <button className="primaryAction" onClick={playSelection} disabled={!selectedTracks.length}>
          <Play size={16} fill="currentColor" /> Play selection
        </button>
      </div>
      <div className="folderQueueColumns">
        <section className="folderQueuePanel">
          <header><Folder size={18} /><div><strong>Folders with songs</strong><small>{folders.length} folders</small></div></header>
          <div className="folderQueueList">
            {folders.map(([folder, count]) => {
              const open = expanded.has(folder);
              const folderSongs = open ? tracks.filter((track) => parentPath(track.path).toLocaleLowerCase() === folder.toLocaleLowerCase()) : [];
              return (
                <div className="folderQueueGroup" key={folder}>
                  <div className="folderQueueRow">
                    <button className="folderQueueExpand" onClick={() => toggleFolder(folder)} aria-label={open ? "Hide songs" : "Show songs"}>
                      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                    <Folder size={17} fill="currentColor" />
                    <span title={folder}><strong>{baseName(folder)}</strong><small>{count} songs · {folder}</small></span>
                    <button className="folderQueueAdd" onClick={() => add({ kind: "folder", path: folder })} title="Add folder"><Plus size={16} /></button>
                  </div>
                  {open && folderSongs.map((track) => (
                    <div className="folderQueueRow folderQueueSong" key={track.id}>
                      <Music2 size={15} /><span><strong>{displayTrackTitle(track)}</strong><small>{displayArtist(track.artist)}</small></span>
                      <button className="folderQueueAdd" onClick={() => add({ kind: "track", id: track.id })} title="Add song"><Plus size={16} /></button>
                    </div>
                  ))}
                </div>
              );
            })}
            {!folders.length && <p className="muted">Scan your library to find folders and songs.</p>}
          </div>
        </section>
        <section className="folderQueuePanel selected">
          <header><ListMusic size={18} /><div><strong>Selected to play</strong><small>{selectedTracks.length} unique songs</small></div>
            {!!selection.length && <button className="folderQueueClear" onClick={() => setSelection([])} title="Clear selection"><Trash2 size={15} /></button>}
          </header>
          <div className="folderQueueList">
            {selection.map((item, index) => {
              const track = item.kind === "track" ? tracks.find((candidate) => candidate.id === item.id) : null;
              return (
                <div className="folderQueueRow" key={`${item.kind}-${item.kind === "folder" ? item.path : item.id}`}>
                  {item.kind === "folder" ? <Folder size={17} fill="currentColor" /> : <Music2 size={17} />}
                  <span><strong>{item.kind === "folder" ? baseName(item.path) : track ? displayTrackTitle(track) : "Missing song"}</strong>
                    <small>{item.kind === "folder" ? `${tracks.filter((candidate) => isInside(parentPath(candidate.path), item.path)).length} songs` : track ? displayArtist(track.artist) : "No longer in library"}</small></span>
                  <button className="folderQueueAdd" onClick={() => setSelection((current) => current.filter((_, itemIndex) => itemIndex !== index))} title="Remove"><X size={16} /></button>
                </div>
              );
            })}
            {!selection.length && <div className="folderQueueEmpty"><ListMusic size={32} /><strong>Your selection is empty</strong><span>Add folders or songs from the list on the left.</span></div>}
          </div>
        </section>
      </div>
    </section>
  );
}
