import { FileUp, LoaderCircle, Pencil, Save, SearchX, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { errorMessage, useLibraryActions } from "../lib/LibraryContext";
import { useAudio } from "../lib/useAudio";
import type { Track, TrackLyrics } from "../types";
import { ConfirmDialog } from "./OverlayDialogs";

type TimedLine = { at: number; text: string; key: string };

export function LyricsPanel({ track }: { track: Track | null }) {
  const audio = useAudio();
  const { notify } = useLibraryActions();
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);
  const requestGenerationRef = useRef(0);
  const activeTrackIdRef = useRef<number | null>(null);
  activeTrackIdRef.current = track?.id ?? null;

  useEffect(() => {
    const trackId = track?.id ?? null;
    const generation = ++requestGenerationRef.current;
    setEditing(false);
    setLyrics(null);
    setDraft("");
    setConfirmDelete(false);
    setSaving(false);
    setLoading(false);
    if (!trackId || trackId <= 0) return;
    setLoading(true);
    api.getTrackLyrics(trackId)
      .then((result) => {
        if (isCurrentRequest(generation, trackId)) setLyrics(result);
      })
      .catch((error) => {
        if (isCurrentRequest(generation, trackId)) notify(errorMessage(error), "error");
      })
      .finally(() => {
        if (isCurrentRequest(generation, trackId)) setLoading(false);
      });
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [notify, track?.id]);

  function isCurrentRequest(generation: number, trackId: number) {
    return requestGenerationRef.current === generation && activeTrackIdRef.current === trackId;
  }

  const timedLines = useMemo(() => parseLrc(lyrics?.syncedText || ""), [lyrics?.syncedText]);
  const activeIndex = useMemo(() => {
    if (!timedLines.length) return -1;
    let result = -1;
    for (let index = 0; index < timedLines.length; index += 1) {
      if (timedLines[index].at <= audio.position) result = index;
      else break;
    }
    return result;
  }, [audio.position, timedLines]);

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({
      block: "center",
      behavior: document.documentElement.dataset.motion === "reduced" ? "auto" : "smooth"
    });
  }, [activeIndex]);

  function beginEdit() {
    setDraft(lyrics?.syncedText || lyrics?.plainText || "");
    setEditing(true);
  }

  async function save() {
    if (!track || track.id <= 0) return;
    const trackId = track.id;
    const generation = ++requestGenerationRef.current;
    setSaving(true);
    try {
      const containsTiming = parseLrc(draft).length > 0;
      const text = draft.trim() || null;
      const next = await api.saveTrackLyrics({
        trackId,
        plainText: containsTiming ? null : text,
        syncedText: containsTiming ? text : null,
        source: "manual"
      });
      if (isCurrentRequest(generation, trackId)) {
        setLyrics(next);
        setEditing(false);
        notify("Lyrics saved locally.", "success");
      }
    } catch (error) {
      if (isCurrentRequest(generation, trackId)) notify(errorMessage(error), "error");
    } finally {
      if (isCurrentRequest(generation, trackId)) setSaving(false);
    }
  }

  async function importLyrics() {
    if (!track || track.id <= 0) return;
    const trackId = track.id;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    try {
      const imported = await api.importTrackLyrics(trackId);
      if (imported && isCurrentRequest(generation, trackId)) {
        setLyrics(imported);
        setEditing(false);
        notify("Lyrics imported.", "success");
      }
    } catch (error) {
      if (isCurrentRequest(generation, trackId)) notify(errorMessage(error), "error");
    } finally {
      if (isCurrentRequest(generation, trackId)) setLoading(false);
    }
  }

  async function deleteLyrics() {
    if (!track || track.id <= 0) return;
    const trackId = track.id;
    const generation = ++requestGenerationRef.current;
    setSaving(true);
    try {
      await api.deleteTrackLyrics(trackId);
      if (isCurrentRequest(generation, trackId)) {
        setLyrics(null);
        setConfirmDelete(false);
        notify("Lyrics removed from Loavy.", "success");
      }
    } catch (error) {
      if (isCurrentRequest(generation, trackId)) notify(errorMessage(error), "error");
    } finally {
      if (isCurrentRequest(generation, trackId)) setSaving(false);
    }
  }

  if (!track) {
    return (
      <section className="lyricsPanel lyricsEmpty">
        <SearchX size={36} />
        <h2>No song selected</h2>
        <p>Choose a song to view its lyrics.</p>
      </section>
    );
  }

  if (track.id <= 0) {
    return (
      <section className="lyricsPanel lyricsEmpty">
        <SearchX size={36} />
        <h2>Lyrics unavailable</h2>
        <p>Room streams do not have editable local lyrics.</p>
      </section>
    );
  }

  return (
    <section className="lyricsPanel" aria-label="Lyrics">
      <header className="lyricsHeader">
        <div>
          <span>Lyrics</span>
          <strong>{lyrics?.source ? `Saved from ${sourceLabel(lyrics.source)}` : "Stored on this device"}</strong>
        </div>
        <div className="lyricsActions">
          {!editing && <button className="glassTextButton" onClick={() => void importLyrics()} disabled={loading} title="Import .lrc or .txt lyrics"><FileUp size={16} /> Import</button>}
          {!editing && <button className="glassTextButton" onClick={beginEdit} disabled={loading}><Pencil size={16} /> {lyrics ? "Edit" : "Paste lyrics"}</button>}
          {lyrics && !editing && <button className="glassIconButton" onClick={() => setConfirmDelete(true)} aria-label="Delete saved lyrics"><Trash2 size={17} /></button>}
        </div>
      </header>

      {loading ? (
        <div className="lyricsLoading"><LoaderCircle className="spin" size={24} /><span>Loading lyrics</span></div>
      ) : editing ? (
        <div className="lyricsEditor">
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Paste plain text lyrics, or LRC lines such as [01:24.50]…"
            aria-label="Lyrics text"
          />
          <div>
            <span>Lyrics stay in Loavy's local database.</span>
            <button className="glassTextButton" onClick={() => setEditing(false)} disabled={saving}><X size={16} /> Cancel</button>
            <button className="primaryAction" onClick={() => void save()} disabled={saving || !draft.trim()}>
              {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Save
            </button>
          </div>
        </div>
      ) : timedLines.length ? (
        <div className="lyricsScroll syncedLyrics" aria-live="off">
          {timedLines.map((line, index) => (
            <p
              key={line.key}
              ref={index === activeIndex ? activeLineRef : undefined}
              className={index === activeIndex ? "active" : index < activeIndex ? "past" : ""}
            >
              {line.text || "♪"}
            </p>
          ))}
        </div>
      ) : lyrics?.plainText ? (
        <div className="lyricsScroll plainLyrics">
          {lyrics.plainText.split(/\r?\n/).map((line, index) => <p key={`${index}-${line}`}>{line || "\u00a0"}</p>)}
        </div>
      ) : (
        <div className="lyricsEmpty lyricsEmptyInline">
          <SearchX size={32} />
          <h2>No lyrics saved</h2>
          <p>Import an LRC or text file, or paste lyrics you already have.</p>
          <div><button className="secondaryAction" onClick={() => void importLyrics()}><FileUp size={16} /> Import file</button><button className="primaryAction" onClick={beginEdit}><Pencil size={16} /> Paste lyrics</button></div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Remove saved lyrics?"
          description="The song file will not be changed. Only Loavy's local lyrics copy will be removed."
          confirmLabel="Remove lyrics"
          danger
          busy={saving}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => void deleteLyrics()}
        />
      )}
    </section>
  );
}

function parseLrc(value: string): TimedLine[] {
  const lines: TimedLine[] = [];
  value.split(/\r?\n/).forEach((line, sourceIndex) => {
    const matches = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!matches.length) return;
    const text = line.replace(/\[[^\]]+\]/g, "").trim();
    matches.forEach((match, matchIndex) => {
      const fraction = (match[3] || "0").padEnd(3, "0").slice(0, 3);
      lines.push({
        at: (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number(fraction),
        text,
        key: `${sourceIndex}-${matchIndex}-${match[0]}`
      });
    });
  });
  return lines.sort((a, b) => a.at - b.at);
}

function sourceLabel(source: string) {
  if (source === "local-file") return "an imported file";
  if (source === "manual") return "manual entry";
  return source;
}
