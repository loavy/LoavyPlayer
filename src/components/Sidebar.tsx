import {
  Album,
  Heart,
  History,
  ListMusic,
  Mic2,
  Music2,
  Search,
  Settings,
  Radio,
  Tags,
  Users,
  type LucideIcon
} from "lucide-react";
import type { ViewKey } from "../types";

const items: Array<{ key: ViewKey; label: string; icon: LucideIcon }> = [
  { key: "songs", label: "Songs", icon: Music2 },
  { key: "albums", label: "Albums", icon: Album },
  { key: "artists", label: "Artists", icon: Users },
  { key: "genres", label: "Genres", icon: Tags },
  { key: "playlists", label: "Playlists", icon: ListMusic },
  { key: "recent", label: "Recently Played", icon: History },
  { key: "favorites", label: "Favorites", icon: Heart },
  { key: "search", label: "Search", icon: Search },
  { key: "room", label: "Room", icon: Radio },
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
        <div className="brandMark"><Mic2 size={19} /></div>
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
