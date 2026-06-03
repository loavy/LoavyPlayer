import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Search, SidebarIcon, X } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar } from "./components/PlayerBar";
import { AlbumsView } from "./views/AlbumsView";
import { ArtistsView } from "./views/ArtistsView";
import { SettingsView } from "./views/SettingsView";
import { SongsView } from "./views/SongsView";
import { RoomView } from "./views/RoomView";
import { PlaylistsView } from "./views/PlaylistsView";
import { api } from "./lib/api";
import { useAudio } from "./lib/useAudio";
import { displayAlbum, displayArtist, displayTrackTitle } from "./lib/format";
import type {
  Album,
  Artist,
  FetcherDescriptor,
  MusicFolder,
  Playlist,
  RoomPlaybackState,
  ScanProgress,
  ScanSummary,
  Track,
  ViewKey
} from "./types";
import { audioEngine } from "./lib/audioEngine";

function streamTrackFromPlayback(playback: RoomPlaybackState, streamUrl: string): Track {
  const title = playback.title || "Host stream";
  return {
    id: -Math.abs(playback.trackId || Date.now()),
    path: streamUrl,
    fileName: title,
    fileExt: "stream",
    fileSize: 0,
    modifiedAt: playback.hostTimestampMs,
    title,
    artist: playback.artist || null,
    album: playback.album || null,
    albumArtist: playback.artist || null,
    genre: null,
    year: null,
    trackNumber: null,
    durationMs: playback.durationMs || null,
    coverPath: playback.coverPath || null,
    favorite: false,
    dateAdded: playback.hostTimestampMs,
    lastPlayedAt: null,
    playCount: 0
  };
}

