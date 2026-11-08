import { useMemo, useState } from "react";
import { BarChart3, Clock3, Disc3, Headphones, Music2 } from "lucide-react";
import { listeningStats, localDay, useListeningStats } from "../lib/listeningStats";
import { Cover } from "../components/Cover";
import { useLibraryActions } from "../lib/LibraryContext";
import type { Track } from "../types";

function duration(ms: number) { if (ms > 0 && ms < 60_000) return `${Math.floor(ms / 1000)} sec`; const minutes = Math.floor(ms / 60_000); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`; }
export function StatsView({ tracks }: { tracks: Track[] }) {
  const history = useListeningStats();
  const [days, setDays] = useState(7);
  const { openArtist, openAlbum } = useLibraryActions();
  const stats = useMemo(() => {
    const start = new Date(); start.setDate(start.getDate() - days + 1);
    const cutoff = localDay(start), entries = history.entries.filter((entry) => entry.day >= cutoff);
    const artists = new Map<string, number>(), albums = new Map<string, { title: string; artist: string; ms: number; id: number }>(), songs = new Map<number, { title: string; artist: string; ms: number; plays: number }>();
    const totals = new Map<string, number>(); let ms = 0, plays = 0;
    for (const entry of entries) {
      ms += entry.milliseconds; plays += entry.plays;
      totals.set(entry.day, (totals.get(entry.day) || 0) + entry.milliseconds);
      artists.set(entry.artist, (artists.get(entry.artist) || 0) + entry.milliseconds);
      const key = `${entry.album}:${entry.artist}`, album = albums.get(key);
      albums.set(key, { title: entry.album, artist: entry.artist, ms: (album?.ms || 0) + entry.milliseconds, id: entry.trackId });
      const song = songs.get(entry.trackId); songs.set(entry.trackId, { title: entry.title, artist: entry.artist, ms: (song?.ms || 0) + entry.milliseconds, plays: (song?.plays || 0) + entry.plays });
    }
    const chart = Array.from({ length: Math.min(days, 30) }, (_, index) => { const date = new Date(); date.setDate(date.getDate() - Math.min(days, 30) + index + 1); return { day: localDay(date), label: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }), ms: totals.get(localDay(date)) || 0 }; });
    return { ms, plays, artists: [...artists].sort((a, b) => b[1] - a[1]).slice(0, 5), albums: [...albums.values()].sort((a, b) => b.ms - a.ms).slice(0, 5), songs: [...songs].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8), unique: songs.size, chart };
  }, [history.entries, days]);
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const maximum = Math.max(60_000, ...stats.chart.map((day) => day.ms));
  return <section className="statsView">
    <header className="statsHeading"><div><span className="libraryEyebrow">YOUR LISTENING, ON THIS DEVICE</span><h2>A little more you.</h2><p>The songs and artists that have been keeping you company.</p></div><select aria-label="Listening stats period" value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={365}>Last year</option></select></header>
    {history.error && <p className="statsError" role="status">{history.error} <button onClick={() => void (history.loaded ? listeningStats.flush() : listeningStats.load())}>Retry</button></p>}
    <div className="statsMetrics">{[{ icon: Clock3, value: duration(stats.ms), label: "Time listening" }, { icon: Headphones, value: stats.plays, label: "Qualified plays" }, { icon: Music2, value: stats.unique, label: "Different songs" }, { icon: Disc3, value: stats.artists.length ? stats.artists[0][0] : "—", label: "Most played artist" }].map((item) => <div className="statsMetric" key={item.label}><item.icon size={17} /><strong>{item.value}</strong><span>{item.label}</span></div>)}</div>
    <section className="statsChartPanel"><header><h3>Your listening rhythm</h3><span>{days === 365 ? "Daily activity · last 30 days" : "Daily listening time"}</span></header><div className="statsChart" role="img" aria-label={stats.chart.map((day) => `${day.label}: ${duration(day.ms)}`).join("; ")}>{stats.chart.map((day, index) => <div key={day.day} title={`${day.label}: ${duration(day.ms)}`}><span style={{ height: `${day.ms ? Math.max(3, day.ms / maximum * 100) : 1}%` }} />{(days === 7 || index % 5 === 0 || index === stats.chart.length - 1) && <small>{day.label}</small>}</div>)}</div></section>
    {!stats.ms && <div className="statsEmpty"><BarChart3 size={28} strokeWidth={1.3} /><strong>{history.loaded ? "Your story starts with the next song." : "Loading your listening history…"}</strong><p>Time is counted while music plays. A play counts after 30 seconds, or half of a shorter song. History starts with this version and stays on this device.</p></div>}
    {!!stats.ms && <><div className="statsRankings"><section><h3>Artists on repeat</h3>{stats.artists.map(([artist, ms], index) => <button className="statsArtist" key={artist} onClick={() => openArtist(artist)}><span>{index + 1}</span><strong>{artist}</strong><small>{duration(ms)}</small><i style={{ width: `${ms / (stats.artists[0]?.[1] || 1) * 100}%` }} /></button>)}</section><section><h3>Albums you stayed with</h3>{stats.albums.map((album) => <button className="statsAlbum" key={`${album.artist}:${album.title}`} onClick={() => openAlbum(album.title)}><Cover path={byId.get(album.id)?.coverPath} title={album.title} size="sm" /><span><strong>{album.title}</strong><small>{album.artist}</small></span><small>{duration(album.ms)}</small></button>)}</section></div><section className="statsSongs"><h3>Your most played songs</h3>{stats.songs.map(([id, song], index) => <div className="statsSong" key={id}><span>{index + 1}</span><strong>{song.title}<small>{song.artist}</small></strong><span>{song.plays} plays</span><span>{duration(song.ms)}</span></div>)}</section></>}
  </section>;
}
