import {
  Album,
  AudioLines,
  BarChart3,
  Download,
  Heart,
  Headphones,
  History,
  Library,
  Home,
  Search,
  ChevronDown,
  ChevronRight,
  Pin,
  FolderTree,
  ListMusic,
  Music2,
  Settings,
  Radio,
  Users,
  type LucideIcon
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Album as LibraryAlbum, ViewKey } from "../types";
import { Cover } from "./Cover";
import { displayArtist } from "../lib/format";

const items: Array<{ key: ViewKey; label: string; icon: LucideIcon; group: string }> = [
  { key: "songs", label: "Songs", icon: Music2, group: "Your library" },
  { key: "albums", label: "Albums", icon: Album, group: "Your library" },
  { key: "artists", label: "Artists", icon: Users, group: "Your library" },
  { key: "playlists", label: "Playlists", icon: ListMusic, group: "Your library" },
  { key: "favorites", label: "Favorites", icon: Heart, group: "Your library" },
  { key: "recent", label: "Recently Played", icon: History, group: "Your library" },
  { key: "stats", label: "Listening stats", icon: BarChart3, group: "Your library" },
  { key: "spotify", label: "Spotify", icon: Headphones, group: "Streaming" },
  { key: "folders", label: "Folders", icon: FolderTree, group: "On this device" },
  { key: "folderQueue", label: "Folder Queue", icon: ListMusic, group: "On this device" },
  { key: "downloader", label: "Downloader", icon: Download, group: "Shortcuts" },
  { key: "room", label: "Room", icon: Radio, group: "Listen together" }
];

type Props = {
  active: ViewKey;
  onSelect: (view: ViewKey) => void;
  compact: boolean;
  albums?: LibraryAlbum[];
  pinnedAlbums?: string[];
  currentAlbum?: string | null;
  onOpenAlbum?: (album: string) => void;
  onSearch?: () => void;
  counts?: Partial<Record<ViewKey, number>>;
};

export function Sidebar({ active, onSelect, compact, albums = [], pinnedAlbums = [], currentAlbum, onOpenAlbum, onSearch, counts = {} }: Props) {
  const [libraryExpanded, setLibraryExpanded] = useState(() => { try { return localStorage.getItem("loavy.libraryExpanded") !== "false"; } catch { return true; } });
  const [localExpanded, setLocalExpanded] = useState(() => { try { return localStorage.getItem("loavy.localExpanded") === "true"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("loavy.libraryExpanded", String(libraryExpanded)); localStorage.setItem("loavy.localExpanded", String(localExpanded)); } catch {} }, [libraryExpanded, localExpanded]);
  useEffect(() => { if (items.some(item => item.key === active && item.group === "Your library" && item.key !== "recent")) setLibraryExpanded(true); if (items.some(item => item.key === active && item.group === "On this device")) setLocalExpanded(true); }, [active]);
  const shortcuts = [...albums.filter((album) => pinnedAlbums.includes(album.title)), ...albums.filter((album) => !pinnedAlbums.includes(album.title))].slice(0, 6);

  function navItem(item: typeof items[number]) {
    const Icon = item.icon;
    return <button key={item.key} className={active === item.key && !currentAlbum ? "navItem active" : "navItem"} onClick={() => onSelect(item.key)} title={item.label} aria-label={item.label} aria-current={active === item.key && !currentAlbum ? "page" : undefined}><Icon size={18} />{!compact && <><span>{item.label}</span>{counts[item.key] !== undefined && <small className="navCount" aria-hidden="true">{counts[item.key]!.toLocaleString()}</small>}{item.key === "room" && <small className="navJamHint" aria-hidden="true">JAM</small>}</>}</button>;
  }
  return (
    <aside className={compact ? "sidebar compact" : "sidebar"}>
      <div className="brand">
        <div className="brandMark"><AudioLines size={24} /></div>
        {!compact && <span>loavy<span className="brandDot">.</span></span>}
      </div>
      <nav aria-label="Main navigation">
        <button className={active === "home" ? "navItem active" : "navItem"} onClick={() => onSelect("home")} aria-label="Home" title="Home" aria-current={active === "home" ? "page" : undefined}><Home size={18} />{!compact && <span>Home</span>}</button>
        <button className="navItem sidebarSearch" onClick={onSearch || (() => onSelect("songs"))} aria-label="Search" title="Search"><Search size={18} />{!compact && <span>Search</span>}</button>
        <div className="navGroup libraryTree">
          <button className="navItem navTreeToggle" onClick={() => setLibraryExpanded(!libraryExpanded)} aria-expanded={libraryExpanded} aria-label="Your library"><Library size={18} />{!compact && <><span>Your Library</span>{libraryExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</>}</button>
          <div className={libraryExpanded || compact ? "navTreeChildren" : "navTreeChildren collapsed"}>{items.filter((item) => item.group === "Your library" && item.key !== "recent").map(navItem)}</div>
        </div>
        <div className="navGroup localTree">
          <button className="navItem navTreeToggle" onClick={() => setLocalExpanded(!localExpanded)} aria-expanded={localExpanded} aria-label="Local music" title="Local music"><FolderTree size={18} />{!compact && <><span>Local Music</span>{localExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</>}</button>
          <div className={localExpanded || compact ? "navTreeChildren" : "navTreeChildren collapsed"}>{items.filter((item) => item.group === "On this device").map(navItem)}</div>
        </div>
        {["spotify", "recent", "downloader", "room"].map(key => navItem(items.find(item => item.key === key)!))}
        {!!shortcuts.length && onOpenAlbum && <section className="sidebarCollections" aria-label="Album shortcuts"><div className="navGroupLabel"><Pin size={12} /><span>Albums</span></div>{shortcuts.map((album) => <button className={currentAlbum === album.title ? "sidebarAlbum active" : "sidebarAlbum"} key={`${album.artist}:${album.title}`} onClick={() => onOpenAlbum(album.title)} aria-label={`Open ${album.title}`} title={`${album.title} · ${displayArtist(album.artist)}`}><Cover path={album.coverPath} title={album.title} size="sm" /><span><strong>{album.title}</strong><small>{pinnedAlbums.includes(album.title) ? "Pinned album" : displayArtist(album.artist)}</small></span>{pinnedAlbums.includes(album.title) && <Pin size={11} />}</button>)}</section>}
      </nav>
      <div className="sidebarFooter">
        <button className={active === "settings" ? "navItem active" : "navItem"} onClick={() => onSelect("settings")} title="Settings" aria-label="Settings" aria-current={active === "settings" ? "page" : undefined}>
          <Settings size={18} />{!compact && <span>Settings</span>}
        </button>
        {!compact && <div className="localLibraryNote"><span /> Music, right at home.</div>}
      </div>
    </aside>
  );
}
