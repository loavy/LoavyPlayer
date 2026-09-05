import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowDown, ArrowUp, AudioLines, Heart, MoreHorizontal, Pause, Play, Trash2 } from "lucide-react";
import { audioEngine } from "../lib/audioEngine";
import { displayAlbum, displayArtist, displayTrackTitle, formatDuration } from "../lib/format";
import { useLibraryActions } from "../lib/LibraryContext";
import type { Track } from "../types";
import { Cover } from "./Cover";
import { useAudioSelector } from "../lib/useAudio";
import { SongContextMenu } from "./SongContextMenu";
import type { MenuPoint } from "./ContextMenu";

const DEFAULT_ROW_HEIGHT = 62;
const OVERSCAN = 8;

type Props = {
  tracks: Track[];
  playbackQueue?: Track[];
  scrollParentRef?: RefObject<HTMLElement>;
  playlistKey?: string;
  onRemoveTrack?: (track: Track) => void | Promise<void>;
  onMoveTrack?: (track: Track, index: number, direction: -1 | 1) => void | Promise<void>;
};

type OpenMenu = { track: Track; queueIndex: number; point: MenuPoint };

export function VirtualSongList({ tracks, playbackQueue = tracks, scrollParentRef, playlistKey, onRemoveTrack, onMoveTrack }: Props) {
  const playback = useAudioSelector(
    (snapshot) => ({ currentId: snapshot.current?.id ?? null, playing: snapshot.playing }),
    samePlayback
  );
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(520);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const listKey = useMemo(() => `${tracks.length}:${tracks[0]?.id || ""}:${tracks[tracks.length - 1]?.id || ""}`, [tracks]);
  const queueIndexById = useMemo(() => new Map(playbackQueue.map((track, index) => [track.id, index])), [playbackQueue]);
  const openMenu = useCallback((track: Track, queueIndex: number, point: MenuPoint) => setMenu({ track, queueIndex, point }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const parent = scrollParentRef?.current || node;
    const measure = () => {
      const offset = parent === node ? 0 : node.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop;
      setScrollTop(Math.max(0, parent.scrollTop - offset));
      setHeight(Math.max(1, parent.clientHeight - Math.max(0, offset - parent.scrollTop)));
    };
    const onScroll = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => { frameRef.current = null; measure(); });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    if (scrollParentRef) for (const child of parent.children) observer.observe(child);
    parent.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => { observer.disconnect(); parent.removeEventListener("scroll", onScroll); };
  }, [scrollParentRef]);

  useEffect(() => {
    const root = document.documentElement;
    const updateRowHeight = () => {
      const configured = Number.parseFloat(getComputedStyle(root).getPropertyValue("--song-row-height"));
      setRowHeight(Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ROW_HEIGHT);
    };
    updateRowHeight();
    const observer = new MutationObserver(updateRowHeight);
    observer.observe(root, { attributes: true, attributeFilter: ["data-density", "style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = scrollParentRef?.current || scrollerRef.current;
    if (!node) return;
    node.scrollTop = 0;
    setScrollTop(0);
    setMenu(null);
  }, [listKey, scrollParentRef]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const windowed = useMemo(() => {
    const maxScrollTop = Math.max(0, tracks.length * rowHeight - height);
    const safeScrollTop = Math.min(scrollTop, maxScrollTop);
    const start = Math.max(0, Math.floor(safeScrollTop / rowHeight) - OVERSCAN);
    const visibleCount = Math.ceil(height / rowHeight) + OVERSCAN * 2;
    const end = Math.min(tracks.length, start + visibleCount);
    return { start, items: tracks.slice(start, end), offsetY: start * rowHeight, totalHeight: tracks.length * rowHeight };
  }, [height, rowHeight, scrollTop, tracks]);

  return (
    <div className={`tableSurface virtualTable${scrollParentRef ? " pageSongTable" : ""}${onMoveTrack || onRemoveTrack ? " hasManagement" : ""}`} role="table" aria-label="Songs" aria-colcount={4} aria-rowcount={tracks.length + 1}>
      <div className="tableHeader songsGrid" role="row" aria-rowindex={1}>
        <span role="columnheader">Title</span>
        <span role="columnheader">Artist</span>
        <span role="columnheader">Album</span>
        <span role="columnheader">Time</span>
      </div>
      <div className="virtualScroller" ref={scrollerRef} role="rowgroup">
        <div role="presentation" style={{ height: windowed.totalHeight, position: "relative" }}>
          <div role="presentation" className="virtualWindow" style={{ transform: `translate3d(0, ${windowed.offsetY}px, 0)` }}>
            {windowed.items.map((track, virtualIndex) => {
              const index = windowed.start + virtualIndex;
              const queueIndex = queueIndexById.get(track.id) ?? index;
              return (
                <SongRow
                  key={track.id}
                  listIndex={index}
                  queueIndex={queueIndex}
                  queue={playbackQueue}
                  playlistKey={playlistKey}
                  track={track}
                  current={playback.currentId === track.id}
                  playing={playback.currentId === track.id && playback.playing}
                  onOpenMenu={openMenu}
                  onRemoveTrack={onRemoveTrack}
                  onMoveTrack={onMoveTrack}
                  first={index === 0}
                  last={index === tracks.length - 1}
                  rowHeight={rowHeight}
                />
              );
            })}
          </div>
        </div>
      </div>
      {menu && <SongContextMenu track={menu.track} point={menu.point} playbackQueue={playbackQueue} queueIndex={menu.queueIndex} onClose={closeMenu} />}
    </div>
  );
}

const SongRow = memo(function SongRow({
  track,
  queue,
  queueIndex,
  listIndex,
  current,
  playing,
  onOpenMenu,
  onRemoveTrack,
  onMoveTrack,
  first,
  last,
  rowHeight,
  playlistKey
}: {
  track: Track;
  queue: Track[];
  queueIndex: number;
  listIndex: number;
  current: boolean;
  playing: boolean;
  onOpenMenu: (track: Track, queueIndex: number, point: MenuPoint) => void;
  onRemoveTrack?: (track: Track) => void | Promise<void>;
  onMoveTrack?: (track: Track, index: number, direction: -1 | 1) => void | Promise<void>;
  first: boolean;
  last: boolean;
  rowHeight: number;
  playlistKey?: string;
}) {
  const { openAlbum, openArtist } = useLibraryActions();
  const title = displayTrackTitle(track);
  const artist = displayArtist(track.artist);
  const album = displayAlbum(track.album);

  function activate() {
    if (current) void audioEngine.toggle();
    else void audioEngine.playTrack(track, queue, queueIndex, playlistKey);
  }

  function openFromButton(button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect();
    onOpenMenu(track, queueIndex, { x: rect.right - 4, y: rect.bottom + 4 });
  }

  return (
    <div
      className={`trackRow songsGrid${current ? " current" : ""}${playing ? " playing" : ""}`}
      style={{ height: rowHeight }}
      onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest("button")) activate(); }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.currentTarget.focus();
        onOpenMenu(track, queueIndex, { x: event.clientX, y: event.clientY });
      }}
      role="row"
      aria-current={current ? "true" : undefined}
      aria-rowindex={listIndex + 2}
      tabIndex={0}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
          event.preventDefault();
          activate();
        } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(track, queueIndex, { x: rect.left + Math.min(320, rect.width / 2), y: rect.top + 24 });
        }
      }}
    >
      <span className="titleCell" role="cell">
        <button className="rowPlay" onClick={(event) => { event.stopPropagation(); activate(); }} title={playing ? "Pause" : "Play"} aria-label={`${playing ? "Pause" : "Play"} ${displayTrackTitle(track)}`}>
          {playing ? <Pause size={15} /> : current ? <AudioLines size={15} /> : <Play size={15} />}
        </button>
        <Cover path={track.coverPath} title={track.album || undefined} size="sm" />
        <span>
          <strong title={title}>{title}</strong>
          <span className="trackSubtitle"><small className="trackCompactArtist" title={artist}>{artist}</small><small className="trackFormat">{track.fileExt.toUpperCase()}</small></span>
        </span>
      </span>
      <span role="cell"><button className="metadataLink" title={artist} disabled={!track.artist || track.id <= 0} onClick={() => track.artist && openArtist(artist)}>{artist}</button></span>
      <span role="cell"><button className="metadataLink" title={album} disabled={!track.album || track.id <= 0} onClick={() => track.album && openAlbum(album)}>{album}</button></span>
      <span className="durationCell" role="cell">
        {track.favorite && <Heart className="rowFavorite" size={14} fill="currentColor" aria-label="Favorite" />}
        <span className="trackDuration">{formatDuration(track.durationMs)}</span>
        {onMoveTrack && <span className="rowManageActions">
          <button onClick={() => void onMoveTrack(track, listIndex, -1)} disabled={first} aria-label={`Move ${displayTrackTitle(track)} up`}><ArrowUp size={14} /></button>
          <button onClick={() => void onMoveTrack(track, listIndex, 1)} disabled={last} aria-label={`Move ${displayTrackTitle(track)} down`}><ArrowDown size={14} /></button>
        </span>}
        {onRemoveTrack && <button className="rowActionButton danger" onClick={() => void onRemoveTrack(track)} aria-label={`Remove ${displayTrackTitle(track)} from playlist`}><Trash2 size={15} /></button>}
        <button className="rowMoreButton" onClick={(event) => openFromButton(event.currentTarget)} aria-label={`More actions for ${displayTrackTitle(track)}`}><MoreHorizontal size={17} /></button>
      </span>
    </div>
  );
});

function samePlayback(left: { currentId: number | null; playing: boolean }, right: { currentId: number | null; playing: boolean }) {
  return left.currentId === right.currentId && left.playing === right.playing;
}
