import { ListMusic, Quote, X } from "lucide-react";
import { useAudioSelector } from "../lib/useAudio";
import { LyricsPanel } from "./LyricsPanel";
import { QueuePanel } from "./QueuePanel";
import { SegmentedTabs } from "./SegmentedTabs";
import { useId } from "react";

export type InspectorMode = "queue" | "lyrics" | "closed";

export function ListeningPanel({ mode, onModeChange }: { mode: Exclude<InspectorMode, "closed">; onModeChange: (mode: InspectorMode) => void }) {
  const current = useAudioSelector((state) => state.current);
  const upcoming = useAudioSelector((state) => state.upNext.length);
  const id = useId();
  return <aside className="sideInspector" aria-label="Listening panel">
    <header className="inspectorHeader">
      <SegmentedTabs id={id} label="Listening panel view" value={mode} onChange={onModeChange} panelId={`${id}-panel`} options={[{ value: "queue", label: "Queue", icon: <ListMusic size={15} />, badge: upcoming }, { value: "lyrics", label: "Lyrics", icon: <Quote size={14} /> }]} />
      <button className="iconButton" aria-label="Close listening panel" onClick={() => onModeChange("closed")}><X size={16} /></button>
    </header>
    <div className="inspectorTabPanel" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${mode}`}>{mode === "queue" ? <QueuePanel embedded onClose={() => onModeChange("closed")} /> : current ? <LyricsPanel track={current} /> : <div className="inspectorEmpty"><Quote size={30} strokeWidth={1} /><strong>Lyrics live here</strong><p>Play a song to follow along.</p></div>}</div>
  </aside>;
}
