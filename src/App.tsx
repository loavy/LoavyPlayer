import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, CheckCircle2, RefreshCw, Search, SidebarIcon, X } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar } from "./components/PlayerBar";
import { AlbumsView } from "./views/AlbumsView";
import { ArtistsView } from "./views/ArtistsView";
import { SettingsView } from "./views/SettingsView";
import { SongsView } from "./views/SongsView";
import { RoomView } from "./views/RoomView";
import { FoldersView } from "./views/PlaylistsView";
import { UserPlaylistsView } from "./views/UserPlaylistsView";
import { FolderQueueView } from "./views/FolderQueueView";
import { DownloaderView } from "./views/DownloaderView";
import { api } from "./lib/api";
import { displayAlbum, displayArtist, displayTrackTitle } from "./lib/format";
import type {
  Album,
  Artist,
  FetcherDescriptor,
  MusicFolder,
  RoomGuestTrack,
  RoomPlaybackState,
  ScanProgress,
  ScanSummary,
  Track,
  ViewKey
} from "./types";
import { audioEngine } from "./lib/audioEngine";
import { installMouseNavigation, navigation, useNavigation } from "./lib/navigation";
import { toggleAudioTrackFavorite } from "./lib/favoriteActions";
import { LibraryActionsProvider, errorMessage, type NoticeTone } from "./lib/LibraryContext";

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

function receivedGuestTrack(playback: RoomPlaybackState, path: string): Track {
  const title = playback.title || path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Guest song";
  return {
    ...streamTrackFromPlayback(playback, path),
    fileName: path.split(/[\\/]/).pop() || title,
    fileExt: path.split(".").pop()?.toLowerCase() || "",
    path
  };
}

function trackMatchesPlayback(track: Track, playback: RoomPlaybackState) {
  const playbackTrackId = playback.trackId || null;
  const sameRoomTrackId = playbackTrackId !== null && (
    track.id === playbackTrackId
    || (track.id < 0 && Math.abs(track.id) === Math.abs(playbackTrackId))
  );
  return sameRoomTrackId || (
    displayTrackTitle(track) === playback.title &&
    displayArtist(track.artist) === playback.artist &&
    displayAlbum(track.album) === playback.album
  );
}

