import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Heart, Play } from "lucide-react";
import { audioEngine } from "../lib/audioEngine";
import { displayAlbum, displayArtist, displayTrackTitle, formatDuration } from "../lib/format";
import type { Track } from "../types";
import { Cover } from "./Cover";

const ROW_HEIGHT = 62;
const OVERSCAN = 8;

export function VirtualSongList({ tracks }: { tracks: Track[] }) {
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(520);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      setHeight(entry.contentRect.height);
    });
    resizeObserver.observe(node);
    setHeight(node.clientHeight);

    return () => resizeObserver.disconnect();
  }, []);

  const windowed = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(tracks.length, start + visibleCount);
    return {
      start,
      end,
      items: tracks.slice(start, end),
      offsetY: start * ROW_HEIGHT,
      totalHeight: tracks.length * ROW_HEIGHT
    };
  }, [height, scrollTop, tracks]);

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const nextScrollTop = event.currentTarget.scrollTop;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      setScrollTop(nextScrollTop);
      frameRef.current = null;
    });
  }

  return (
    <section className="tableSurface virtualTable">
      <div className="tableHeader songsGrid">
        <span>Title</span>
        <span>Artist</span>
        <span>Album</span>
        <span>Time</span>
      </div>
      <div
        className="virtualScroller"
        onScroll={handleScroll}
        ref={scrollerRef}
      >
        <div style={{ height: windowed.totalHeight, position: "relative" }}>
          <div className="virtualWindow" style={{ transform: `translate3d(0, ${windowed.offsetY}px, 0)` }}>
            {windowed.items.map((track, virtualIndex) => {
              const index = windowed.start + virtualIndex;
              return (
                <SongRow
                  key={track.id}
                  index={index}
                  queue={tracks}
                  track={track}
                />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

const SongRow = memo(function SongRow({ track, queue, index }: { track: Track; queue: Track[]; index: number }) {
  return (
    <div
      className="trackRow songsGrid"
      style={{ height: ROW_HEIGHT }}
      onDoubleClick={() => void audioEngine.playTrack(track, queue, index)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void audioEngine.playTrack(track, queue, index);
        }
      }}
    >
      <span className="titleCell">
        <button
          className="rowPlay"
          onClick={(event) => {
            event.stopPropagation();
            void audioEngine.playTrack(track, queue, index);
          }}
          title="Play"
        >
          <Play size={15} />
        </button>
        <Cover path={track.coverPath} title={track.album || undefined} size="sm" />
        <span>
          <strong>{displayTrackTitle(track)}</strong>
          <small>{track.fileExt.toUpperCase()}</small>
        </span>
      </span>
      <span>{displayArtist(track.artist)}</span>
      <span>{displayAlbum(track.album)}</span>
      <span className="durationCell">
        {track.favorite && <Heart size={14} fill="currentColor" />}
        {formatDuration(track.durationMs)}
      </span>
    </div>
  );
});
