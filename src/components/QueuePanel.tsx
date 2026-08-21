import { ChevronDown, ChevronUp, ListMusic, Pause, Play, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type UIEvent as ReactUIEvent } from "react";
import { createPortal } from "react-dom";
import { audioEngine, type AudioSnapshot } from "../lib/audioEngine";
import { displayArtist, displayTrackTitle } from "../lib/format";
import { useAudioSelector } from "../lib/useAudio";
import { Cover } from "./Cover";

const QUEUE_ROW_HEIGHT = 58;
const QUEUE_ROW_GAP = 4;
const QUEUE_ROW_STRIDE = QUEUE_ROW_HEIGHT + QUEUE_ROW_GAP;
const QUEUE_OVERSCAN = 6;

type QueuePanelAudio = Pick<
  AudioSnapshot,
  "current" | "playing" | "currentIndex" | "upNext" | "localControlBlocked"
>;

function selectQueuePanelAudio(snapshot: AudioSnapshot): QueuePanelAudio {
  return {
    current: snapshot.current,
    playing: snapshot.playing,
    currentIndex: snapshot.currentIndex,
    upNext: snapshot.upNext,
    localControlBlocked: snapshot.localControlBlocked
  };
}

function sameQueuePanelAudio(left: QueuePanelAudio, right: QueuePanelAudio) {
  return left.current === right.current
    && left.playing === right.playing
    && left.currentIndex === right.currentIndex
    && left.upNext === right.upNext
    && left.localControlBlocked === right.localControlBlocked;
}

export function QueuePanel({ onClose }: { onClose: () => void }) {
  const audio = useAudioSelector(selectQueuePanelAudio, sameQueuePanelAudio);
  const panelRef = useRef<HTMLElement>(null);
  const queueListRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  onCloseRef.current = onClose;
  const firstUpcomingIndex = Math.max(0, audio.currentIndex + 1);
  const visibleStart = Math.max(0, Math.floor(scrollTop / QUEUE_ROW_STRIDE) - QUEUE_OVERSCAN);
  const visibleEnd = Math.min(
    audio.upNext.length,
    Math.ceil((scrollTop + Math.max(viewportHeight, QUEUE_ROW_STRIDE)) / QUEUE_ROW_STRIDE) + QUEUE_OVERSCAN
  );
  const visibleTracks = audio.upNext.slice(visibleStart, visibleEnd);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"
      )).filter((element) => !element.hasAttribute("hidden") && element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const element = queueListRef.current;
    if (!element) return;
    const updateHeight = () => setViewportHeight(element.clientHeight);
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = queueListRef.current;
    if (!element) return;
    const maximum = Math.max(0, audio.upNext.length * QUEUE_ROW_STRIDE - element.clientHeight);
    if (element.scrollTop <= maximum) return;
    element.scrollTop = maximum;
    setScrollTop(maximum);
  }, [audio.upNext.length, viewportHeight]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  function onQueueScroll(event: ReactUIEvent<HTMLDivElement>) {
    const nextScrollTop = event.currentTarget.scrollTop;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(nextScrollTop);
    });
  }

  return createPortal(
    <div className="queueBackdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="queuePanel" ref={panelRef} role="dialog" aria-modal="true" aria-label="Playback queue" tabIndex={-1}>
        <header className="queueHeader">
          <div><ListMusic size={20} /><span><strong>Queue</strong><small>{audio.upNext.length} next up</small></span></div>
          <button className="iconButton" onClick={onClose} aria-label="Close queue"><X size={19} /></button>
        </header>

        {audio.localControlBlocked && <p className="queuePermission">The room host controls playback and the queue.</p>}

        <div className="queueContent">
          <section className="queueSection">
            <header><span>Now playing</span></header>
            {audio.current ? (
              <button className="queueTrack current" onClick={() => void audioEngine.toggle()} disabled={audio.localControlBlocked}>
                <Cover path={audio.current.coverPath} title={audio.current.album || undefined} size="sm" />
                <span><strong>{displayTrackTitle(audio.current)}</strong><small>{displayArtist(audio.current.artist)}</small></span>
                {audio.playing ? <Pause size={18} /> : <Play size={18} fill="currentColor" />}
              </button>
            ) : <p className="queueEmpty">Choose a song to start a queue.</p>}
          </section>

          <section className="queueSection queueUpcoming">
            <header>
              <span>Next up</span>
              {!!audio.upNext.length && <button onClick={() => audioEngine.clearUpcoming()} disabled={audio.localControlBlocked}>Clear</button>}
            </header>
            <div
              className={`queueList${audio.upNext.length ? "" : " empty"}`}
              ref={queueListRef}
              onScroll={onQueueScroll}
              role="list"
              aria-label="Next up"
            >
              {!!audio.upNext.length && (
                <div className="queueListSpacer" style={{ height: audio.upNext.length * QUEUE_ROW_STRIDE }}>
                  <div className="queueListWindow" style={{ transform: `translateY(${visibleStart * QUEUE_ROW_STRIDE}px)` }}>
              {visibleTracks.map((track, visibleOffset) => {
                const offset = visibleStart + visibleOffset;
                const queueIndex = firstUpcomingIndex + offset;
                return (
                  <div
                    className="queueTrack"
                    key={`${track.id}-${track.path}-${queueIndex}`}
                    role="listitem"
                    aria-setsize={audio.upNext.length}
                    aria-posinset={offset + 1}
                  >
                    <button className="queueTrackMain" onClick={() => void audioEngine.playQueuedItem(queueIndex)} disabled={audio.localControlBlocked} title="Play now">
                      <Cover path={track.coverPath} title={track.album || undefined} size="sm" />
                      <span><strong>{displayTrackTitle(track)}</strong><small>{displayArtist(track.artist)}</small></span>
                      <Play size={15} />
                    </button>
                    <span className="queueTrackActions">
                      <button
                        onClick={() => audioEngine.moveQueueItem(queueIndex, queueIndex - 1)}
                        disabled={audio.localControlBlocked || offset === 0}
                        aria-label={`Move ${displayTrackTitle(track)} up`}
                      ><ChevronUp size={15} /></button>
                      <button
                        onClick={() => audioEngine.moveQueueItem(queueIndex, queueIndex + 1)}
                        disabled={audio.localControlBlocked || offset === audio.upNext.length - 1}
                        aria-label={`Move ${displayTrackTitle(track)} down`}
                      ><ChevronDown size={15} /></button>
                      <button
                        onClick={() => audioEngine.removeFromQueue(queueIndex)}
                        disabled={audio.localControlBlocked}
                        aria-label={`Remove ${displayTrackTitle(track)} from queue`}
                      ><Trash2 size={15} /></button>
                    </span>
                  </div>
                );
              })}
                  </div>
                </div>
              )}
              {!audio.upNext.length && (
                <div className="queueEmpty queueEmptyState"><ListMusic size={28} /><strong>Nothing queued</strong><span>Use a song's menu to play it next or add it here.</span></div>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>,
    document.body
  );
}
