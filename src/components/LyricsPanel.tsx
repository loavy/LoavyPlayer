import { Download, FileUp, Focus, Globe, LoaderCircle, Minus, Pencil, Plus, Save, Search, SearchX, Timer, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { errorMessage, useLibraryActions } from "../lib/LibraryContext";
import { useAudio } from "../lib/useAudio";
import type { LyricsMatch, Track, TrackLyrics } from "../types";
import { ConfirmDialog } from "./OverlayDialogs";
import { activeLyricIndex, lrcOffset, lyricTimestamp, parseLrc, plainLyrics, shiftLyrics } from "../lib/lyrics";
import { audioEngine } from "../lib/audioEngine";
import { LyricsSearch } from "./LyricsSearch";

const missedLookups = new Map<number, number>();
const draftKey = (id: number) => `loavy.lyricsDraft.${id}`;
function readDraft(id: number) { try { return localStorage.getItem(draftKey(id)); } catch { return null; } }

export function LyricsPanel({ track }: { track: Track | null }) {
  const audio = useAudio();
  const { notify } = useLibraryActions();
  const headingId = useId();
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [following, setFollowing] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [searching, setSearching] = useState(false);
  const [finding, setFinding] = useState(false);
  const [onlineMessage, setOnlineMessage] = useState<string | null>(null);
  const [autoSearch, setAutoSearch] = useState(true);
  const [offline, setOffline] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);
  const lyricsScrollRef = useRef<HTMLDivElement | null>(null);
  const requestGenerationRef = useRef(0);
  const activeTrackIdRef = useRef<number | null>(null);
  activeTrackIdRef.current = track?.id ?? null;

  useEffect(() => {
    const trackId = track?.id ?? null;
    const generation = ++requestGenerationRef.current;
    setEditing(false);
    setSearching(false);
    setFinding(false);
    setToolsOpen(false);
    setOnlineMessage(null);
    setFollowing(true);
    setLoadError(null);
    setLyrics(null);
    setDraft("");
    setConfirmDelete(false);
    setSaving(false);
    setLoading(false);
    if (!trackId || trackId <= 0) return;
    setLoading(true);
    api.getTrackLyrics(trackId)
      .then(async (result) => {
        if (!isCurrentRequest(generation, trackId)) return;
        setLyrics(result);
        setLoading(false);
        const [auto, offlineMode] = await Promise.all([api.getSetting("lyricsAutoSearch"), api.getSetting("offlineMode")]).catch(error => {
          if (isCurrentRequest(generation, trackId)) setOnlineMessage(errorMessage(error));
          return ["false", "false"];
        });
        if (!isCurrentRequest(generation, trackId)) return;
        setAutoSearch(auto !== "false"); setOffline(offlineMode === "true");
        if (result || auto === "false" || offlineMode === "true") return;
        if (Date.now() - (missedLookups.get(trackId) || 0) < 300000) return;
        setFinding(true);
        try {
          const found = await api.lookupOnlineLyrics(trackId);
          if (!isCurrentRequest(generation, trackId)) return;
          if (found) { setLyrics(found); setOnlineMessage("Found on LRCLIB · saved for offline listening."); }
          else {
            if (missedLookups.size > 200) missedLookups.clear();
            missedLookups.set(trackId, Date.now());
            setOnlineMessage("No confident match. Search by title and artist to choose a version.");
          }
        } catch (error) { if (isCurrentRequest(generation, trackId)) setOnlineMessage(errorMessage(error)); }
        finally { if (isCurrentRequest(generation, trackId)) setFinding(false); }
      })
      .catch((error) => {
        if (isCurrentRequest(generation, trackId)) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (isCurrentRequest(generation, trackId)) setLoading(false);
      });
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [notify, track?.id, reload]);

  function isCurrentRequest(generation: number, trackId: number) {
    return requestGenerationRef.current === generation && activeTrackIdRef.current === trackId;
  }

  const timedLines = useMemo(() => parseLrc(lyrics?.syncedText || ""), [lyrics?.syncedText]);
  const activeIndex = activeLyricIndex(timedLines, audio.position);

  useEffect(() => {
    const container = lyricsScrollRef.current;
    const activeLine = activeLineRef.current;
    if (!container || !activeLine || !following || editing || searching) return;
    function centerLine() {
      const containerBounds = container!.getBoundingClientRect();
      const lineBounds = activeLine!.getBoundingClientRect();
      const centeredTop = container!.scrollTop + lineBounds.top - containerBounds.top - (container!.clientHeight - lineBounds.height) / 2;
      container!.scrollTo({ top: Math.max(0, centeredTop), behavior: document.documentElement.dataset.motion === "reduced" ? "instant" : "smooth" });
    }
    centerLine();
    const observer = new ResizeObserver(centerLine);
    observer.observe(container);
    observer.observe(activeLine);
    return () => observer.disconnect();
  }, [activeIndex, following, editing, searching, timedLines]);

  function seekLine(at: number) {
    if (audio.current?.id !== track?.id || audio.localControlBlocked) return;
    if (audioEngine.seek(at)) { audioEngine.commitSeek(); setFollowing(true); }
  }

  function beginEdit() {
    if (!track) return;
    requestGenerationRef.current++;
    setFinding(false);
    setDraft(readDraft(track.id) ?? lyrics?.syncedText ?? lyrics?.plainText ?? "");
    setEditing(true);
    setSearching(false);
  }

  function updateDraft(value: string) {
    setDraft(value);
    if (track) { try { localStorage.setItem(draftKey(track.id), value); } catch { /* The in-memory draft remains available. */ } }
  }

  function stampLine() {
    const field = editorRef.current;
    if (!field || audio.current?.id !== track?.id) return;
    const start = field.selectionStart === 0 ? 0 : draft.lastIndexOf("\n", field.selectionStart - 1) + 1;
    const endIndex = draft.indexOf("\n", field.selectionStart);
    const end = endIndex < 0 ? draft.length : endIndex;
    const line = draft.slice(start, end).replace(/^(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\])+/, "");
    const replacement = lyricTimestamp(audio.position + lrcOffset(draft)) + line;
    updateDraft(draft.slice(0, start) + replacement + draft.slice(end));
    requestAnimationFrame(() => { field.focus(); const next = Math.min(start + replacement.length + 1, field.value.length); field.setSelectionRange(next, next); });
  }

  async function chooseOnline(match: LyricsMatch) {
    if (!track || saving) return;
    const trackId = track.id, generation = ++requestGenerationRef.current;
    setSaving(true);
    try {
      const next = await api.saveTrackLyrics({ trackId, plainText: match.instrumental ? "[Instrumental]" : match.plainLyrics || plainLyrics(match.syncedLyrics || ""), syncedText: match.syncedLyrics, source: `lrclib:${match.id}` });
      if (isCurrentRequest(generation, trackId)) { setLyrics(next); setLoadError(null); setSearching(false); setOnlineMessage("Saved for offline listening. You can edit or download this version."); notify("Lyrics saved from LRCLIB.", "success"); }
    } catch (error) { if (isCurrentRequest(generation, trackId)) notify(errorMessage(error), "error"); }
    finally { if (isCurrentRequest(generation, trackId)) setSaving(false); }
  }

  function openSearch() { requestGenerationRef.current++; setFinding(false); setSearching(true); setToolsOpen(false); }

  async function download(format: "lrc" | "txt") {
    if (!track || exporting || saving) return;
    setExporting(true);
    try { if (await api.exportTrackLyrics(track.id, format)) notify("Lyrics downloaded.", "success"); }
    catch (error) { notify(errorMessage(error), "error"); }
    finally { setExporting(false); }
  }

  async function toggleAuto(enabled: boolean) {
    try { await api.setSetting("lyricsAutoSearch", String(enabled)); setAutoSearch(enabled); if (enabled) { if (track) missedLookups.delete(track.id); setReload(value => value + 1); } }
    catch (error) { notify(errorMessage(error), "error"); }
  }

  async function save() {
    if (!track || track.id <= 0 || saving || loading) return;
    const trackId = track.id;
    const generation = ++requestGenerationRef.current;
    setSaving(true);
    try {
      const containsTiming = parseLrc(draft).length > 0;
      const text = draft.trim() || null;
      const next = await api.saveTrackLyrics({
        trackId,
        plainText: containsTiming ? plainLyrics(draft) : text,
        syncedText: containsTiming ? text : null,
        source: "manual"
      });
      if (isCurrentRequest(generation, trackId)) {
        setLyrics(next);
        setLoadError(null);
        setEditing(false);
        try { localStorage.removeItem(draftKey(trackId)); } catch { /* Saving to the database succeeded. */ }
        notify("Lyrics saved locally.", "success");
      }
    } catch (error) {
      if (isCurrentRequest(generation, trackId)) notify(errorMessage(error), "error");
    } finally {
      if (isCurrentRequest(generation, trackId)) setSaving(false);
    }
  }

  async function importLyrics() {
    if (!track || track.id <= 0 || loading || saving) return;
    const trackId = track.id;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    try {
      const imported = await api.importTrackLyrics(trackId);
      if (imported && isCurrentRequest(generation, trackId)) {
        setLoadError(null);
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
    if (!track || track.id <= 0 || loading || saving) return;
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
    <section className="lyricsPanel" aria-labelledby={headingId} aria-busy={loading || saving}>
      <header className="lyricsHeader">
        <div className="lyricsHeaderCopy">
          <h2 id={headingId} className="lyricsHeading">Lyrics</h2>
          <p className="lyricsSource">{lyrics?.source ? `${sourceLabel(lyrics.source)} · saved offline` : offline ? "Offline mode" : "Your words. In time with your music."}</p>
        </div>
        <div className="lyricsActions" role="group" aria-label="Lyrics actions">
          {!editing && !searching && <><button className="glassTextButton" onClick={openSearch} disabled={loading || saving} title="Search online lyrics"><Search size={16} /> Find</button>
          <button className="glassTextButton" onClick={beginEdit} disabled={loading || saving} title={lyrics ? "Edit lyrics" : "Paste lyrics"}><Pencil size={16} />{readDraft(track.id) !== null ? "Resume draft" : "Edit"}</button>
          <button className="glassIconButton" disabled={loading || saving} onClick={() => setToolsOpen(value => !value)} title="Download and lyric options" aria-label="Download and lyric options" aria-expanded={toolsOpen}><Download size={17} /></button></>}
        </div>
      </header>

      {toolsOpen && !editing && !searching && <div className="lyricsToolsBar"><div><button className="glassTextButton" onClick={() => void download("lrc")} disabled={!timedLines.length || exporting}><Download size={14} /> LRC</button><button className="glassTextButton" onClick={() => void download("txt")} disabled={!lyrics || exporting}><Download size={14} /> TXT</button><button className="glassTextButton" onClick={() => void importLyrics()} disabled={loading || saving} title="Import .lrc or .txt lyrics"><FileUp size={14} /> Import</button>{lyrics && <button className="glassIconButton" disabled={loading || saving || finding} onClick={() => setConfirmDelete(true)} title="Delete saved lyrics" aria-label="Delete saved lyrics"><Trash2 size={15} /></button>}</div><label><input type="checkbox" checked={autoSearch} onChange={event => void toggleAuto(event.target.checked)} /> Find missing lyrics online automatically</label></div>}

      <div className="lyricsBody">
        {searching ? <LyricsSearch key={track.id} track={track} onClose={() => setSearching(false)} onChoose={chooseOnline} saving={saving} /> : loadError && !editing ? <div className="lyricsLoadError" role="alert">Could not load lyrics. {loadError}<button className="secondaryAction" onClick={() => setReload((value) => value + 1)}>Try again</button></div> : loading ? (
        <div className="lyricsLoading" role="status" aria-live="polite"><LoaderCircle className="spin" size={24} /><span>Loading lyrics</span></div>
      ) : editing ? (
        <div className="lyricsEditor">
          <div className="lyricsEditorTools"><button className="glassTextButton" onClick={stampLine} disabled={saving || audio.current?.id !== track.id} title="Stamp the cursor's line, then advance to the next"><Timer size={15} /> Stamp current time</button><button className="glassTextButton" onClick={() => updateDraft(shiftLyrics(draft, -250))} disabled={saving || !parseLrc(draft).length} title="Move all lines 0.25 seconds earlier"><Minus size={14} /> 0.25s</button><button className="glassTextButton" onClick={() => updateDraft(shiftLyrics(draft, 250))} disabled={saving || !parseLrc(draft).length} title="Move all lines 0.25 seconds later"><Plus size={14} /> 0.25s</button></div>
          <textarea
            ref={editorRef}
            autoFocus
            value={draft}
            disabled={saving}
            maxLength={200000}
            onChange={(event) => updateDraft(event.target.value)}
            placeholder="Paste plain text lyrics, or LRC lines such as [01:24.50]…"
            aria-label="Lyrics text"
          />
          <div>
            <span>Draft kept on this device. Stamp lines while listening, then save.</span>
            <button className="glassTextButton" onClick={() => setEditing(false)} disabled={saving}><X size={16} /> Cancel</button>
            <button className="primaryAction" onClick={() => void save()} disabled={saving || !draft.trim()}>
              {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} Save
            </button>
          </div>
        </div>
      ) : timedLines.length ? (
        <div ref={lyricsScrollRef} className="lyricsScroll syncedLyrics" role="region" aria-label="Synchronized lyrics" tabIndex={0}
          onWheel={() => setFollowing(false)} onTouchStart={() => setFollowing(false)}
          onPointerDown={(event) => { if (event.target === event.currentTarget) setFollowing(false); }}
          onKeyDown={(event) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) setFollowing(false); }}>
          {timedLines.map((line, index) => (
            <p
              key={line.key}
              ref={index === activeIndex ? activeLineRef : undefined}
              className={index === activeIndex ? "active" : index < activeIndex ? "past" : ""}
              aria-current={index === activeIndex ? "true" : undefined}
            >
              <button className="lyricLineButton" onClick={() => seekLine(line.at)} disabled={audio.localControlBlocked || audio.current?.id !== track.id} title={audio.localControlBlocked ? "Playback is controlled by the Jam host" : "Jump to this line"}>{line.text || "♪"}</button>
            </p>
          ))}
        </div>
      ) : lyrics?.plainText === "[Instrumental]" ? <div className="lyricsEmpty lyricsEmptyInline"><Globe size={32} /><h2>Let the music speak</h2><p>This version is marked as instrumental. Find another version if that doesn't sound right.</p><button className="secondaryAction" onClick={openSearch}>Find another version</button></div> : lyrics?.plainText ? (
        <div className="lyricsScroll plainLyrics" role="region" aria-label="Lyrics text" tabIndex={0}>
          {lyrics.plainText.split(/\r?\n/).map((line, index) => <p key={`${index}-${line}`}>{line || "\u00a0"}</p>)}
        </div>
      ) : (
        <div className="lyricsEmpty lyricsEmptyInline">
          {finding ? <LoaderCircle className="spin" size={32} /> : <Search size={32} />}
          <h2>{finding ? "Finding your lyrics…" : "Every song has a story"}</h2>
          <p>{finding ? "Looking for the right title, artist and timing on LRCLIB." : onlineMessage || (offline ? "Offline mode is on. Import a file or paste lyrics to keep listening offline." : "Search online, import a lyric file, or write your own.")}</p>
          <div><button className="primaryAction" onClick={openSearch}><Search size={16} /> Find lyrics</button><button className="secondaryAction" onClick={beginEdit}><Pencil size={16} /> Paste lyrics</button><button className="glassTextButton" onClick={() => void importLyrics()} disabled={finding}><FileUp size={16} /> Import</button></div>
        </div>
        )}
      </div>
      {!!lyrics && !editing && !searching && !loading && <footer className="lyricsFollowBar"><span>{timedLines.length ? audio.localControlBlocked ? "Synced with your host" : "Click a line to jump to it" : "Plain lyrics · add timestamps in Edit to enable seeking"}</span>{!!timedLines.length && <button className="glassTextButton" aria-pressed={following} onClick={() => setFollowing((value) => !value)}><Focus size={15} />{following ? "Following song" : "Follow song"}</button>}</footer>}

      {confirmDelete && (
        <ConfirmDialog
          title="Remove saved lyrics?"
          description="Removes the saved lyrics. Automatic search will skip this song until you choose another version using Find."
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

function sourceLabel(source: string) {
  if (source.startsWith("lrclib:")) return "LRCLIB";
  if (source === "local-file") return "an imported file";
  if (source === "manual") return "manual entry";
  return source;
}
