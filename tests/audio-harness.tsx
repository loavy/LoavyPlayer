import { createRoot } from "react-dom/client";
import { useState } from "react";
import { audioEngine } from "../src/lib/audioEngine";
import { audioGraph } from "../src/lib/audioGraph";
import { audioPreferences } from "../src/lib/audioPreferences";
import { installListeningStats, listeningStats } from "../src/lib/listeningStats";
import { AudioSettingsPanel } from "../src/components/AudioSettingsPanel";
import { MusicVisualizer } from "../src/components/MusicVisualizer";
import { StatsView } from "../src/views/StatsView";
import { LibraryActionsProvider } from "../src/lib/LibraryContext";
import type { Track } from "../src/types";
import "../src/styles.css";
import "../src/redesign.css";
import "../src/desktop.css";
import "../src/audio-glass.css";

const browser = window as any;
browser.__TAURI_INTERNALS__ = { convertFileSrc: (path: string) => path, async invoke(command: string, args: any) {
  if (command === "get_setting") return localStorage.getItem(args.key);
  if (command === "set_setting") localStorage.setItem(args.update.key, args.update.value);
  return null;
} };
function tone(id: number, seconds = 2.8, frequency = 220): Track {
  const rate = 48000, frames = Math.round(rate * seconds), bytes = new ArrayBuffer(44 + frames * 2), data = new DataView(bytes);
  const string = (offset: number, value: string) => [...value].forEach((letter, index) => data.setUint8(offset + index, letter.charCodeAt(0)));
  string(0, "RIFF"); data.setUint32(4, bytes.byteLength - 8, true); string(8, "WAVEfmt "); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true); string(36, "data"); data.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) data.setInt16(44 + i * 2, Math.round(Math.sin(i / rate * frequency * Math.PI * 2) * .22 * 32767), true);
  return { id, path: URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })), title: `Tone ${id}`, fileName: `tone-${id}.wav`, artist: id % 2 ? "Studio A" : "Studio B", album: "Audio checks", fileExt: "wav", fileSize: bytes.byteLength, modifiedAt: 0, durationMs: seconds * 1000, favorite: false, dateAdded: 0, playCount: 0 };
}
const tracks = [tone(1), tone(2), tone(3), tone(4, 5, 1000)];
const advances: any[] = [];
window.addEventListener("loavy:local-playback-changed", () => { const s = audioEngine.snapshot(); if (s.current && advances.at(-1)?.id !== s.current.id) advances.push({ id: s.current.id, contextTime: audioGraph.ensure().context.currentTime, position: s.position }); });
let capture: { time: number; samples: number[] }[] = [], recorder: ScriptProcessorNode | null = null;
browser.audioTest = {
  engine: audioEngine, graph: audioGraph, preferences: audioPreferences, stats: listeningStats, tracks, advances,
  snapshot: () => audioEngine.snapshot(),
  play: (index = 0, queue = [tracks[index]]) => audioEngine.playTrack(tracks[index], queue, queue.indexOf(tracks[index])),
  async capture() {
    capture = []; recorder?.disconnect();
    const { context, input } = await audioGraph.resume();
    recorder = context.createScriptProcessor(256, 1, 1);
    recorder.onaudioprocess = (event) => { capture.push({ time: event.playbackTime, samples: [...event.inputBuffer.getChannelData(0)] }); };
    input.connect(recorder); const silence = context.createGain(); silence.gain.value = 0; recorder.connect(silence); silence.connect(context.destination);
  },
  pcm: () => capture,
  rms() { const analyser = audioGraph.getAnalyser(); if (!analyser) return 0; const buffer = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(buffer); return Math.sqrt(buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length); }
};
installListeningStats();
function Harness() {
  const [view, setView] = useState("sound"); browser.audioTest.view = setView;
  return <LibraryActionsProvider value={{ notify() {}, refreshLibrary: async () => {}, openArtist() {}, openAlbum() {} }}><main className="audioHarness" style={{ height: "100dvh", padding: 20, overflow: "auto", maxWidth: 1000, margin: "auto" }}><button onClick={() => void audioEngine.playTrack(tracks[0], tracks, 0)}>Start tone</button>{view === "sound" ? <AudioSettingsPanel /> : <div style={{ height: "calc(100dvh - 70px)" }}><StatsView tracks={tracks} /></div>}<MusicVisualizer className="audioTestVisualizer" /></main></LibraryActionsProvider>;
}
document.documentElement.dataset.glass = "on";
const style = document.createElement("style"); style.textContent = ".audioTestVisualizer{position:fixed;bottom:0;left:0;width:100%;height:70px}"; document.head.append(style);
createRoot(document.getElementById("root")!).render(<Harness />);
