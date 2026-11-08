import { useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Copy, ExternalLink, Headphones, ListMusic, Loader2, Lock, MonitorSpeaker, Play, RefreshCw, Search, Unplug, X } from "lucide-react";
import { SPOTIFY_REDIRECT, spotify, useSpotify, type SpotifyPlaylist, type SpotifyTrack } from "../lib/spotify";
import { formatDuration } from "../lib/format";
import { SpotifyMark } from "../components/SpotifyPlayerBar";

export function SpotifyView() {
  const state = useSpotify();
  const [clientId, setClientId] = useState(() => { try { return localStorage.getItem("loavy.spotifyClientId") || ""; } catch { return ""; } });
  const [search, setSearch] = useState(state.query);
  const [copied, setCopied] = useState(false);
  const [playlistFilter, setPlaylistFilter] = useState("");
  const [playlistSort, setPlaylistSort] = useState("spotify");
  const [showDevices, setShowDevices] = useState<boolean | null>(null);
  const visiblePlaylists = useMemo(() => {
    const filtered = state.playlists.filter(playlist => `${playlist.name} ${playlist.owner?.display_name || ""}`.toLocaleLowerCase().includes(playlistFilter.trim().toLocaleLowerCase()));
    return playlistSort === "name" ? filtered.sort((a, b) => a.name.localeCompare(b.name)) : filtered;
  }, [state.playlists, playlistFilter, playlistSort]);
  const selectedDevice = state.devices.find(device => device.id === state.selectedDevice);
  const clientValid = /^[a-f\d]{32}$/i.test(clientId.trim());
  const disabled = state.busy || state.roomBlocked || state.offline;
  const playbackTrack = state.playback?.item;
  function connect() { try { localStorage.setItem("loavy.spotifyClientId", clientId.trim()); } catch {} void spotify.connect(clientId); }
  async function copyRedirect() { try { await navigator.clipboard.writeText(SPOTIFY_REDIRECT); setCopied(true); } catch { setCopied(false); } }
  function openTrack(track: SpotifyTrack) { void spotify.open(track.external_urls?.spotify || `https://open.spotify.com/track/${encodeURIComponent(track.id)}`); }
  const activeDeviceName = state.playback?.device?.name || selectedDevice?.name || (state.sdkState === "ready" ? "Loavy Player" : "");
  const devicesOpen = showDevices ?? !activeDeviceName;
  const rows = (tracks: SpotifyTrack[], playlist?: SpotifyPlaylist) => <div className="spotifyTrackList" aria-label={playlist ? "Spotify playlist songs" : "Spotify search results"} aria-busy={playlist ? state.busy : state.searching}>
    {tracks.map((track, index) => <div className={playbackTrack?.id === track.id ? "spotifyTrack current" : "spotifyTrack"} key={`${track.uri}:${index}`}>
      <button className="spotifyTrackPlay" aria-label={`Play ${track.name} on Spotify`} disabled={disabled || track.is_local || track.is_playable === false} onClick={() => void spotify.play(track, playlist)}><span>{playbackTrack?.id === track.id && state.playback?.is_playing ? <span className="spotifyEq" aria-hidden="true"><i /><i /><i /></span> : index + 1}</span><Play size={13} fill="currentColor" /></button>
      {track.album?.images?.[0]?.url ? <img src={track.album.images[track.album.images.length > 2 ? 2 : 0].url} alt="" loading="lazy" /> : <span className="spotifyTrackPlaceholder"><SpotifyMark size={19} /></span>}
      <button className="spotifyTrackTitle" onClick={() => void spotify.play(track, playlist)} disabled={disabled || track.is_local || track.is_playable === false}><strong>{track.name}</strong><small>{track.artists?.map(artist => artist.name).join(", ") || "Unknown artist"}{track.is_local ? ", local file in Spotify" : ""}</small></button>
      <span className="spotifyTrackAlbum">{track.album?.name}</span>
      <span className="spotifyTrackDuration">{formatDuration(track.duration_ms)}</span>
      <button className="iconButton" aria-label={`Open ${track.name} in Spotify`} title="Open in Spotify" onClick={() => openTrack(track)}><ExternalLink size={14} /></button>
    </div>)}
  </div>;
  const playlistArt = state.selectedPlaylist?.images?.[0]?.url;

  return <section className="spotifyView spotifyStudio" data-connected={state.connected}>
    <header className="spotifyHeading">
      <div className="spotifyTitle">
        <h2><SpotifyMark size={34} />Spotify</h2>
        <p>{state.connected ? `${greeting()}${state.profile?.display_name ? `, ${state.profile.display_name}` : ""}. Pick up a playlist or search for something new.` : "Your playlists and Spotify search, right inside Loavy."}</p>
      </div>
      {state.connected && <div className="spotifyHeaderActions">
        <button className="spotifyDeviceChip" aria-expanded={devicesOpen} aria-controls="spotify-devices" onClick={() => setShowDevices(!devicesOpen)}><MonitorSpeaker size={15} /><span>{activeDeviceName ? <>Playing on <strong>{activeDeviceName}</strong></> : "Choose a device"}</span><ChevronDown size={14} className="spotifyChipChevron" /></button>
        <button className="secondaryAction spotifyDisconnect" disabled={state.busy} onClick={() => void spotify.disconnect()} title="Disconnect Spotify"><Unplug size={14} />Disconnect</button>
      </div>}
    </header>

    {state.error && <div className="spotifyNotice error" role="alert"><span>{state.error}</span><button className="iconButton" onClick={() => spotify.clearError()} aria-label="Dismiss Spotify error"><X size={15} /></button></div>}
    {state.offline && <div className="spotifyNotice" role="status">Offline mode is on. Turn it off in Settings to use Spotify.</div>}
    {state.roomBlocked && <div className="spotifyNotice" role="status">A Jam is running. Leave or end it before playing from Spotify.</div>}

    {!state.connected ? <div className="spotifySetupGrid">
      <section className="spotifyWelcome">
        <div className="spotifyWelcomeArt" aria-hidden="true"><span /><span /><span /><SpotifyMark size={76} /></div>
        <h3>Bring your Spotify in.</h3>
        <p>Browse your playlists, search the whole catalog and start songs from Loavy, on this computer or any Spotify Connect speaker.</p>
        <ul className="spotifyPerks">
          <li><ListMusic size={16} />Your playlists, sorted and searchable</li>
          <li><Search size={16} />Search every song on Spotify</li>
          <li><MonitorSpeaker size={16} />Play here or on your phone, TV or speaker</li>
        </ul>
        <div className="spotifyRequirement"><Headphones size={16} /><span>Playback needs Spotify Premium. Songs are streamed, never downloaded.</span></div>
      </section>
      <form className="spotifySetup" onSubmit={event => { event.preventDefault(); connect(); }}>
        <h3>Connect your account</h3>
        <p>Loavy uses your own free Spotify developer app. It takes about two minutes, once.</p>
        <ol>
          <li><span className="spotifyStep">1</span><div><strong>Create a developer app</strong><span>Open the <button type="button" className="spotifyTextLink" onClick={() => void spotify.open("https://developer.spotify.com/dashboard")}>Spotify dashboard <ExternalLink size={11} /></button> and turn on Web API and Web Playback SDK.</span></div></li>
          <li><span className="spotifyStep">2</span><div><strong>Add this redirect URI</strong><div className="spotifyRedirect"><code>{SPOTIFY_REDIRECT}</code><button type="button" className="iconButton" aria-label="Copy Spotify redirect URI" onClick={() => void copyRedirect()}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></div></div></li>
          <li><span className="spotifyStep">3</span><div><strong>Allow your account</strong><span>Add yourself under Users and Access. Development apps allow up to five people.</span></div></li>
        </ol>
        <label className="spotifyClientField"><span>Client ID</span><input aria-label="Spotify Client ID" placeholder="Paste the 32-character Client ID" value={clientId} onChange={event => setClientId(event.target.value)} maxLength={32} autoComplete="off" spellCheck={false} disabled={state.connecting} />{clientId.trim() && !clientValid && <small className="spotifyFieldWarn">A Client ID is 32 letters and numbers.</small>}</label>
        <div className="spotifyConnectActions"><button className="primaryAction spotifyConnectButton" type="submit" disabled={state.connecting || state.disconnecting || state.offline || !clientValid}>{state.connecting ? <Loader2 size={16} className="spotifySpinner" /> : <SpotifyMark size={16} />}{state.disconnecting ? "Disconnecting…" : state.connecting ? "Waiting for Spotify…" : "Connect Spotify"}</button>{state.connecting && <button type="button" className="secondaryAction" onClick={() => void spotify.disconnect()}>Cancel sign-in</button>}</div>
        <small className="spotifyPrivacy"><Lock size={12} />Only the Client ID is saved. No secret is needed, and sign-in stays in memory until you close Loavy.</small>
      </form>
    </div> : <>
      <section id="spotify-devices" className="spotifyDevicePanel" aria-label="Spotify playback devices" hidden={!devicesOpen}>
        <div className="spotifyDeviceIntro"><div><h3>Where should it play?</h3><p>{state.sdkState === "ready" ? "Loavy is ready as a Spotify Connect speaker." : "Pick a device, or let Loavy play it right here."}</p></div><button className="iconButton" aria-label="Refresh Spotify devices" title="Refresh devices" disabled={state.busy || state.offline} onClick={() => void spotify.refresh()}><RefreshCw size={15} /></button></div>
        <div className="spotifyDeviceChoices" role="group" aria-label="Choose a Spotify device">
          {state.sdkState !== "ready" && <button className="spotifyDeviceLoavy" disabled={disabled || state.sdkState === "loading"} onClick={() => void spotify.enableSDK()}>{state.sdkState === "loading" ? <Loader2 className="spotifySpinner" size={17} /> : <Headphones size={17} />}<span><strong>This computer</strong><small>{state.sdkState === "loading" ? "Connecting Loavy…" : "Play inside Loavy"}</small></span></button>}
          {state.devices.map(device => { const chosen = state.selectedDevice === device.id || (!state.selectedDevice && device.is_active); return <button key={device.id} aria-pressed={chosen} disabled={disabled || device.is_restricted} onClick={() => spotify.selectDevice(device.id!)}><MonitorSpeaker size={17} /><span><strong>{device.name}</strong><small>{device.is_restricted ? "Can't be controlled" : device.is_active ? "Playing now" : device.type}</small></span>{chosen && <Check size={15} />}</button>; })}
        </div>
        <div className="spotifyDeviceActions">
          <select aria-label="Spotify playback device" value={state.selectedDevice} onChange={event => spotify.selectDevice(event.target.value)} disabled={disabled}><option value="">{state.playback?.device?.name ? `Active: ${state.playback.device.name}` : "Choose a device"}</option>{state.sdkDeviceId && !state.devices.some(device => device.id === state.sdkDeviceId) && <option value={state.sdkDeviceId}>Loavy Player</option>}{state.devices.map(device => <option key={device.id} value={device.id || ""} disabled={device.is_restricted}>{device.name}{device.is_active ? " (playing)" : ""}{device.is_restricted ? " (can't be controlled)" : ""}</option>)}</select>
          <button className="primaryAction" aria-label="Use selected Spotify device" disabled={disabled || !state.selectedDevice || selectedDevice?.is_restricted || state.selectedDevice === state.playback?.device?.id} onClick={() => void spotify.transfer()}><MonitorSpeaker size={14} />Play here</button>
          <button className="spotifyTextLink" onClick={() => void spotify.open()}>Open Spotify app <ExternalLink size={11} /></button>
        </div>
        {!state.devices.length && <p className="spotifyDeviceHelp">No devices yet. Open Spotify on your computer or phone, start any song, then refresh.</p>}
        {state.sdkMessage && <p className="spotifyDeviceHelp" role="status">{state.sdkMessage}</p>}
        <p className="spotifyLocalOnly">EQ, visualizer, crossfade, stats and Jams work with your local music. Spotify plays its own audio.</p>
      </section>

      <form className="spotifySearch" onSubmit={event => { event.preventDefault(); void spotify.search(search); }}><Search size={18} /><input aria-label="Search Spotify" placeholder="What do you want to listen to?" value={search} onChange={event => { setSearch(event.target.value); if (!event.target.value) void spotify.search(""); }} disabled={state.offline} />{state.query && <button className="iconButton" type="button" aria-label="Clear Spotify search" onClick={() => { setSearch(""); void spotify.search(""); }}><X size={15} /></button>}<button className="primaryAction" type="submit" disabled={state.offline || !search.trim() || state.searching}>{state.searching ? <Loader2 size={14} className="spotifySpinner" /> : "Search"}</button></form>

      {state.playback?.item && !state.active && !state.query && !state.selectedPlaylist && <div className="spotifyCurrent">
        <div className="spotifyCurrentBackdrop" aria-hidden="true">{state.playback.item.album?.images?.[0]?.url && <img src={state.playback.item.album.images[0].url} alt="" />}</div>
        {state.playback.item.album?.images?.[0]?.url ? <img className="spotifyCurrentArt" src={state.playback.item.album.images[0].url} alt="" /> : <span className="spotifyCurrentArt"><SpotifyMark size={30} /></span>}
        <span><small>{state.playback.is_playing ? "Playing" : "Last played"} on {state.playback.device?.name || "Spotify"}</small><strong>{state.playback.item.name}</strong><em>{state.playback.item.artists?.map(artist => artist.name).join(", ")}</em></span>
        <button className="primaryAction" disabled={disabled} onClick={() => void spotify.play()}><Play size={14} fill="currentColor" />Listen in Loavy</button>
      </div>}

      {state.query ? <section className="spotifyResults"><div className="spotifySectionHeading"><h3>Songs for “{state.query}”</h3><span>{state.results.length ? `${state.results.length} shown` : ""}</span></div>{rows(state.results)}{state.resultsMore && <button className="secondaryAction spotifyLoadMore" disabled={state.searching || state.offline} onClick={() => void spotify.moreSearch()}>{state.searching ? "Loading songs…" : "More results"}</button>}{!state.results.length && !state.error && <p className="spotifyEmpty">{state.searching ? "Searching Spotify…" : "Nothing found. Try another song or artist."}</p>}</section>
      : state.selectedPlaylist ? <section className="spotifyPlaylistDetail">
        <button className="spotifyTextLink spotifyBack" onClick={() => spotify.closePlaylist()}><ArrowLeft size={14} />All playlists</button>
        <header className="spotifyPlaylistHero">
          <div className="spotifyHeroBackdrop" aria-hidden="true">{playlistArt && <img src={playlistArt} alt="" />}</div>
          {playlistArt ? <img className="spotifyHeroArt" src={playlistArt} alt="" /> : <div className="spotifyPlaylistPlaceholder"><SpotifyMark size={44} /></div>}
          <div>
            <small>Playlist</small>
            <h3>{state.selectedPlaylist.name}</h3>
            <p>{state.selectedPlaylist.owner?.display_name || "Your Spotify library"}{(state.selectedPlaylist.items?.total ?? state.selectedPlaylist.tracks?.total) !== undefined ? `, ${(state.selectedPlaylist.items?.total ?? state.selectedPlaylist.tracks?.total)!.toLocaleString()} songs` : ""}</p>
            <div><button className="primaryAction spotifyPlayBig" disabled={disabled} onClick={() => void spotify.play(undefined, state.selectedPlaylist!)}><Play size={16} fill="currentColor" />Play</button><button className="secondaryAction" onClick={() => void spotify.open(state.selectedPlaylist?.external_urls?.spotify || `https://open.spotify.com/playlist/${state.selectedPlaylist?.id}`)}><ExternalLink size={14} />Open in Spotify</button></div>
          </div>
        </header>
        {rows(state.items, state.selectedPlaylist)}
        {state.busy && !state.items.length && <p className="spotifyEmpty" role="status">Loading songs…</p>}
        {!state.busy && !state.items.length && <p className="spotifyEmpty">Spotify only shares the songs of playlists you own or collaborate on. You can still open this one in Spotify.</p>}
        {state.itemsMore && <button className="secondaryAction spotifyLoadMore" disabled={state.busy} onClick={() => void spotify.moreItems()}>Load more songs</button>}
      </section>
      : <section className="spotifyLibrary">
        <div className="spotifySectionHeading"><h3>Your playlists</h3><div className="spotifyLibraryTools"><label><Search size={14} /><input aria-label="Filter Spotify playlists" placeholder="Filter" value={playlistFilter} onChange={event => setPlaylistFilter(event.target.value)} /></label><select aria-label="Sort Spotify playlists" value={playlistSort} onChange={event => setPlaylistSort(event.target.value)}><option value="spotify">Recent first</option><option value="name">Name A to Z</option></select><button className="iconButton" aria-label="Refresh Spotify library" title="Refresh" disabled={state.busy || state.offline} onClick={() => void spotify.load()}><RefreshCw size={15} /></button></div></div>
        {!!state.playlists.length && !visiblePlaylists.length && <p className="spotifyEmpty">No playlists match "{playlistFilter}". <button className="spotifyTextLink" onClick={() => setPlaylistFilter("")}>Clear filter</button></p>}
        <div className="spotifyPlaylistGrid">{visiblePlaylists.map(playlist => <button className="spotifyPlaylistCard" key={playlist.id} disabled={state.busy || state.offline} onClick={() => void spotify.openPlaylist(playlist)}><div className="spotifyPlaylistArt">{playlist.images?.[0]?.url ? <img src={playlist.images[0].url} alt="" loading="lazy" /> : <SpotifyMark size={42} />}<span><Play size={18} fill="currentColor" /></span></div><strong>{playlist.name}</strong><small>{playlist.owner?.display_name || "Spotify playlist"}{(playlist.items?.total ?? playlist.tracks?.total) !== undefined ? `, ${(playlist.items?.total ?? playlist.tracks?.total)!.toLocaleString()} songs` : ""}</small></button>)}</div>
        {!state.playlists.length && <p className="spotifyEmpty">{state.busy ? "Loading your playlists…" : "Your Spotify playlists will show up here."}</p>}
        {state.playlistMore && <button className="secondaryAction spotifyLoadMore" disabled={state.busy} onClick={() => void spotify.morePlaylists()}>Load more playlists</button>}
      </section>}
    </>}
    <p className="spotifyAttribution"><SpotifyMark size={13} />Music and artwork from Spotify. <button className="spotifyTextLink" onClick={() => void spotify.open("https://www.spotify.com/account/apps/")}>Manage account access <ExternalLink size={10} /></button></p>
  </section>;
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Late night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
