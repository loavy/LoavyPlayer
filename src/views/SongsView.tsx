import { useMemo, useRef, useState } from "react";
import { ArrowLeft, Disc3, Heart, History, Music2, Pause, Pin, Play, Plus, Shuffle, UserRound } from "lucide-react";
import type { Track } from "../types";
import { Cover } from "../components/Cover";
import { VirtualSongList } from "../components/VirtualSongList";
import { audioEngine } from "../lib/audioEngine";
import { displayArtist, displayTrackTitle } from "../lib/format";
import { useAudioSelector } from "../lib/useAudio";

type Props = {
  tracks: Track[];
  title?: string;
  collectionFilter?: { type: "album" | "artist"; value: string } | null;
  onClearCollectionFilter?: () => void;
  onOpenSettings?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  emptyKind?: "library" | "favorites" | "recent" | "search";
};

export function SongsView({ tracks, title = "Songs", collectionFilter, onClearCollectionFilter, onOpenSettings, pinned, onTogglePin, emptyKind = "library" }: Props) {
  const [sort, setSort] = useState("original");
  const scrollRef = useRef<HTMLElement>(null);
  const audio = useAudioSelector(
    (state) => ({ currentId: state.current?.id, playing: state.playing, blocked: state.localControlBlocked, queue: state.queue }),
    (a, b) => a.currentId === b.currentId && a.playing === b.playing && a.blocked === b.blocked && a.queue === b.queue
  );
  const sortedTracks = useMemo(() => {
    if (sort === "title") return [...tracks].sort((a, b) => displayTrackTitle(a).localeCompare(displayTrackTitle(b)));
    if (sort === "artist") return [...tracks].sort((a, b) => displayArtist(a.artist).localeCompare(displayArtist(b.artist)));
    if (sort === "added") return [...tracks].sort((a, b) => b.dateAdded - a.dateAdded);
    return tracks;
  }, [tracks, sort]);
  const trackIds = useMemo(() => new Set(tracks.map((track) => track.id)), [tracks]);
  const activeQueue = Boolean(
    audio.currentId !== undefined && trackIds.has(audio.currentId)
    && audio.queue.length === tracks.length && audio.queue.every((track) => trackIds.has(track.id))
  );
  const playing = activeQueue && audio.playing;
  const duration = useMemo(() => tracks.reduce((sum, track) => sum + (track.durationMs || 0), 0), [tracks]);
  const minutes = Math.round(duration / 60_000);
  const durationLabel = minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;
  const Icon = collectionFilter?.type === "album" ? Disc3 : collectionFilter?.type === "artist" ? UserRound : emptyKind === "favorites" ? Heart : emptyKind === "recent" ? History : Music2;
  const heading = collectionFilter?.value || title;
  const cover = tracks.find((track) => track.coverPath)?.coverPath;
  const artists = [...new Set(tracks.map((track) => displayArtist(track.artist)))];
  const description = collectionFilter?.type === "album" ? artists.slice(0, 3).join(", ") : null;

  function play(shuffle = false) {
    if (!sortedTracks.length || audio.blocked) return;
    if (!shuffle && activeQueue) { void audioEngine.toggle(); return; }
    audioEngine.setShuffle(shuffle);
    const first = shuffle ? sortedTracks[Math.floor(Math.random() * sortedTracks.length)] : sortedTracks[0];
    const queue = shuffle ? [first, ...sortedTracks.filter((track) => track.id !== first.id)] : sortedTracks;
    void audioEngine.playTrack(first, queue, 0);
  }

  if (!tracks.length) {
    const content = collectionFilter
      ? { title: "No songs in this collection", text: "Try another album or artist." }
      : emptyKind === "favorites"
        ? { title: "Keep your favorites close", text: "Tap the heart on any song to give it a home here." }
        : emptyKind === "recent"
          ? { title: "Your next favorite starts here", text: "Listen to something from your library. Your recent plays will appear here." }
          : emptyKind === "search"
            ? { title: "No matches", text: "Try a different title, artist, album, or genre." }
            : { title: "A home for your music", text: "Your albums, your favorites, your little discoveries. Add a music folder to get started." };
    return (
      <section className="emptyState libraryEmpty">
        <span className="emptyRecord" aria-hidden="true"><Icon size={36} strokeWidth={1.3} /></span>
        <span className="libraryEyebrow">YOUR LOCAL LIBRARY</span>
        <h2>{content.title}</h2><p>{content.text}</p>
        {collectionFilter && onClearCollectionFilter ? <button className="secondaryAction" onClick={onClearCollectionFilter}><ArrowLeft size={15} /> Show all songs</button>
          : emptyKind === "library" && onOpenSettings && <button className="primaryAction" onClick={onOpenSettings}><Plus size={16} /> Add your music</button>}
      </section>
    );
  }

  return (
    <section className="songStack librarySongPage" ref={scrollRef} aria-label={heading}>
      <header className={collectionFilter ? "libraryHero collectionHero" : "libraryHero"}>
        {collectionFilter && <div className="collectionArtwork"><Cover path={cover} title={heading} size="lg" /></div>}
        <div className="libraryHeroCopy">
          <span className="libraryEyebrow"><Icon size={13} />{collectionFilter?.type || "Your library"}</span>
          <h2>{heading}</h2>
          {description && <p className="libraryDescription">{description}</p>}
          <div className="libraryFacts">
            <span>{tracks.length.toLocaleString()} {tracks.length === 1 ? "song" : "songs"}</span>
            {duration > 0 && <span>{durationLabel}</span>}
            {collectionFilter?.type === "album" && tracks[0]?.year && <span>{tracks[0].year}</span>}
          </div>
          <div className="libraryActions">
            <button className="primaryAction libraryPlay" onClick={() => play()} disabled={audio.blocked} aria-label={playing ? "Pause collection" : "Play collection"}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}{playing ? "Pause" : activeQueue ? "Resume" : "Play"}</button>
            <button className="secondaryAction" onClick={() => play(true)} disabled={audio.blocked}><Shuffle size={16} /> Shuffle</button>
            {onTogglePin && <button className={pinned ? "secondaryAction collectionPin active" : "secondaryAction collectionPin"} onClick={onTogglePin} aria-label={pinned ? "Unpin album" : "Pin album"} aria-pressed={Boolean(pinned)} title={pinned ? "Unpin album" : "Pin album"}><Pin size={16} fill={pinned ? "currentColor" : "none"} /></button>}
            {collectionFilter && onClearCollectionFilter && <button className="collectionBack" onClick={onClearCollectionFilter}><ArrowLeft size={14} /> All songs</button>}
          </div>
        </div>
      </header>
      <div className="libraryListToolbar">
        <span>Track list <small>{tracks.length.toLocaleString()}</small></span>
        <label>
          <span className="srOnly">Sort songs</span>
          <select aria-label="Sort songs" value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="original">{emptyKind === "recent" ? "Recently played" : collectionFilter ? "Track order" : "Library order"}</option>
            <option value="title">Title A–Z</option>
            <option value="artist">Artist A–Z</option>
            <option value="added">Recently added</option>
          </select>
        </label>
      </div>
      <VirtualSongList tracks={sortedTracks} scrollParentRef={scrollRef} albumView={collectionFilter?.type === "album"} />
    </section>
  );
}
