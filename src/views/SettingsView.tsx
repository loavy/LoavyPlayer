import { FolderPlus, KeyRound, Paintbrush, RefreshCw, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
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
  backgroundMode: boolean;
  fontScale: string;
  showCovers: boolean;
  reduceMotion: boolean;
  cornerStyle: string;
  backgroundStyle: string;
  highContrast: boolean;
  showTrackFormat: boolean;
  onAddFolder: () => void;
  onRemoveFolder: (folderId: number) => void;
  onScan: () => void;
  onCancelScan: () => void;
  onThemeChange: (theme: string) => void;
  onAccentChange: (accent: string) => void;
  onDensityChange: (density: string) => void;
  onCardStyleChange: (cardStyle: string) => void;
  onPlayerStyleChange: (playerStyle: string) => void;
  onFontScaleChange: (fontScale: string) => void;
  onShowCoversChange: (enabled: boolean) => void;
  onReduceMotionChange: (enabled: boolean) => void;
  onCornerStyleChange: (style: string) => void;
  onBackgroundStyleChange: (style: string) => void;
  onHighContrastChange: (enabled: boolean) => void;
  onShowTrackFormatChange: (enabled: boolean) => void;
  onOfflineModeChange: (enabled: boolean) => void;
  onBackgroundModeChange: (enabled: boolean) => void;
  onApiKeyChange: (provider: string, key: string) => void;
};

