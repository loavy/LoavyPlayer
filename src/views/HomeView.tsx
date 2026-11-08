import { ArrowRight, Disc3, Heart, History, Music2, Pause, Play, Plus } from "lucide-react";
import { useMemo } from "react";
import { Cover } from "../components/Cover";
import { audioEngine } from "../lib/audioEngine";
import { displayArtist, displayTrackTitle } from "../lib/format";
import { useLibraryActions } from "../lib/LibraryContext";
import { useAudioSelector } from "../lib/useAudio";
import type { Album, Track, ViewKey } from "../types";

type Props = { tracks: Track[]; albums: Album[]; onNavigate: (view: ViewKey) => void };

export function HomeView({ tracks, albums, onNavigate }: Props) {
  const { openAlbum } = useLibraryActions();
  const blocked = useAudioSelector((state) => state.localControlBlocked);
  const current = useAudioSelector((state) => state.current);
  const playing = useAudioSelector((state) => state.playing);
  const recent = useMemo(() => [...tracks].filter((track) => track.lastPlayedAt).sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0)), [tracks]);
  const favorites = useMemo(() => tracks.filter((track) => track.favorite), [tracks]);
  const featured = useMemo(() => {
    const albumNames = [...new Set(recent.map((track) => track.album))];
    const byTitle = new Map(albums.map((album) => [album.title, album]));
    const ordered = albumNames.map((name) => name ? byTitle.get(name) : undefined).filter((album): album is Album => Boolean(album));
    return [...ordered, ...albums.filter((album) => !albumNames.includes(album.title))].slice(0, 12);
  }, [recent, albums]);

  const spotlight = current || recent[0] || null;

  function play(queue: Track[]) {
    if (!queue.length || blocked) return;
    audioEngine.setShuffle(false);
    void audioEngine.playTrack(queue[0], queue, 0);
  }

  return <section className="homeView">
    <header className={spotlight ? "homeHeading homeSpotlight" : "homeHeading"}>
      <div className="homeGreeting"><h2>{tracks.length ? greeting() : "Home"}</h2>{!!tracks.length && <p>{tracks.length.toLocaleString()} songs and {albums.length.toLocaleString()} albums, ready when you are.</p>}<button className="secondaryAction" onClick={() => onNavigate("settings")}><Plus size={15} /> Add music</button></div>
      {spotlight && <div className="homeContinue">
        <div className="homeContinueBackdrop" aria-hidden="true"><Cover path={spotlight.coverPath} title={spotlight.album || undefined} size="lg" /></div>
        <Cover path={spotlight.coverPath} title={spotlight.album || undefined} size="lg" />
        <div className="homeContinueText"><small>{current ? playing ? "Now playing" : "Paused" : "Pick up where you left off"}</small><strong>{displayTrackTitle(spotlight)}</strong><span>{displayArtist(spotlight.artist)}</span></div>
        <button className="homeContinuePlay" disabled={blocked} aria-label={current && playing ? "Pause the current song" : current ? "Resume the current song" : `Play ${displayTrackTitle(spotlight)} again`} onClick={() => current ? void audioEngine.toggle() : void audioEngine.playTrack(spotlight, recent, 0)}>{current && playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>
      </div>}
    </header>
    {!tracks.length ? <div className="homeWelcome"><span className="homeWelcomeRecord"><Disc3 size={62} strokeWidth={.8} /></span><h3>Your library starts here.</h3><p>Add a folder from your computer and make yourself at home.</p><button className="primaryAction" onClick={() => onNavigate("settings")}><Plus size={16} /> Add a music folder</button></div> : <>
      <div className="homeShortcuts">
        {[{ view: "songs" as const, label: "All songs", icon: Music2, count: tracks.length, queue: tracks }, { view: "favorites" as const, label: "Favorites", icon: Heart, count: favorites.length, queue: favorites }, { view: "recent" as const, label: "Recently played", icon: History, count: recent.length, queue: recent }].map((item) => <div className={`homeShortcut ${item.view}`} key={item.view}>
          <button className="shortcutLink" onClick={() => onNavigate(item.view)}><span className="shortcutIcon"><item.icon size={23} strokeWidth={1.5} /></span><span><strong>{item.label}</strong><small>{item.count.toLocaleString()} songs</small></span></button>
          <button className="shortcutPlay" aria-label={`Play ${item.label.toLowerCase()}`} onClick={() => play(item.queue)} disabled={!item.queue.length || blocked}><Play size={16} fill="currentColor" /></button>
        </div>)}
      </div>
      <div className="homeSectionHeading"><h3>{recent.length ? "Back in rotation" : "From your library"}</h3><button onClick={() => onNavigate("albums")}>All albums <ArrowRight size={14} /></button></div>
      <div className="homeAlbumGrid">{featured.map((album) => <button className="homeAlbumCard" key={`${album.artist}:${album.title}`} onClick={() => openAlbum(album.title)} title={`Open ${album.title}`}><div className="homeAlbumArt"><Cover path={album.coverPath} title={album.title} size="lg" /><span><ArrowRight size={20} /></span></div><strong>{album.title}</strong><small>{displayArtist(album.artist)}</small></button>)}</div>
      <div className="homeSectionHeading"><h3>{recent.length ? "Keep listening" : "A place to start"}</h3><button onClick={() => onNavigate(recent.length ? "recent" : "songs")}>View all <ArrowRight size={14} /></button></div>
      <div className="homeTrackGrid">{(recent.length ? recent : tracks).slice(0, 6).map((track) => <button className="homeTrack" key={track.id} onClick={() => void audioEngine.playTrack(track, recent.length ? recent : tracks, (recent.length ? recent : tracks).indexOf(track))} disabled={blocked}><Cover path={track.coverPath} title={track.album || undefined} size="sm" /><span><strong>{displayTrackTitle(track)}</strong><small>{displayArtist(track.artist)}</small></span><Play size={14} /></button>)}</div>
    </>}
  </section>;
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Late night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
