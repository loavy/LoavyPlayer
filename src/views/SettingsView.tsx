import { FolderPlus, KeyRound, Paintbrush, RefreshCw } from "lucide-react";
import type { FetcherDescriptor, MusicFolder, ScanProgress, ScanSummary } from "../types";

type Props = {
  folders: MusicFolder[];
  fetchers: FetcherDescriptor[];
  scanning: boolean;
  scanSummary: ScanSummary | null;
  scanProgress: ScanProgress | null;
  theme: string;
  accent: string;
  density: string;
  cardStyle: string;
  playerStyle: string;
  offlineMode: boolean;
  onAddFolder: () => void;
  onScan: () => void;
  onCancelScan: () => void;
  onThemeChange: (theme: string) => void;
  onAccentChange: (accent: string) => void;
  onDensityChange: (density: string) => void;
  onCardStyleChange: (cardStyle: string) => void;
  onPlayerStyleChange: (playerStyle: string) => void;
  onOfflineModeChange: (enabled: boolean) => void;
  onApiKeyChange: (provider: string, key: string) => void;
};

export function SettingsView(props: Props) {
  return (
    <section className="settingsStack">
      <div className="settingsPanel">
        <header><FolderPlus size={19} /><h2>Music folders</h2></header>
        <div className="settingsActions">
          <button className="primaryAction" onClick={props.onAddFolder}><FolderPlus size={17} /> Add folder</button>
          <button className="secondaryAction" onClick={props.onScan} disabled={props.scanning}>
            <RefreshCw size={17} className={props.scanning ? "spin" : ""} /> {props.scanning ? "Scanning" : "Scan"}
          </button>
          {props.scanning && <button className="secondaryAction" onClick={props.onCancelScan}>Cancel</button>}
        </div>
        <div className="folderList">
          {props.folders.map((folder) => (
            <div className="folderRow" key={folder.id}>
              <strong>{folder.path}</strong>
              <span>{folder.lastScannedAt ? `Last scanned ${new Date(folder.lastScannedAt).toLocaleString()}` : "Not scanned yet"}</span>
            </div>
          ))}
          {!props.folders.length && <p className="muted">No folders selected.</p>}
        </div>
        {props.scanSummary && (
          <p className="scanSummary">
            Saw {props.scanSummary.filesSeen} files, updated {props.scanSummary.tracksAddedOrUpdated}, removed {props.scanSummary.tracksRemoved}.
          </p>
        )}
        {props.scanProgress && (
          <div className="scanProgress">
            <div>
              <span style={{ width: `${Math.min(100, (props.scanProgress.filesSeen % 100) + 1)}%` }} />
            </div>
            <p>
              {props.scanProgress.running ? "Scanning" : "Scan finished"} - {props.scanProgress.filesSeen} files - {props.scanProgress.tracksAddedOrUpdated} updated
            </p>
            {props.scanProgress.currentPath && <small>{props.scanProgress.currentPath}</small>}
          </div>
        )}
      </div>

      <div className="settingsPanel">
        <header><Paintbrush size={19} /><h2>Appearance</h2></header>
        <label className="field">
          <span>Mode</span>
          <select value={props.theme} onChange={(event) => props.onThemeChange(event.target.value)}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label className="field">
          <span>Accent</span>
          <input type="color" value={props.accent} onChange={(event) => props.onAccentChange(event.target.value)} />
        </label>
        <label className="field">
          <span>Density</span>
          <select value={props.density} onChange={(event) => props.onDensityChange(event.target.value)}>
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
            <option value="spacious">Spacious</option>
          </select>
        </label>
        <label className="field">
          <span>Cards</span>
          <select value={props.cardStyle} onChange={(event) => props.onCardStyleChange(event.target.value)}>
            <option value="soft">Soft</option>
            <option value="flat">Flat</option>
            <option value="glass">Glass</option>
          </select>
        </label>
        <label className="field">
          <span>Player</span>
          <select value={props.playerStyle} onChange={(event) => props.onPlayerStyleChange(event.target.value)}>
            <option value="docked">Docked</option>
            <option value="floating">Floating</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <label className="toggleRow">
          <span>Privacy / offline mode</span>
          <input type="checkbox" checked={props.offlineMode} onChange={(event) => props.onOfflineModeChange(event.target.checked)} />
        </label>
      </div>

      <div className="settingsPanel">
        <header><KeyRound size={19} /><h2>Fetcher providers</h2></header>
        <div className="fetcherList">
          {props.fetchers.map((fetcher) => (
            <div className="fetcherRow" key={fetcher.id}>
              <div>
                <strong>{fetcher.name}</strong>
                <span>{fetcher.capabilities.join(", ")}{fetcher.requiresApiKey ? " - API key required" : " - no key required"}</span>
              </div>
              {fetcher.requiresApiKey && (
                <input
                  type="password"
                  placeholder="API key"
                  onBlur={(event) => props.onApiKeyChange(fetcher.id, event.target.value)}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
