import { Check, ImagePlus, LoaderCircle, RotateCcw, Upload, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { defaultAppearance, PLAYLIST_COLORS, savePlaylistAppearance, type PlaylistAppearance } from "../lib/playlistAppearance";
import type { LibraryFolderEntry } from "../types";
import { DialogShell, validateDisplayName } from "./OverlayDialogs";
import { PlaylistArtwork, PlaylistBanner, playlistStyle } from "./PlaylistArtwork";

export function PlaylistEditor({ folder, appearance, fallback, onClose, onSaved }: {
  folder: LibraryFolderEntry; appearance: PlaylistAppearance; fallback?: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState({ ...appearance });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidName = validateDisplayName(draft.name);

  async function chooseImage(field: "coverPath" | "bannerPath") {
    setBusy(true); setError(null);
    try {
      const path = await api.importPlaylistImage();
      if (path) setDraft((current) => ({ ...current, [field]: path }));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || invalidName) return;
    setBusy(true); setError(null);
    try {
      await savePlaylistAppearance(folder, { ...draft, name: draft.name.trim(), description: draft.description.trim() });
      onSaved(); onClose();
    } catch (reason) { setError(`Could not save this playlist: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  return <DialogShell title="Make it yours" description="A name, a color, a little personality. Your playlist, your way."
    labelledBy={id} onClose={() => !busy && onClose()}>
    <form className="playlistEditorForm" onSubmit={(event) => void submit(event)}>
      <div className="playlistEditorPreview" style={playlistStyle(draft)}>
        <PlaylistBanner appearance={draft} />
        <PlaylistArtwork appearance={draft} fallback={fallback} />
        <div><span>PLAYLIST</span><strong>{draft.name || "Your playlist"}</strong><p>{draft.description || "The soundtrack to your next chapter."}</p></div>
      </div>
      <div className="playlistImageActions">
        <button type="button" className="secondaryAction" onClick={() => void chooseImage("coverPath")} disabled={busy}><Upload size={15} /> Change cover</button>
        {draft.coverPath && <button type="button" className="iconButton" aria-label="Remove custom cover" onClick={() => setDraft({ ...draft, coverPath: null })} disabled={busy}><X size={15} /></button>}
        <button type="button" className="secondaryAction" onClick={() => void chooseImage("bannerPath")} disabled={busy}><ImagePlus size={15} /> {draft.bannerPath ? "Change banner" : "Add banner"}</button>
        {draft.bannerPath && <button type="button" className="iconButton" aria-label="Remove banner" onClick={() => setDraft({ ...draft, bannerPath: null })} disabled={busy}><X size={15} /></button>}
        <small>PNG, JPG or WebP · up to 12 MB</small>
      </div>
      {draft.bannerPath && <label className="playlistPositionControl">Banner position<input type="range" min="0" max="100" value={draft.bannerPosition} onChange={(event) => setDraft({ ...draft, bannerPosition: Number(event.target.value) })} disabled={busy} /></label>}
      <div className="playlistEditorFields">
        <label><span>Playlist name</span><input autoFocus value={draft.name} maxLength={120} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} disabled={busy} aria-invalid={!!invalidName} /></label>
        <label><span>Description <small>Optional</small></span><textarea value={draft.description} maxLength={500} rows={2} placeholder="Set the mood. Tell its story." onChange={(event) => setDraft({ ...draft, description: event.target.value })} disabled={busy} /></label>
      </div>
      <fieldset className="playlistColorPicker" disabled={busy}><legend>Signature color</legend><div>
        {PLAYLIST_COLORS.map((color) => <button key={color} type="button" style={{ background: color }} aria-label={`Use ${color} for playlist color`} aria-pressed={draft.color === color} onClick={() => setDraft({ ...draft, color })}>{draft.color === color && <Check size={16} />}</button>)}
        <label className="customColor"><input type="color" aria-label="Custom playlist color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><span>Custom</span></label>
      </div></fieldset>
      {error && <p className="fieldError" role="alert">{error}</p>}
      {invalidName && <p className="fieldError">{invalidName}</p>}
      <footer className="dialogActions">
        <button type="button" className="playlistReset" onClick={() => setDraft(defaultAppearance(folder))} disabled={busy}><RotateCcw size={14} /> Reset look</button>
        <button type="button" className="secondaryAction" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primaryAction" disabled={busy || !!invalidName}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Save changes</button>
      </footer>
    </form>
  </DialogShell>;
}
