import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Pause, Play, Plus, Timer, Undo2 } from "lucide-react";
import { editableLyricLines, setWordTiming } from "../lib/wordTiming";
import { lyricWaveWords } from "../lib/lyrics";
import { useAudio } from "../lib/useAudio";
import { audioEngine } from "../lib/audioEngine";
import { formatDuration } from "../lib/format";
import { LyricWave } from "./LyricWave";
import type { Track } from "../types";

export function WordTimingEditor({ draft, onChange, track, disabled }: { draft: string; onChange: (value: string) => void; track: Track; disabled: boolean }) {
  const audio = useAudio();
  const rows = useMemo(() => editableLyricLines(draft, track.durationMs || 0), [draft, track.durationMs]);
  const [lineIndex, setLineIndex] = useState(0);
  const [wordIndex, setWordIndex] = useState(0);
  const [error, setError] = useState("");
  const history = useRef<string[]>([]);
  const row = rows[Math.min(lineIndex, rows.length - 1)];
  const words = useMemo(() => row ? lyricWaveWords(row.line, row.end) : [], [row]);
  const selected = Math.min(wordIndex, Math.max(0, words.length - 1));
  const canPlay = audio.current?.id === track.id && !audio.localControlBlocked;
  function chooseLine(index: number) { setLineIndex(index); setWordIndex(0); setError(""); }
  function changeTime(milliseconds: number, advance = false) {
    if (!row || disabled) return;
    const starts = words.map(word => Math.round(word.at));
    starts[selected] = Math.round(milliseconds / 10) * 10;
    // When tapping a new line, move unrecorded estimates forward rather than
    // rejecting a valid late first word. Previously stamped words stay fixed.
    if (advance) for (let i = selected + 1; i < starts.length; i++) starts[i] = Math.max(starts[i], starts[i - 1] + 10);
    if (track.durationMs && starts.some(at => at > track.durationMs!)) { setError("Word times must fit inside the song."); return; }
    try {
      const next = setWordTiming(draft, row, starts);
      history.current = [...history.current, draft].slice(-60);
      onChange(next); setError("");
      if (advance && selected < words.length - 1) setWordIndex(selected + 1);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  function stamp() { if (canPlay) changeTime(audioEngine.playhead(), true); }
  if (!row || !words.length) return <div className="wordTimingEmpty">Paste lyrics in the Text tab first, then return here to time the words.</div>;
  return <div className="wordTimingEditor" aria-label="Word timing editor">
    <div className="wordTimingWorkspace">
    <div className="wordTimingIntro"><span className="libraryEyebrow">MAKE EVERY WORD LAND</span><h3>Follow the voice.</h3><p>Choose a word and stamp when it begins. Keep tapping for the next word, or adjust its time below. Save to apply your timing.</p></div>
    <div className="wordLinePicker"><button className="glassIconButton" aria-label="Previous timing line" disabled={!lineIndex || disabled} onClick={() => chooseLine(lineIndex - 1)}><ChevronLeft size={15} /></button><select aria-label="Line to time" value={Math.min(lineIndex, rows.length - 1)} disabled={disabled} onChange={event => chooseLine(Number(event.target.value))}>{rows.map((item, index) => <option key={item.sourceIndex} value={index}>{index + 1}. {item.line.text}</option>)}</select><button className="glassIconButton" aria-label="Next timing line" disabled={lineIndex >= rows.length - 1 || disabled} onClick={() => chooseLine(lineIndex + 1)}><ChevronRight size={15} /></button></div>
    <div className="wordTimingPreview" aria-label="Word timing preview"><LyricWave line={row.line} end={row.end} trackId={track.id} offset={0} /></div>
    <div className="wordTimingWords" role="group" aria-label="Choose a word to time">{words.map((word, index) => <button key={index} className={selected === index ? "selected" : ""} aria-pressed={selected === index} aria-label={`Time word ${index + 1}: ${word.text.trim()}`} disabled={disabled} onClick={() => { setWordIndex(index); setError(""); }}><strong>{word.text.trim()}</strong><small>{(word.at / 1000).toFixed(2)}s</small></button>)}</div>
    <div className="wordTimeAdjust"><span>Word {selected + 1} of {words.length}<small>{row.line.words?.length ? "Word timestamps" : "Estimated until you adjust"}</small></span><button className="glassIconButton" aria-label="Word 0.05 seconds earlier" disabled={disabled || words[selected].at < 50} onClick={() => changeTime(words[selected].at - 50)}><Minus size={14} /></button><label><span className="srOnly">Selected word start in seconds</span><input key={`${row.sourceIndex}:${selected}:${words[selected].at}`} aria-label="Selected word start in seconds" type="number" min={0} max={track.durationMs ? track.durationMs / 1000 : undefined} step="0.01" defaultValue={(words[selected].at / 1000).toFixed(2)} disabled={disabled} onBlur={event => { if (event.currentTarget.value !== "" && Math.abs(event.currentTarget.valueAsNumber * 1000 - words[selected].at) >= 5) changeTime(event.currentTarget.valueAsNumber * 1000); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /><span>s</span></label><button className="glassIconButton" aria-label="Word 0.05 seconds later" disabled={disabled} onClick={() => changeTime(words[selected].at + 50)}><Plus size={14} /></button></div>
    {error && <p className="wordTimingError" role="alert">{error}</p>}
    </div>
    <div className="wordTimingTransport"><button className="glassIconButton" aria-label={audio.playing ? "Pause timing playback" : "Play timing playback"} disabled={!canPlay || disabled} onClick={() => void audioEngine.toggle()}>{audio.playing ? <Pause size={16} /> : <Play size={16} />}</button><button className="glassTextButton" disabled={!canPlay || disabled} onClick={() => { audioEngine.seek(Math.max(0, row.line.at - 1000)); audioEngine.commitSeek(); }}>Replay line</button><output>{formatDuration(canPlay ? audio.position : 0)}</output><button className="primaryAction" aria-label="Stamp next word" disabled={!canPlay || disabled} onClick={stamp}><Timer size={15} />Stamp “{words[selected].text.trim()}”</button><button className="glassIconButton" aria-label="Undo word timing" disabled={!history.current.length || disabled} onClick={() => { const previous = history.current.pop(); if (previous !== undefined) { onChange(previous); setWordIndex(Math.max(0, selected - 1)); setError(""); } }}><Undo2 size={15} /></button></div>
    <p className="wordTimingHint">{canPlay ? "Focus the stamp button and press Space with each word. Replay the line to check the wave." : "Play this song from your library to stamp along. You can still edit times manually."}</p>
  </div>;
}
