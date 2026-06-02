import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Search, SidebarIcon } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar } from "./components/PlayerBar";
import { AlbumsView } from "./views/AlbumsView";
import { ArtistsView } from "./views/ArtistsView";
import { SettingsView } from "./views/SettingsView";
import { SongsView } from "./views/SongsView";
import { RoomView } from "./views/RoomView";
import { api } from "./lib/api";
import { useAudio } from "./lib/useAudio";
import { displayAlbum, displayArtist, displayTrackTitle } from "./lib/format";
import type { Album, Artist, FetcherDescriptor, MusicFolder, ScanProgress, ScanSummary, Track, ViewKey } from "./types";

function App() {
  const [activeView, setActiveView] = useState<ViewKey>("songs");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [folders, setFolders] = useState<MusicFolder[]>([]);
  const [fetchers, setFetchers] = useState<FetcherDescriptor[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [theme, setTheme] = useState(localStorage.getItem("loavy.theme") || "dark");
  const [accent, setAccent] = useState(localStorage.getItem("loavy.accent") || "#48c6a8");
  const [offlineMode, setOfflineMode] = useState(localStorage.getItem("loavy.offlineMode") === "true");
  const [compactSidebar, setCompactSidebar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useAudio();
  const audioRef = useRef(audio);
  const searchRequestRef = useRef(0);
  const deferredQuery = useDeferredValue(query);
  audioRef.current = audio;

  async function refreshTracks(search = deferredQuery) {
    const requestId = ++searchRequestRef.current;
    const nextTracks = await api.listTracks(search);
    if (requestId === searchRequestRef.current) {
      setTracks(nextTracks);
    }
  }

  async function refreshLibrary(search = deferredQuery) {
    const [nextTracks, nextAlbums, nextArtists, nextFolders, nextFetchers] = await Promise.all([
      api.listTracks(search),
      api.listAlbums(),
      api.listArtists(),
      api.listMusicFolders(),
      api.listFetchers()
    ]);
    setTracks(nextTracks);
    setAlbums(nextAlbums);
    setArtists(nextArtists);
    setFolders(nextFolders);
    setFetchers(nextFetchers);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty("--accent", accent);
    localStorage.setItem("loavy.theme", theme);
    localStorage.setItem("loavy.accent", accent);
  }, [theme, accent]);

  useEffect(() => {
    setLoading(true);
    Promise.all([refreshLibrary(""), api.getScanState()])
      .then(([, scanState]) => setScanning(scanState.running))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const snapshot = audioRef.current;
      if (!snapshot.current) return;
      try {
        const status = await api.getRoomStatus();
        if (!status.running) return;
        await api.broadcastRoomPlaybackState({
          trackId: snapshot.current.id,
          title: displayTrackTitle(snapshot.current),
          artist: displayArtist(snapshot.current.artist),
          album: displayAlbum(snapshot.current.album),
          coverPath: snapshot.current.coverPath,
          durationMs: snapshot.duration || snapshot.current.durationMs || null,
          positionMs: Math.round(snapshot.position),
          playing: snapshot.playing,
          hostTimestampMs: Date.now()
        });
      } catch {
        // Room sync is best-effort; the Room panel shows explicit server errors.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    const unsubs = Promise.all([
      listen<ScanProgress>("library://scan-progress", (event) => {
        if (!disposed) {
          setScanProgress(event.payload);
          setScanning(event.payload.running);
        }
      }),
      listen<ScanProgress>("library://scan-finished", (event) => {
        if (!disposed) {
          setScanProgress(event.payload);
          setScanning(false);
          setScanSummary({
            foldersScanned: event.payload.foldersScanned,
            filesSeen: event.payload.filesSeen,
            tracksAddedOrUpdated: event.payload.tracksAddedOrUpdated,
            tracksRemoved: event.payload.tracksRemoved,
            errors: event.payload.errors
          });
          refreshLibrary().catch((err) => setError(String(err)));
        }
      }),
      listen<string>("library://scan-error", (event) => {
        if (!disposed) {
          setScanning(false);
          setError(event.payload);
        }
      })
    ]);
    return () => {
      disposed = true;
      unsubs.then((callbacks) => callbacks.forEach((unlisten) => unlisten())).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refreshTracks(deferredQuery).catch((err) => setError(String(err)));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [deferredQuery]);

  const filteredTracks = useMemo(() => {
    if (activeView === "favorites") return tracks.filter((track) => track.favorite);
    if (activeView === "recent") return [...tracks].sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    return tracks;
  }, [activeView, tracks]);

  async function addFolder() {
    setError(null);
    await api.selectMusicFolder();
    await refreshLibrary();
  }

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      await api.startLibraryScan();
    } catch (err) {
      setError(String(err));
      setScanning(false);
    }
  }

  async function cancelScan() {
    try {
      await api.cancelLibraryScan();
      setScanProgress((progress) => progress ? { ...progress, cancelled: true } : progress);
    } catch (err) {
      setError(String(err));
    } finally {
    }
  }

  async function changeTheme(nextTheme: string) {
    setTheme(nextTheme);
    await api.setSetting("theme", nextTheme);
  }

  async function changeAccent(nextAccent: string) {
    setAccent(nextAccent);
    await api.setSetting("accent", nextAccent);
  }

  async function changeOfflineMode(enabled: boolean) {
    setOfflineMode(enabled);
    localStorage.setItem("loavy.offlineMode", String(enabled));
    await api.setSetting("offlineMode", String(enabled));
  }

  const title = {
    songs: "Songs",
    albums: "Albums",
    artists: "Artists",
    genres: "Genres",
    playlists: "Playlists",
    recent: "Recently Played",
    favorites: "Favorites",
    search: "Search",
    room: "Room",
    settings: "Settings"
  }[activeView];

  function renderView() {
    if (loading) return <section className="emptyState"><h2>Loading library</h2><p>Preparing the local database.</p></section>;
    if (activeView === "albums") return <AlbumsView albums={albums} />;
    if (activeView === "artists") return <ArtistsView artists={artists} />;
    if (activeView === "settings") {
      return (
        <SettingsView
          folders={folders}
          fetchers={fetchers}
          scanning={scanning}
          scanSummary={scanSummary}
          scanProgress={scanProgress}
          theme={theme}
          accent={accent}
          offlineMode={offlineMode}
          onAddFolder={addFolder}
          onScan={scan}
          onCancelScan={cancelScan}
          onThemeChange={changeTheme}
          onAccentChange={changeAccent}
          onOfflineModeChange={changeOfflineMode}
          onApiKeyChange={(provider, key) => void api.setApiKey(provider, key)}
        />
      );
    }
    if (activeView === "room") return <RoomView onError={setError} />;
    if (["genres", "playlists"].includes(activeView)) {
      return <section className="emptyState"><h2>{title}</h2><p>This view is reserved in the MVP structure and ready for the next feature pass.</p></section>;
    }
    return <SongsView tracks={filteredTracks} />;
  }

  return (
    <div className="appShell">
      <Sidebar active={activeView} onSelect={setActiveView} compact={compactSidebar} />
      <main className="mainPane">
        <header className="topBar">
          <div className="titleGroup">
            <button className="iconButton" onClick={() => setCompactSidebar(!compactSidebar)} title="Toggle sidebar">
              <SidebarIcon size={18} />
            </button>
            <div>
              <h1>{title}</h1>
              <p>{tracks.length} songs - {albums.length} albums - {artists.length} artists</p>
            </div>
          </div>
          <label className="searchBox">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search songs, artists, albums, genres" />
          </label>
        </header>
        {error && <pre className="errorBanner">{error}</pre>}
        <div className="contentArea">{renderView()}</div>
      </main>
      <PlayerBar />
    </div>
  );
}

export default App;
