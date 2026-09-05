import {
  Album,
  AudioLines,
  Download,
  Heart,
  History,
  FolderTree,
  ListMusic,
  Music2,
  Settings,
  Radio,
  Users,
  type LucideIcon
} from "lucide-react";
import type { ViewKey } from "../types";

const items: Array<{ key: ViewKey; label: string; icon: LucideIcon }> = [
  { key: "songs", label: "Songs", icon: Music2 },
  { key: "albums", label: "Albums", icon: Album },
  { key: "artists", label: "Artists", icon: Users },
  { key: "playlists", label: "Playlists", icon: ListMusic },
  { key: "folders", label: "Folders", icon: FolderTree },
  { key: "folderQueue", label: "Folder Queue", icon: ListMusic },
  { key: "recent", label: "Recently Played", icon: History },
  { key: "favorites", label: "Favorites", icon: Heart },
  { key: "room", label: "Room", icon: Radio },
  { key: "downloader", label: "Downloader", icon: Download },
  { key: "settings", label: "Settings", icon: Settings }
];

type Props = {
  active: ViewKey;
  onSelect: (view: ViewKey) => void;
  compact: boolean;
};

export function Sidebar({ active, onSelect, compact }: Props) {
  return (
    <aside className={compact ? "sidebar compact" : "sidebar"}>
      <div className="brand">
        <div className="brandMark"><AudioLines size={24} /></div>
        {!compact && <span>loavy<span className="brandDot">.</span></span>}
      </div>
      <nav>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              className={active === item.key ? "navItem active" : "navItem"}
              onClick={() => onSelect(item.key)}
              title={item.label}
              aria-label={item.label}
              aria-current={active === item.key ? "page" : undefined}
            >
              <Icon size={18} />
              {!compact && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