function App() {
  const [activeView, setActiveView] = useState<ViewKey>("songs");
  const [collectionFilter, setCollectionFilter] = useState<{ type: "album" | "artist"; value: string } | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [folders, setFolders] = useState<MusicFolder[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [fetchers, setFetchers] = useState<FetcherDescriptor[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [theme, setTheme] = useState(localStorage.getItem("loavy.theme") || "dark");
  const [accent, setAccent] = useState(localStorage.getItem("loavy.accent") || "#48c6a8");
  const [density, setDensity] = useState(localStorage.getItem("loavy.density") || "comfortable");
  const [cardStyle, setCardStyle] = useState(localStorage.getItem("loavy.cardStyle") || "soft");
  const [playerStyle, setPlayerStyle] = useState(localStorage.getItem("loavy.playerStyle") || "docked");
  const [fontScale, setFontScale] = useState(localStorage.getItem("loavy.fontScale") || "100");
  const [showCovers, setShowCovers] = useState(localStorage.getItem("loavy.showCovers") !== "false");
  const [reduceMotion, setReduceMotion] = useState(localStorage.getItem("loavy.reduceMotion") === "true");
  const [offlineMode, setOfflineMode] = useState(localStorage.getItem("loavy.offlineMode") === "true");
  const [compactSidebar, setCompactSidebar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useAudio();
  const audioRef = useRef(audio);
  const searchRequestRef = useRef(0);
  const roomClientStatusRef = useRef<{ connected: boolean; allowGuestControl: boolean; host?: string | null; port?: number | null }>({
    connected: false,
    allowGuestControl: false,
    host: null,
    port: null
  });
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
    const [nextTracks, nextAlbums, nextArtists, nextFolders, nextFetchers, nextPlaylists] = await Promise.all([
      api.listTracks(search),
      api.listAlbums(),
      api.listArtists(),
      api.listMusicFolders(),
      api.listFetchers(),
      api.listPlaylists()
    ]);
    setTracks(nextTracks);
    setAlbums(nextAlbums);
    setArtists(nextArtists);
    setFolders(nextFolders);
    setFetchers(nextFetchers);
    setPlaylists(nextPlaylists);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
    document.documentElement.dataset.cards = cardStyle;
    document.documentElement.dataset.player = playerStyle;
    document.documentElement.dataset.covers = showCovers ? "show" : "hide";
    document.documentElement.dataset.motion = reduceMotion ? "reduced" : "full";
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--font-scale", `${Number(fontScale) / 100}`);
    localStorage.setItem("loavy.theme", theme);
    localStorage.setItem("loavy.accent", accent);
    localStorage.setItem("loavy.density", density);
    localStorage.setItem("loavy.cardStyle", cardStyle);
    localStorage.setItem("loavy.playerStyle", playerStyle);
    localStorage.setItem("loavy.fontScale", fontScale);
    localStorage.setItem("loavy.showCovers", String(showCovers));
    localStorage.setItem("loavy.reduceMotion", String(reduceMotion));
  }, [theme, accent, density, cardStyle, playerStyle, fontScale, showCovers, reduceMotion]);

  useEffect(() => {
    setLoading(true);
    Promise.all([refreshLibrary(""), api.getScanState()])
      .then(([, scanState]) => setScanning(scanState.running))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    async function refreshRoomClientPermission() {
      try {
        const status = await api.getRoomClientStatus();
        roomClientStatusRef.current = {
          connected: status.connected,
          allowGuestControl: status.allowGuestControl,
          host: status.host,
          port: status.port
        };
        audioEngine.setLocalControlBlocked(status.connected && !status.allowGuestControl, () => {
          setError("The host does not allow guests to change songs.");
        });
      } catch {
        roomClientStatusRef.current = { connected: false, allowGuestControl: false, host: null, port: null };
        audioEngine.setLocalControlBlocked(false);
      }
    }

    refreshRoomClientPermission();
    const timer = window.setInterval(refreshRoomClientPermission, 1500);
    return () => {
      window.clearInterval(timer);
      audioEngine.setLocalControlBlocked(false);
    };
  }, []);

  useEffect(() => {
    function handleLocalPlaybackChanged(event: Event) {
      const detail = (event as CustomEvent<RoomPlaybackState>).detail;
      const client = roomClientStatusRef.current;
      if (!client.connected) return;
      if (!client.allowGuestControl) {
        setError("The host does not allow guests to change songs.");
        return;
      }
      api.sendGuestPlaybackState(detail).catch((err) => setError(String(err)));
    }

    window.addEventListener("loavy:local-playback-changed", handleLocalPlaybackChanged);
    return () => window.removeEventListener("loavy:local-playback-changed", handleLocalPlaybackChanged);
  }, []);

  useEffect(() => {
    let disposed = false;

    async function syncToRoomPlayback(playback: RoomPlaybackState) {
      if (disposed) return;
      try {
        let track = await api.findRoomPlaybackTrack(playback);
        if (!track) {
          const client = roomClientStatusRef.current;
          if (!playback.streamPath || !client.host || !client.port) {
            setError(`Room sync could not find "${playback.title || "the current track"}" in your local library, and the host did not provide a stream.`);
            return;
          }
          track = streamTrackFromPlayback(playback, `http://${client.host}:${client.port}${playback.streamPath}`);
        }
        setError(null);
        await audioEngine.syncToRoomPlayback(track, playback);
      } catch (err) {
        setError(String(err));
      }
    }

    const unsubs = Promise.all([
      listen<RoomPlaybackState>("room://playback-state", (event) => void syncToRoomPlayback(event.payload)),
      listen<RoomPlaybackState>("room://guest-playback-state", (event) => void syncToRoomPlayback(event.payload)),
      listen("room://guest-scan-request", () => {
        api.startLibraryScan().catch((err) => setError(String(err)));
      }),
      listen<string>("room://kicked", (event) => {
        if (!disposed) {
          setError(event.payload || "The host removed you from the room.");
        }
      }),
      listen<string>("room://error", (event) => {
        if (!disposed) {
          setError(event.payload || "Room error.");
        }
      }),
      listen("room://disconnected", () => {
        if (!disposed) {
          setError("Room connection was lost. Rejoin the room to sync playback again.");
          roomClientStatusRef.current = { connected: false, allowGuestControl: false, host: null, port: null };
          audioEngine.setLocalControlBlocked(false);
        }
      })
    ]);

    return () => {
      disposed = true;
      unsubs.then((callbacks) => callbacks.forEach((unlisten) => unlisten())).catch(() => undefined);
    };
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
          durationMs: Math.round(snapshot.duration || snapshot.current.durationMs || 0) || null,
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

  useEffect(() => {
    function handleFavoriteChanged(event: Event) {
      const detail = (event as CustomEvent<{ trackId: number; favorite: boolean }>).detail;
      setTracks((currentTracks) =>
        currentTracks.map((track) =>
          track.id === detail.trackId ? { ...track, favorite: detail.favorite } : track
        )
      );
    }

    window.addEventListener("loavy:favorite-changed", handleFavoriteChanged);
    return () => window.removeEventListener("loavy:favorite-changed", handleFavoriteChanged);
  }, []);

  const filteredTracks = useMemo(() => {
    let nextTracks = tracks;
    if (collectionFilter?.type === "album") {
      nextTracks = nextTracks.filter((track) => (track.album || "Unknown Album") === collectionFilter.value);
    }
    if (collectionFilter?.type === "artist") {
      nextTracks = nextTracks.filter((track) => displayArtist(track.artist) === collectionFilter.value);
    }
    if (activeView === "favorites") return nextTracks.filter((track) => track.favorite);
    if (activeView === "recent") return [...nextTracks].sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    return nextTracks;
  }, [activeView, collectionFilter, tracks]);

  async function addFolder() {
    setError(null);
    await api.selectMusicFolder();
    await refreshLibrary();
  }

  async function removeFolder(folderId: number) {
    setError(null);
    await api.removeMusicFolder(folderId);
    await refreshLibrary();
  }

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      const client = roomClientStatusRef.current;
      if (client.connected && client.allowGuestControl) {
        await api.requestHostScan();
      }
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

  async function changeDensity(nextDensity: string) {
    setDensity(nextDensity);
    await api.setSetting("density", nextDensity);
  }

  async function changeCardStyle(nextCardStyle: string) {
    setCardStyle(nextCardStyle);
    await api.setSetting("cardStyle", nextCardStyle);
  }

  async function changePlayerStyle(nextPlayerStyle: string) {
    setPlayerStyle(nextPlayerStyle);
    await api.setSetting("playerStyle", nextPlayerStyle);
  }

  async function changeFontScale(nextFontScale: string) {
    setFontScale(nextFontScale);
    await api.setSetting("fontScale", nextFontScale);
  }

  async function changeShowCovers(enabled: boolean) {
    setShowCovers(enabled);
    await api.setSetting("showCovers", String(enabled));
  }

  async function changeReduceMotion(enabled: boolean) {
    setReduceMotion(enabled);
    await api.setSetting("reduceMotion", String(enabled));
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
    playlists: "Playlists",
    recent: "Recently Played",
    favorites: "Favorites",
    search: "Search",
    room: "Room",
    settings: "Settings"
  }[activeView];

  function renderView() {
    if (loading) return <section className="emptyState"><h2>Loading library</h2><p>Preparing the local database.</p></section>;
    if (activeView === "albums") {
      return (
        <AlbumsView
          albums={albums}
          onOpenAlbum={(album) => {
            setCollectionFilter({ type: "album", value: album.title || "Unknown Album" });
            setActiveView("songs");
          }}
        />
      );
    }
    if (activeView === "artists") {
      return (
        <ArtistsView
          artists={artists}
          onOpenArtist={(artist) => {
            setCollectionFilter({ type: "artist", value: artist.name });
            setActiveView("songs");
          }}
        />
      );
    }
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
          density={density}
          cardStyle={cardStyle}
          playerStyle={playerStyle}
          offlineMode={offlineMode}
          fontScale={fontScale}
          showCovers={showCovers}
          reduceMotion={reduceMotion}
          onAddFolder={addFolder}
          onRemoveFolder={removeFolder}
          onScan={scan}
          onCancelScan={cancelScan}
          onThemeChange={changeTheme}
          onAccentChange={changeAccent}
          onDensityChange={changeDensity}
          onCardStyleChange={changeCardStyle}
          onPlayerStyleChange={changePlayerStyle}
          onFontScaleChange={changeFontScale}
          onShowCoversChange={changeShowCovers}
          onReduceMotionChange={changeReduceMotion}
          onOfflineModeChange={changeOfflineMode}
          onApiKeyChange={(provider, key) => void api.setApiKey(provider, key)}
        />
      );
    }
    if (activeView === "room") return <RoomView onError={setError} />;
    if (activeView === "playlists") {
      return (
        <PlaylistsView
          playlists={playlists}
          tracks={tracks}
          onCreatePlaylist={async (name) => {
            await api.createPlaylist(name);
            setPlaylists(await api.listPlaylists());
          }}
          onAddTrack={async (playlistId, trackId) => {
            await api.addTrackToPlaylist(playlistId, trackId);
            setPlaylists(await api.listPlaylists());
          }}
          onOpenPlaylist={async (playlistId) => {
            setTracks(await api.listPlaylistTracks(playlistId));
            setActiveView("songs");
          }}
        />
      );
    }
    return (
      <SongsView
        tracks={filteredTracks}
        collectionFilter={collectionFilter}
        onClearCollectionFilter={() => setCollectionFilter(null)}
      />
    );
  }

  function selectView(view: ViewKey) {
    setActiveView(view);
    if (view !== "songs" && view !== "favorites" && view !== "recent") {
      setCollectionFilter(null);
    }
  }

  return (
    <div className="appShell">
      <Sidebar active={activeView} onSelect={selectView} compact={compactSidebar} />
      <main className="mainPane">
        <header className="topBar">
          <div className="titleGroup">
            <button className="iconButton" onClick={() => setCompactSidebar(!compactSidebar)} title="Toggle sidebar">
              <SidebarIcon size={18} />
            </button>
            <div>
              <h1>{title}</h1>
              <div className="topMeta">
                <span>{tracks.length} songs</span>
                <span>{albums.length} albums</span>
                <span>{artists.length} artists</span>
                {collectionFilter && (
                  <button className="metaPillButton" onClick={() => setCollectionFilter(null)} title="Clear collection filter">
                    {collectionFilter.type}: {collectionFilter.value}
                    <X size={13} />
                  </button>
                )}
                {scanning && <strong>Scanning</strong>}
                {offlineMode && <strong>Offline</strong>}
              </div>
            </div>
          </div>
          <label className="searchBox">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search songs, artists, albums" />
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