function App() {
  const nav = useNavigation();
  const activeView = nav.route.view;
  const collectionFilter = nav.route.collection;
  const setActiveView = (view: ViewKey) => navigation.view(view);
  const setCollectionFilter = (collection: typeof collectionFilter) => navigation.navigate({ ...navigation.current(), collection });
  useEffect(installMouseNavigation, []);
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
  const [theme, setTheme] = useState(() => localStorage.getItem("loavy.theme") || "dark");
  const [accent, setAccent] = useState(() => localStorage.getItem("loavy.accent") || "#48c6a8");
  const [density, setDensity] = useState(() => localStorage.getItem("loavy.density") || "comfortable");
  const [cardStyle, setCardStyle] = useState(() => localStorage.getItem("loavy.cardStyle") || "soft");
  const [playerStyle, setPlayerStyle] = useState(() => localStorage.getItem("loavy.playerStyle") || "docked");
  const [fontScale, setFontScale] = useState(() => localStorage.getItem("loavy.fontScale") || "100");
  const [showCovers, setShowCovers] = useState(() => localStorage.getItem("loavy.showCovers") !== "false");
  const [reduceMotion, setReduceMotion] = useState(() => localStorage.getItem("loavy.reduceMotion") === "true");
  const [cornerStyle, setCornerStyle] = useState(() => localStorage.getItem("loavy.cornerStyle") || "rounded");
  const [backgroundStyle, setBackgroundStyle] = useState(() => localStorage.getItem("loavy.backgroundStyle") || "ambient");
  const [highContrast, setHighContrast] = useState(() => localStorage.getItem("loavy.highContrast") === "true");
  const [showTrackFormat, setShowTrackFormat] = useState(() => localStorage.getItem("loavy.showTrackFormat") !== "false");
  const [offlineMode, setOfflineMode] = useState(() => localStorage.getItem("loavy.offlineMode") === "true");
  const [backgroundMode, setBackgroundMode] = useState(false);
  const [compactSidebar, setCompactSidebar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; tone: NoticeTone } | null>(null);
  const [roomHostRunning, setRoomHostRunning] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionRestoredRef = useRef(false);
  const libraryRefreshTimerRef = useRef<number | null>(null);
  const roomClientStatusRef = useRef<{ connected: boolean; allowGuestControl: boolean; host?: string | null; port?: number | null }>({
    connected: false,
    allowGuestControl: false,
    host: null,
    port: null
  });
  const deferredQuery = useDeferredValue(query);

  const refreshLibrary = useCallback(async () => {
    const [nextTracks, nextAlbums, nextArtists, nextFolders, nextFetchers] = await Promise.all([
      api.listTracks(),
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
    if (sessionRestoredRef.current) audioEngine.reconcileQueue(nextTracks);
    return nextTracks;
  }, []);

  const notify = useCallback((message: string, tone: NoticeTone = "info") => {
    if (tone === "error") setError(message);
    else setNotice({ message, tone });
  }, []);

  const openAlbum = useCallback((album: string) => {
    navigation.navigate({ view: "songs", collection: { type: "album", value: album || "Unknown Album" }, playlist: null, folder: null });
    setQuery("");
  }, []);

  const openArtist = useCallback((artist: string) => {
    navigation.navigate({ view: "songs", collection: { type: "artist", value: artist || "Unknown Artist" }, playlist: null, folder: null });
    setQuery("");
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
    document.documentElement.dataset.cards = cardStyle;
    document.documentElement.dataset.player = playerStyle;
    document.documentElement.dataset.covers = showCovers ? "show" : "hide";
    document.documentElement.dataset.motion = reduceMotion ? "reduced" : "full";
    document.documentElement.dataset.corners = cornerStyle;
    document.documentElement.dataset.background = backgroundStyle;
    document.documentElement.dataset.contrast = highContrast ? "high" : "normal";
    document.documentElement.dataset.trackFormat = showTrackFormat ? "show" : "hide";
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
    localStorage.setItem("loavy.cornerStyle", cornerStyle);
    localStorage.setItem("loavy.backgroundStyle", backgroundStyle);
    localStorage.setItem("loavy.highContrast", String(highContrast));
    localStorage.setItem("loavy.showTrackFormat", String(showTrackFormat));
  }, [theme, accent, density, cardStyle, playerStyle, fontScale, showCovers, reduceMotion, cornerStyle, backgroundStyle, highContrast, showTrackFormat]);

  useEffect(() => {
    setLoading(true);
    Promise.all([refreshLibrary(), api.getScanState(), api.getSetting("backgroundMode")])
      .then(([initialTracks, scanState, savedBackgroundMode]) => {
        audioEngine.restoreSession(initialTracks);
        sessionRestoredRef.current = true;
        setScanning(scanState.running);
        setBackgroundMode(savedBackgroundMode === "true");
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [refreshLibrary]);

  useEffect(() => {
    function handleRoomStatus(event: Event) {
      const detail = (event as CustomEvent<{
        hostRunning: boolean;
        client: { connected: boolean; allowGuestControl: boolean; host?: string | null; port?: number | null };
      }>).detail;
      if (!detail) return;
      setRoomHostRunning(detail.hostRunning);
      roomClientStatusRef.current = detail.client;
      audioEngine.setLocalControlBlocked(detail.client.connected && !detail.client.allowGuestControl, () => {
        setError("The host does not allow guests to change songs.");
      });
    }

    window.addEventListener("loavy:room-status", handleRoomStatus);
    return () => {
      window.removeEventListener("loavy:room-status", handleRoomStatus);
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
      const current = audioEngine.snapshot().current;
      const send = current && !/^https?:\/\//i.test(current.path)
        ? api.sendGuestTrack(detail, current.path)
        : api.sendGuestPlaybackState(detail);
      send.catch((err) => setError(String(err)));
    }

    window.addEventListener("loavy:local-playback-changed", handleLocalPlaybackChanged);
    return () => window.removeEventListener("loavy:local-playback-changed", handleLocalPlaybackChanged);
  }, []);

  useEffect(() => {
    let disposed = false;

    async function syncToRoomPlayback(playback: RoomPlaybackState, receivedTrack?: Track) {
      if (disposed) return;
      try {
        const current = audioEngine.snapshot().current;
        let track = receivedTrack
          || (current && trackMatchesPlayback(current, playback) ? current : null)
          || await api.findRoomPlaybackTrack(playback);
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
      listen<RoomGuestTrack>("room://guest-track-received", (event) => {
        void syncToRoomPlayback(
          event.payload.playback,
          receivedGuestTrack(event.payload.playback, event.payload.path)
        );
      }),
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
    if (!roomHostRunning) return;
    let disposed = false;
    let timer = 0;
    let lastSignature = "";
    async function broadcast() {
      const snapshot = audioEngine.snapshot();
      if (snapshot.current) {
        const signature = `${snapshot.current.id}:${snapshot.playing ? 1 : 0}:${Math.floor(snapshot.position / 1_000)}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          try {
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
        }
      }
      if (!disposed) timer = window.setTimeout(() => void broadcast(), 2_000);
    }
    void broadcast();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [roomHostRunning]);

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

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (libraryRefreshTimerRef.current !== null) window.clearTimeout(libraryRefreshTimerRef.current);
      libraryRefreshTimerRef.current = window.setTimeout(() => {
        libraryRefreshTimerRef.current = null;
        refreshLibrary().catch((err) => !disposed && setError(errorMessage(err)));
      }, 80);
    };
    const unlisten = listen<{ kind: string }>("library://changed", (event) => {
      // markTrackPlayed already updates the returned statistics locally.
      if (event.payload.kind !== "track-played") refresh();
    });
    return () => {
      disposed = true;
      if (libraryRefreshTimerRef.current !== null) window.clearTimeout(libraryRefreshTimerRef.current);
      unlisten.then((callback) => callback()).catch(() => undefined);
    };
  }, [refreshLibrary]);

  useEffect(() => {
    function handleTrackStarted(event: Event) {
      const { trackId } = (event as CustomEvent<{ trackId: number }>).detail;
      if (trackId <= 0) return;
      api.markTrackPlayed(trackId)
        .then((stats) => {
          setTracks((current) => current.map((track) => track.id === stats.trackId
            ? { ...track, lastPlayedAt: stats.lastPlayedAt, playCount: stats.playCount }
            : track));
        })
        .catch(() => undefined);
    }
    window.addEventListener("loavy:track-started", handleTrackStarted);
    function handlePlaybackError(event: Event) {
      const detail = (event as CustomEvent<{ message: string }>).detail;
      if (detail?.message) setError(detail.message);
    }
    window.addEventListener("loavy:playback-error", handlePlaybackError);
    return () => {
      window.removeEventListener("loavy:track-started", handleTrackStarted);
      window.removeEventListener("loavy:playback-error", handlePlaybackError);
    };
  }, []);

  useEffect(() => {
    const unlisten = listen("app://backgrounding", () => audioEngine.flushSession());
    return () => { unlisten.then((callback) => callback()).catch(() => undefined); };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    function isTyping(target: EventTarget | null) {
      return target instanceof Element && Boolean(
        target.closest("input, textarea, select, [contenteditable='true']")
      );
    }
    function hasOwnKeyboardAction(target: EventTarget | null) {
      return target instanceof Element && Boolean(target.closest([
        "button",
        "a[href]",
        "summary",
        "[role='button']",
        "[role='menuitem']",
        "[role='option']",
        "[role='switch']",
        "[role='slider']",
        "[role='row'][tabindex]",
        "[tabindex]:not([tabindex='-1'])"
      ].join(", ")));
    }
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented
        || isTyping(event.target)
        || document.querySelector("[role='dialog'][aria-modal='true'], [role='menu']")
      ) return;

      if (event.ctrlKey && !event.shiftKey && event.key.toLocaleLowerCase() === "l") {
        event.preventDefault();
        setActiveView("songs");
        window.requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }
      if (event.code === "Space" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (hasOwnKeyboardAction(event.target)) return;
        event.preventDefault();
        void audioEngine.toggle();
      } else if (event.ctrlKey && event.key === "ArrowRight") {
        event.preventDefault();
        void audioEngine.next();
      } else if (event.ctrlKey && event.key === "ArrowLeft") {
        event.preventDefault();
        void audioEngine.previous();
      } else if (event.ctrlKey && event.shiftKey && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        const current = audioEngine.snapshot().current;
        if (!current || current.id <= 0) return;
        void toggleAudioTrackFavorite(current.id).catch((err) => setError(errorMessage(err)));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filteredTracks = useMemo(() => {
    let nextTracks = tracks;
    const search = deferredQuery.trim().toLocaleLowerCase();
    if (search) {
      nextTracks = nextTracks.filter((track) => [
        displayTrackTitle(track),
        displayArtist(track.artist),
        displayAlbum(track.album),
        track.genre || "",
        track.fileName
      ].some((value) => value.toLocaleLowerCase().includes(search)));
    }
    if (collectionFilter?.type === "album") {
      nextTracks = nextTracks.filter((track) => (track.album || "Unknown Album") === collectionFilter.value);
    }
    if (collectionFilter?.type === "artist") {
      nextTracks = nextTracks.filter((track) => displayArtist(track.artist) === collectionFilter.value);
    }
    if (activeView === "favorites") return nextTracks.filter((track) => track.favorite);
    if (activeView === "recent") return nextTracks.filter((track) => track.lastPlayedAt).sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    return nextTracks;
  }, [activeView, collectionFilter, deferredQuery, tracks]);

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

  async function changeAppearanceSetting(key: string, value: string, apply: (value: string) => void) {
    apply(value);
    await api.setSetting(key, value);
  }

  async function changeOfflineMode(enabled: boolean) {
    setOfflineMode(enabled);
    localStorage.setItem("loavy.offlineMode", String(enabled));
    await api.setSetting("offlineMode", String(enabled));
  }

  async function changeBackgroundMode(enabled: boolean) {
    try {
      await api.setBackgroundMode(enabled);
      setBackgroundMode(enabled);
    } catch (err) {
      setError(String(err));
    }
  }

  const title = {
    songs: "Songs",
    albums: "Albums",
    artists: "Artists",
    playlists: "Playlists",
    folders: "Folders",
    folderQueue: "Folder Queue",
    recent: "Recently Played",
    favorites: "Favorites",
    room: "Room",
    downloader: "Downloader",
    settings: "Settings"
  }[activeView];

  function renderView() {
    if (loading) return <section className="emptyState"><h2>Loading library</h2><p>Preparing the local database.</p></section>;
    if (activeView === "albums") {
      return (
        <AlbumsView
          albums={albums}
          onOpenAlbum={(album) => openAlbum(album.title || "Unknown Album")}
        />
      );
    }
    if (activeView === "artists") {
      return (
        <ArtistsView
          artists={artists}
          onOpenArtist={(artist) => openArtist(artist.name)}
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
          backgroundMode={backgroundMode}
          fontScale={fontScale}
          showCovers={showCovers}
          reduceMotion={reduceMotion}
          cornerStyle={cornerStyle}
          backgroundStyle={backgroundStyle}
          highContrast={highContrast}
          showTrackFormat={showTrackFormat}
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
          onCornerStyleChange={(value) => void changeAppearanceSetting("cornerStyle", value, setCornerStyle)}
          onBackgroundStyleChange={(value) => void changeAppearanceSetting("backgroundStyle", value, setBackgroundStyle)}
          onHighContrastChange={(enabled) => void changeAppearanceSetting("highContrast", String(enabled), (value) => setHighContrast(value === "true"))}
          onShowTrackFormatChange={(enabled) => void changeAppearanceSetting("showTrackFormat", String(enabled), (value) => setShowTrackFormat(value === "true"))}
          onOfflineModeChange={changeOfflineMode}
          onBackgroundModeChange={changeBackgroundMode}
          onApiKeyChange={(provider, key) => void api.setApiKey(provider, key)}
        />
      );
    }
    if (activeView === "room") return <RoomView onError={setError} />;
    if (activeView === "playlists") return <UserPlaylistsView tracks={tracks} onOpenFolders={() => setActiveView("folders")} />;
    if (activeView === "folders") return <FoldersView folders={folders} tracks={tracks} onOpenSettings={() => setActiveView("settings")} />;
    if (activeView === "folderQueue") return <FolderQueueView tracks={tracks} />;
    return (
      <SongsView
        tracks={filteredTracks}
        collectionFilter={collectionFilter}
        onClearCollectionFilter={() => setCollectionFilter(null)}
        emptyKind={activeView === "favorites" ? "favorites" : activeView === "recent" ? "recent" : deferredQuery ? "search" : "library"}
      />
    );
  }

  function selectView(view: ViewKey) {
    setActiveView(view);
  }

  const libraryActions = useMemo(() => ({
    refreshLibrary: async () => { await refreshLibrary(); },
    openArtist,
    openAlbum,
    notify
  }), [notify, openAlbum, openArtist, refreshLibrary]);

  return (
    <LibraryActionsProvider value={libraryActions}>
    <div className="appShell">
      <Sidebar active={activeView} onSelect={selectView} compact={compactSidebar} />
      <main className="mainPane">
        <header className="topBar">
          <div className="titleGroup">
            <div className="navigationButtons">
              <button className="iconButton" onClick={() => navigation.back()} disabled={!nav.canBack} aria-label="Go back" title="Back (mouse back button or Alt+Left)"><ArrowLeft size={17} /></button>
              <button className="iconButton" onClick={() => navigation.forward()} disabled={!nav.canForward} aria-label="Go forward" title="Forward (mouse forward button or Alt+Right)"><ArrowRight size={17} /></button>
            </div>
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
          <div className="topBarSearch">
            <button className="quickScanButton" onClick={() => void scan()} disabled={scanning} title={scanning ? "Scanning library" : "Quick scan library"} aria-label={scanning ? "Scanning library" : "Quick scan library"}>
              <RefreshCw size={17} className={scanning ? "spin" : ""} />
            </button>
            <label className="searchBox">
              <Search size={17} />
              <input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search songs, artists, albums" aria-label="Search library" />
            </label>
          </div>
        </header>
        {error && <div className="errorBanner" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button></div>}
        <div className="contentArea">
          <div className="persistentViewHost" hidden={activeView !== "downloader"}>
            <DownloaderView
              onDownloadMedia={api.downloadMedia}
              onGetStatus={api.getDownloaderStatus}
              onRepairTools={api.repairDownloaderTools}
              onCancel={api.cancelMediaDownload}
              onSelectFolder={api.selectDownloadFolder}
              onRevealDownload={api.revealDownload}
            />
          </div>
          {activeView !== "downloader" && renderView()}
        </div>
      </main>
      <PlayerBar />
      {notice && <div className={`toastNotice ${notice.tone}`} role="status"><CheckCircle2 size={17} /><span>{notice.message}</span><button onClick={() => setNotice(null)} aria-label="Dismiss notification"><X size={15} /></button></div>}
    </div>
    </LibraryActionsProvider>
  );
}

export default App;
