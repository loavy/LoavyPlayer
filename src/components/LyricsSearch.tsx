import { ArrowLeft, Check, LoaderCircle, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { errorMessage } from "../lib/LibraryContext";
import { parseLrc, plainLyrics } from "../lib/lyrics";
import { displayTrackTitle, formatDuration } from "../lib/format";
import type { LyricsMatch, Track } from "../types";

export function LyricsSearch({ track, onClose, onChoose, saving }: { track: Track; onClose: () => void; onChoose: (match: LyricsMatch) => Promise<void>; saving: boolean }) {
  const [query, setQuery] = useState(`${displayTrackTitle(track)} ${track.artist && track.artist !== "Unknown Artist" ? track.artist : ""}`.trim());
  const [results, setResults] = useState<LyricsMatch[]>([]);
  const [selected, setSelected] = useState<LyricsMatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);

  async function search() {
    if (busy || saving || query.trim().length < 2) return;
    const request = ++revision.current;
    setBusy(true); setError(null); setSearched(true); setSelected(null);
    try {
      const found = await api.searchOnlineLyrics(query.trim());
      if (request === revision.current) setResults(found);
    } catch (error) { if (request === revision.current) { setError(errorMessage(error)); setResults([]); } }
    finally { if (request === revision.current) setBusy(false); }
  }

  return <div className="lyricsSearchView">
    <div className="lyricsSearchTop"><button className="glassTextButton" onClick={selected ? () => setSelected(null) : onClose} disabled={saving}><ArrowLeft size={15} />{selected ? "Results" : "Back to lyrics"}</button><span>Powered by LRCLIB</span></div>
    {selected ? <div className="lyricsPreview">
      <div><h3>{selected.trackName || "Untitled"}</h3><p>{selected.artistName} · {selected.albumName || "Unknown album"}</p><span className="lyricsBadge">{selected.instrumental ? "Instrumental" : parseLrc(selected.syncedLyrics || "").length ? "Synced · click-to-seek" : "Plain text · no timing"}</span></div>
      <pre>{selected.instrumental ? "Instrumental — no vocals." : selected.plainLyrics || plainLyrics(selected.syncedLyrics || "")}</pre>
      <div className="lyricsPreviewActions"><span>Replaces this song's saved lyrics. Your edits stay private.</span><button className="primaryAction" disabled={saving} onClick={() => void onChoose(selected)}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Use these lyrics</button></div>
    </div> : <>
      <form className="lyricsSearchForm" onSubmit={event => { event.preventDefault(); void search(); }}><label htmlFor="lyrics-online-query">Song title and artist</label><div><input id="lyrics-online-query" value={query} maxLength={240} onChange={event => setQuery(event.target.value)} placeholder="Search for a song or another version" autoFocus /><button className="primaryAction" disabled={busy || query.trim().length < 2}>{busy ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />} Search</button></div></form>
      {error && <p className="lyricsInlineError" role="alert">{error}</p>}
      <div className="lyricsSearchResults" aria-busy={busy}>
        {busy ? <p role="status">Searching LRCLIB…</p> : results.length ? results.map(result => <button className="lyricsResult" key={result.id} onClick={() => setSelected(result)}><div><strong>{result.trackName || "Untitled"}</strong><span>{result.artistName || "Unknown artist"} · {result.albumName || "Unknown album"}</span></div><div><span className="lyricsBadge">{result.instrumental ? "Instrumental" : parseLrc(result.syncedLyrics || "").length ? "Synced" : "Plain text"}</span><small>{result.duration ? formatDuration(result.duration * 1000) : ""}</small></div></button>) : <div className="lyricsSearchHint"><Search size={28} /><h3>{searched ? "No matching lyrics yet" : "Find the right version"}</h3><p>{searched ? "Try fewer words, the original title, or a different artist spelling. You can always import or write your own." : "Search by title and artist, then preview a result. Choose a synced version to jump through the song by clicking its lyrics."}</p></div>}
      </div>
    </>}
  </div>;
}
