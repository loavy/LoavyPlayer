import { useId } from "react";
import { AudioLines, RotateCcw, SlidersHorizontal } from "lucide-react";
import { audioPreferences, EQ_FREQUENCIES, EQ_PRESETS, useAudioPreferences } from "../lib/audioPreferences";
import { Switch } from "./Switch";
import { DialogShell } from "./OverlayDialogs";

export function AudioSettingsPanel() {
  const settings = useAudioPreferences();
  return <section className="soundPanel" aria-label="Sound settings">
    <div className="soundSectionHeader"><div><SlidersHorizontal size={17} /><h3>Equalizer</h3></div><Switch label="Enable equalizer" checked={settings.eqEnabled} onChange={(eqEnabled) => audioPreferences.update({ eqEnabled })} /></div>
    <div className="eqPresetRow"><label>Preset<select aria-label="Equalizer preset" value={settings.preset} onChange={(event) => audioPreferences.preset(event.target.value)}>{!EQ_PRESETS[settings.preset] && <option value="Custom">Custom</option>}{Object.keys(EQ_PRESETS).map((name) => <option key={name}>{name}</option>)}</select></label><button className="secondaryAction" onClick={() => audioPreferences.update({ preset: "Flat", bands: [...EQ_PRESETS.Flat] })}><RotateCcw size={13} /> Reset</button></div>
    <div className={settings.eqEnabled ? "eqBands" : "eqBands bypassed"}>
      {EQ_FREQUENCIES.map((frequency, index) => <label className="eqBand" key={frequency}><output>{settings.bands[index] > 0 ? "+" : ""}{settings.bands[index].toFixed(1)}</output><input type="range" aria-label={`${frequency} Hz gain`} aria-valuetext={`${settings.bands[index]} decibels`} min={-12} max={12} step={.5} value={settings.bands[index]} onChange={(event) => audioPreferences.band(index, Number(event.target.value))} /><span>{frequency >= 1000 ? `${frequency / 1000}k` : frequency}</span></label>)}
    </div>
    <p className="soundHint">Ten bands · ±12 dB · automatic headroom for boosted presets</p>
    <div className="soundSectionHeader"><div><AudioLines size={17} /><h3>Playback & movement</h3></div></div>
    <label className="soundToggle"><span><strong>Gapless playback</strong><small>Join prepared local tracks without a pause.</small></span><Switch label="Gapless playback" checked={settings.gapless} onChange={(gapless) => audioPreferences.update({ gapless })} /></label>
    <label className="crossfadeControl"><span><strong>Crossfade</strong><output>{settings.crossfade ? `${settings.crossfade} seconds` : "Off"}</output></span><input aria-label="Crossfade duration" type="range" min={0} max={12} step={.5} value={settings.crossfade} onChange={(event) => audioPreferences.update({ crossfade: Number(event.target.value) })} /><small>Overlap the end and beginning of songs. Set to zero for gapless joins.</small></label>
    <label className="soundToggle"><span><strong>Subtle visualizer</strong><small>Follow the music in the player. Respects reduced motion.</small></span><Switch label="Music visualizer" checked={settings.visualizer} onChange={(visualizer) => audioPreferences.update({ visualizer })} /></label>
    <p className="soundHint">Transitions are suspended in Jams to preserve synchronization. Very large or unsupported files use standard playback. EQ and visualization apply to local music.</p>
  </section>;
}

export function AudioSettingsDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  return <DialogShell title="Make it sound like you" description="Equalizer, smooth transitions, and a little movement." labelledBy={id} onClose={onClose}><AudioSettingsPanel /></DialogShell>;
}
