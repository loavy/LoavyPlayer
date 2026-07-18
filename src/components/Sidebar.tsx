import {
  Album,
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
import loavyIcon from "../assets/loavy-icon.png";

const items: Array<{ key: ViewKey; label: string; icon: LucideIcon }> = [
  { key: "songs", label: "Songs", icon: Music2 },
  { key: "albums", label: "Albums", icon: Album },
  { key: "artists", label: "Artists", icon: Users },
  { key: "playlists", label: "Folders", icon: FolderTree },
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
        <div className="brandMark"><img src={loavyIcon} alt="" /></div>
        {!compact && <span>Loavy Player</span>}
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