export function SettingsView(props: Props) {
  const folderCountLabel = props.folders.length === 1 ? "1 folder" : `${props.folders.length} folders`;
  const lastScanLabel = props.folders.some((folder) => folder.lastScannedAt)
    ? "Recent scan available"
    : "No scan activity yet";

  return (
    <section className="settingsStack">
      <div className="settingsHero">
        <div>
          <span className="eyebrow">Configuration</span>
          <h2>Fine-tune your library and listening space.</h2>
          <p>Control where Loavy looks for music, how the interface feels, and which metadata providers stay ready.</p>
        </div>
        <div className="settingsHeroChips">
          <span className="chip"><Sparkles size={15} /> {folderCountLabel}</span>
          <span className="chip"><ShieldCheck size={15} /> {props.offlineMode ? "Offline ready" : "Online ready"}</span>
        </div>
      </div>

      <div className="settingsPanel">
        <header><FolderPlus size={19} /><h2>Music folders</h2></header>
        <div className="settingsPanelIntro">
          <p>Pick the folders that Loavy should watch and keep in sync.</p>
          <div className="settingsMeta">
            <span>{folderCountLabel}</span>
            <span>{lastScanLabel}</span>
          </div>
        </div>
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
              <div>
                <strong>{folder.path}</strong>
                <span>{folder.lastScannedAt ? `Last scanned ${new Date(folder.lastScannedAt).toLocaleString()}` : "Not scanned yet"}</span>
              </div>
              <button className="secondaryAction dangerAction" onClick={() => props.onRemoveFolder(folder.id)} title="Remove folder">
                <Trash2 size={16} /> Remove
              </button>
            </div>
          ))}
          {!props.folders.length && <p className="muted">No folders selected yet.</p>}
        </div>
        {props.scanSummary && (
          <p className="scanSummary">
            Saw {props.scanSummary.filesSeen} files, updated {props.scanSummary.tracksAddedOrUpdated}, removed {props.scanSummary.tracksRemoved}.
          </p>
        )}
        {props.scanProgress && (
          <div className="scanProgress">
            <div>
              <span style={{ width: `${scanPercent(props.scanProgress)}%` }} />
            </div>
            <p>
              {props.scanProgress.running ? "Scanning" : "Scan finished"} - {props.scanProgress.filesSeen}{props.scanProgress.totalFiles ? ` / ${props.scanProgress.totalFiles}` : ""} files - {props.scanProgress.tracksAddedOrUpdated} updated
            </p>
            {props.scanProgress.currentPath && <small>{props.scanProgress.currentPath}</small>}
          </div>
        )}
      </div>

      <div className="settingsPanel">
        <header><Paintbrush size={19} /><h2>Appearance</h2></header>
        <div className="settingsPanelIntro">
          <p>Shape the look and behavior of lists, cards, and the player shell.</p>
        </div>

        <div className="settingsGroup">
          <div className="settingsGroupHeader">Look & feel</div>
          <div className="settingsGrid">
            <label className="field">
              <div className="fieldMeta">
                <span>Mode</span>
                <small>{props.theme === "dark" ? "Cinematic" : "Bright"}</small>
              </div>
              <select value={props.theme} onChange={(event) => props.onThemeChange(event.target.value)}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label className="field">
              <div className="fieldMeta">
                <span>Accent</span>
                <small>Brand color</small>
              </div>
              <input type="color" value={props.accent} onChange={(event) => props.onAccentChange(event.target.value)} />
            </label>
            <label className="field">
              <div className="fieldMeta">
                <span>Density</span>
                <small>{props.density}</small>
              </div>
              <select value={props.density} onChange={(event) => props.onDensityChange(event.target.value)}>
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
                <option value="spacious">Spacious</option>
              </select>
            </label>
            <label className="field">
              <div className="fieldMeta">
                <span>Cards</span>
                <small>{props.cardStyle}</small>
              </div>
              <select value={props.cardStyle} onChange={(event) => props.onCardStyleChange(event.target.value)}>
                <option value="soft">Soft</option>
                <option value="flat">Flat</option>
                <option value="glass">Glass</option>
              </select>
            </label>
            <label className="field">
              <div className="fieldMeta">
                <span>Corners</span>
                <small>{props.cornerStyle}</small>
              </div>
              <select value={props.cornerStyle} onChange={(event) => props.onCornerStyleChange(event.target.value)}>
                <option value="rounded">Rounded</option>
                <option value="soft">Soft</option>
                <option value="square">Square</option>
              </select>
            </label>
            <label className="field">
              <div className="fieldMeta">
                <span>Background</span>
                <small>{props.backgroundStyle}</small>
              </div>
              <select value={props.backgroundStyle} onChange={(event) => props.onBackgroundStyleChange(event.target.value)}>
                <option value="ambient">Ambient glow</option>
                <option value="subtle">Subtle glow</option>
                <option value="solid">Solid</option>
              </select>
            </label>
            <label className="field">
              <div className="fieldMeta">
                <span>Player</span>
                <small>{props.playerStyle}</small>
              </div>
              <select value={props.playerStyle} onChange={(event) => props.onPlayerStyleChange(event.target.value)}>
                <option value="docked">Docked</option>
                <option value="floating">Floating</option>
                <option value="compact">Compact</option>
              </select>
            </label>
            <label className="field">
              <div className="fieldMeta">
                <span>Font size</span>
                <small>{props.fontScale}%</small>
              </div>
              <input type="range" min={90} max={115} step={5} value={props.fontScale} onChange={(event) => props.onFontScaleChange(event.target.value)} />
            </label>
          </div>
        </div>

        <div className="settingsGroup">
          <div className="settingsGroupHeader">Behavior</div>
          <div className="settingsGrid">
            <label className="toggleRow toggleCard">
              <span>
                <strong>Show covers</strong>
                <small>Use artwork in list views</small>
              </span>
              <input type="checkbox" checked={props.showCovers} onChange={(event) => props.onShowCoversChange(event.target.checked)} />
            </label>
            <label className="toggleRow toggleCard">
              <span>
                <strong>Show file format</strong>
                <small>Display extensions alongside titles</small>
              </span>
              <input type="checkbox" checked={props.showTrackFormat} onChange={(event) => props.onShowTrackFormatChange(event.target.checked)} />
            </label>
            <label className="toggleRow toggleCard">
              <span>
                <strong>High contrast</strong>
                <small>Improve readability on busy surfaces</small>
              </span>
              <input type="checkbox" checked={props.highContrast} onChange={(event) => props.onHighContrastChange(event.target.checked)} />
            </label>
            <label className="toggleRow toggleCard">
              <span>
                <strong>Reduce motion</strong>
                <small>Keep animations calmer and lighter</small>
              </span>
              <input type="checkbox" checked={props.reduceMotion} onChange={(event) => props.onReduceMotionChange(event.target.checked)} />
            </label>
            <label className="toggleRow toggleCard">
              <span>
                <strong>Offline mode</strong>
                <small>Prefer local data and skip remote lookups</small>
              </span>
              <input type="checkbox" checked={props.offlineMode} onChange={(event) => props.onOfflineModeChange(event.target.checked)} />
            </label>
            <label className="toggleRow toggleCard">
              <span>
                <strong>Keep running in background</strong>
                <small>Close to the system tray instead of quitting</small>
              </span>
              <input type="checkbox" checked={props.backgroundMode} onChange={(event) => props.onBackgroundModeChange(event.target.checked)} />
            </label>
          </div>
        </div>
      </div>

      <div className="settingsPanel">
        <header><KeyRound size={19} /><h2>Fetcher providers</h2></header>
        <div className="settingsPanelIntro">
          <p>These providers enrich artist and album details. Your keys stay on this device.</p>
        </div>
        <div className="fetcherList">
          {props.fetchers.map((fetcher) => (
            <div className="fetcherRow" key={fetcher.id}>
              <div className="fetcherInfo">
                <div className="fetcherHeading">
                  <strong>{fetcher.name}</strong>
                  <span className={`providerBadge ${fetcher.requiresApiKey ? "needsKey" : "ready"}`}>
                    {fetcher.requiresApiKey ? "Needs key" : "Ready"}
                  </span>
                </div>
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

function scanPercent(progress: ScanProgress) {
  if (!progress.running && !progress.cancelled) return 100;
  if (!progress.totalFiles) return progress.running ? 8 : 100;
  return Math.min(100, Math.max(4, Math.round((progress.filesSeen / progress.totalFiles) * 100)));
}
