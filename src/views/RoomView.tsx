import { Check, ChevronRight, ClipboardPaste, Copy, Crown, ExternalLink, Eye, EyeOff, FolderOpen, Headphones, ListMusic, Lock, LogOut, Network, Pause, Play, Quote, Radio, Radar, RefreshCw, ShieldCheck, Signal, Square, UserX, UsersRound, Volume2, Wifi, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { jamInvite, parseJamAddress } from "../lib/jam";
import { useAudioSelector } from "../lib/useAudio";
import { displayArtist, displayTrackTitle } from "../lib/format";
import { Cover } from "../components/Cover";
import { ConfirmDialog } from "../components/OverlayDialogs";
import { SegmentedTabs } from "../components/SegmentedTabs";
import { audioEngine } from "../lib/audioEngine";
import { navigation } from "../lib/navigation";
import type { DiscoveredRoom, RoomClientStatus, RoomJoinResult, RoomStatus, RoomUser } from "../types";

type Props = {
  onError: (message: string | null) => void;
};

const ROOM_GUIDE_URL = "https://github.com/loavy/LoavyPlayer#room--jam-mode";

export function RoomView({ onError }: Props) {
  const tabsId = useId();
  const [mode, setMode] = useState<"host" | "join">("host");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [kickTarget, setKickTarget] = useState<RoomUser | null>(null);
  const [showHostPassword, setShowHostPassword] = useState(false);
  const [showJoinPassword, setShowJoinPassword] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState("");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const reportError = (message: string | null) => { setRoomError(message); if (!message) onError(null); };
  const operationRef = useRef(false);
  const audio = useAudioSelector((value) => ({ current: value.current, playing: value.playing, blocked: value.localControlBlocked }), (a, b) => a.current === b.current && a.playing === b.playing && a.blocked === b.blocked);
  const [status, setStatus] = useState<RoomStatus | null>(null);
  const [name, setName] = useState("Loavy Room");
  const [password, setPassword] = useState("");
  const [maxUsers, setMaxUsers] = useState(4);
  const [hostPort, setHostPort] = useState(39177);
  const allowGuestQueue = false;
  const [allowGuestControl, setAllowGuestControl] = useState(false);
  const [guestSongDir, setGuestSongDir] = useState("");
  const [discoveredRooms, setDiscoveredRooms] = useState<DiscoveredRoom[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [joinHost, setJoinHost] = useState("");
  const [joinPort, setJoinPort] = useState(39177);
  const [joinName, setJoinName] = useState("Loavy Room");
  const [joinPassword, setJoinPassword] = useState("");
  const [displayName, setDisplayName] = useState(() => { try { return localStorage.getItem("loavy.jamDisplayName")?.slice(0, 48) || "Guest"; } catch { return "Guest"; } });
  const [joinResult, setJoinResult] = useState<RoomJoinResult | null>(null);
  const [clientStatus, setClientStatus] = useState<RoomClientStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState("");
  const refreshRevisionRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const discoveryRevisionRef = useRef(0);
  const discoveryBusyRef = useRef(false);

  async function action(task: () => Promise<void>, label = "Working") {
    if (operationRef.current) return;
    operationRef.current = true; setBusy(true); setOperation(label); reportError(null); setFeedback(null);
    refreshRevisionRef.current++;
    try { await task(); }
    catch (error) { reportError(String(error)); }
    finally { operationRef.current = false; setBusy(false); setOperation(""); }
  }
  function applyInvite(value: string) {
    setJoinHost(value);
    setJoinResult(null);
    try {
      const parsed = parseJamAddress(value);
      if (value.startsWith("loavy://jam?")) setJoinPort(parsed.port);
      if (parsed.roomName) setJoinName(parsed.roomName);
    } catch { /* Allow partial addresses while typing. */ }
  }
  function joinDetails() {
    const parsed = parseJamAddress(joinHost);
    const hasPort = joinHost.trim().startsWith("loavy://jam?") || /^\[[^\]]+\]:\d+$/.test(joinHost.trim()) || /^[^:]+:\d+$/.test(joinHost.trim());
    const port = hasPort ? parsed.port : joinPort;
    const roomName = parsed.roomName || joinName.trim();
    if (!roomName || !displayName.trim() || !joinPassword || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter the invite address, Jam name, password and your display name.");
    return { host: parsed.host, port, roomName, password: joinPassword, displayName: displayName.trim() };
  }
  async function copyInvite(host: string) {
    if (!status?.port || !status.name) return;
    try { await navigator.clipboard.writeText(jamInvite(host, status.port, status.name)); setCopiedAddress(host); setFeedback("Invite copied. Share the password separately."); }
    catch { reportError("Clipboard unavailable. Share the address, Jam name and password manually."); }
  }
  async function pasteInvite() {
    try { const text = await navigator.clipboard.readText(); parseJamAddress(text); applyInvite(text); setFeedback("Invite filled in. Enter the shared password to join."); }
    catch { reportError("Could not read a valid invite from the clipboard. Paste an invite or address into the field below."); }
  }
  async function copyPassword() {
    try { await navigator.clipboard.writeText(password); setFeedback("Password copied. Send it separately from the invite."); }
    catch { reportError("Clipboard unavailable. Share the password manually."); }
  }

  async function openRoomGuide() {
    try {
      await openUrl(ROOM_GUIDE_URL);
    } catch (error) {
      reportError(`Could not open the Room networking guide: ${String(error)}`);
    }
  }

  function refresh(force = false) {
    if (!force && (operationRef.current || refreshInFlightRef.current)) return refreshInFlightRef.current || Promise.resolve();
    const revision = ++refreshRevisionRef.current;
    let request: Promise<void>;
    request = Promise.all([api.getRoomStatus(), api.getRoomClientStatus()])
      .then(([nextStatus, nextClientStatus]) => {
        if (refreshRevisionRef.current !== revision) return;
        setStatus(nextStatus);
        setClientStatus(nextClientStatus);
        setLastChecked(Date.now()); setStatusError(null);
        announceRoomStatus(nextStatus, nextClientStatus);
      })
      .catch((error) => { if (refreshRevisionRef.current === revision) setStatusError(String(error)); throw error; })
      .finally(() => {
        if (refreshInFlightRef.current === request) refreshInFlightRef.current = null;
      });
    refreshInFlightRef.current = request;
    return request;
  }

  useEffect(() => {
    refresh(true).catch((err) => reportError(String(err)));
    api.getDefaultGuestSongFolder()
      .then((folder) => {
        if (folder) setGuestSongDir((current) => current || folder);
      })
      .catch(() => undefined);
    const timer = window.setInterval(() => refresh().catch(() => undefined), 2500);
    return () => {
      window.clearInterval(timer);
      refreshRevisionRef.current += 1;
      refreshInFlightRef.current = null;
      discoveryRevisionRef.current++;
    };
  }, []);
  useEffect(() => { try { localStorage.setItem("loavy.jamDisplayName", displayName); } catch {} }, [displayName]);
  useEffect(() => { if (status && !status.running) { setKickTarget(null); setConfirmStop(false); } }, [status?.running]);

  async function scanNearby() {
    if (discoveryBusyRef.current) return;
    discoveryBusyRef.current = true;
    const revision = ++discoveryRevisionRef.current;
    setDiscovering(true);
    setHasSearched(true);
    reportError(null);
    try {
      const found = await api.discoverRooms();
      if (revision === discoveryRevisionRef.current) setDiscoveredRooms(found);
    } catch (err) {
      if (revision === discoveryRevisionRef.current) { setDiscoveredRooms([]); reportError(String(err)); }
    } finally {
      discoveryBusyRef.current = false;
      if (revision === discoveryRevisionRef.current) setDiscovering(false);
    }
  }

  async function chooseGuestSongFolder() {
    await action(async () => { const folder = await api.selectGuestSongFolder(); if (folder) setGuestSongDir(folder); });
  }

  async function createRoom() {
    if (operationRef.current) return;
    if (!/^[a-z\d _-]{2,48}$/i.test(name.trim())) { reportError("Use 2–48 letters, numbers, spaces, dashes or underscores for the Jam name."); return; }
    if (password.trim().length < 4) { reportError("Choose a password with at least 4 characters."); return; }
    if (!Number.isInteger(maxUsers) || maxUsers < 1 || maxUsers > 32 || !Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) { reportError("Choose 1–32 guests and a port between 1024 and 65535."); return; }
    if (allowGuestControl && !guestSongDir.trim()) {
      reportError("Choose where songs sent by guests should be saved.");
      return;
    }
    operationRef.current = true; refreshRevisionRef.current++; setBusy(true);
    reportError(null);
    try {
      const next = await api.createRoom({
        name,
        password,
        maxUsers,
        allowGuestQueue,
        allowGuestControl,
        guestSongDir: allowGuestControl ? guestSongDir.trim() : null,
        bindAddr: "0.0.0.0",
        port: hostPort
      });
      refreshRevisionRef.current += 1;
      setStatus(next);
      announceRoomStatus(next, clientStatus);
      setCopiedAddress(""); setFeedback("Your Jam is ready. Copy an invite to bring your friends in.");
      if (next.port) setJoinPort(next.port);
      if (next.shareAddr) setJoinHost(next.shareAddr);
      setJoinName(name);
    } catch (err) {
      reportError(String(err));
    } finally {
      operationRef.current = false; setBusy(false);
    }
  }

  async function stopRoom() {
    await action(async () => { await api.stopRoom(); setConfirmStop(false); setPassword(""); setShowHostPassword(false); await refresh(true); setFeedback("Jam ended. See you next time."); }, "Ending");
  }

  async function kickUser(userId: number) {
    await action(async () => { await api.kickRoomUser(userId); setKickTarget(null); await refresh(true); setFeedback("Guest removed from the Jam."); }, "Removing guest");
  }

  async function testJoin() {
    await action(async () => { setJoinResult(null); setJoinResult(await api.joinRoomProbe(joinDetails())); }, "Checking");
  }

  async function joinRoom() {
    await action(async () => {
      setJoinResult(null);
      const result = await api.joinRoom(joinDetails());
      setJoinResult(result);
      await refresh(true);
      if (result.success) setJoinPassword("");
    }, "Joining");
  }

  async function leaveRoom() {
    await action(async () => { await api.leaveRoom(); setJoinResult(null); await refresh(true); setFeedback("You left the Jam."); }, "Leaving");
  }

  function useDiscoveredRoom(room: DiscoveredRoom) {
    setMode("join");
    setJoinHost(room.host.includes(":") ? `[${room.host}]:${room.port}` : room.host);
    setJoinPort(room.port);
    setJoinName(room.name);
    setJoinResult(null);
  }

  const hosting = !!status?.running;
  const connected = !!clientStatus?.connected;
  const live = hosting || connected;
  const canControl = !audio.blocked && (!connected || !!clientStatus?.allowGuestControl);
  const sessionName = hosting ? status?.name : clientStatus?.roomName;
  const listeners: Listener[] = hosting
    ? [{ key: "host", name: "You", detail: "Hosting", role: "host" }, ...(status?.users || []).map((user) => ({ key: `guest-${user.id}`, name: user.displayName, detail: `Joined ${new Date(user.joinedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, role: "guest" as const }))]
    : connected ? [{ key: "host", name: "Host", detail: clientStatus?.host || "Host", role: "host" }, { key: "you", name: clientStatus?.displayName || "You", detail: "You", role: "you" }] : [];
  const addresses = status?.running ? (status.networkAddresses.length ? status.networkAddresses : status.shareAddr && status.port ? [{ interfaceName: "LAN/VPN", address: status.shareAddr, joinAddress: status.localJoin || `${status.shareAddr}:${status.port}` }] : []) : [];
  const pillState = statusError ? "stale" : live ? "live" : "idle";
  const pillText = statusError ? "Status needs a refresh" : hosting ? "Hosting a Jam" : connected ? "Connected to a Jam" : status && clientStatus ? "Ready to connect" : "Checking your connection";
  const pill = <div className="jamConnectionPill" data-state={pillState}><span />{pillText}</div>;

  return (
    <section className="jamView jamRoom" data-mode={mode} data-hosting={hosting} data-connected={connected} data-playing={live && audio.playing} aria-busy={busy}>
      {!live && <header className="jamRoomHeader">
        <div className="jamRoomTitle">
          <h2>Listen together</h2>
          <p>Play the same song at the same moment with friends on your Wi-Fi or VPN.</p>
        </div>
        {pill}
      </header>}

      {roomError && <div className="jamNotice error" role="alert"><span>{roomError}</span><button className="iconButton jamNoticeClose" type="button" aria-label="Dismiss message" onClick={() => reportError(null)}><X size={15} /></button></div>}
      {feedback && <div className="jamNotice" role="status"><Check size={15} /><span>{feedback}</span></div>}
      {statusError && <div className="jamNotice error" role="status"><span>Couldn't refresh room status. {live ? "Showing the last known session." : "Check your connection and retry."}</span><button className="secondaryAction" disabled={busy} onClick={() => void action(() => refresh(true), "Refreshing")}>Refresh status</button></div>}

      {live && <section className="jamStage" aria-label="Live Jam">
        <div className="jamStageBackdrop" aria-hidden="true"><Cover path={audio.current?.coverPath} title={audio.current?.album || undefined} size="lg" /></div>
        <div className="jamRecordWrap" aria-hidden="true">
          <div className="jamRecord"><div className="jamRecordLabel"><Cover path={audio.current?.coverPath} title={audio.current?.album || undefined} size="md" /></div></div>
          <div className="jamSleeve"><Cover path={audio.current?.coverPath} title={audio.current?.album || undefined} size="lg" /></div>
        </div>
        <div className="jamStageInfo">
          <div className="jamStageTop"><span className="jamLiveBadge"><span className="jamEq" aria-hidden="true"><i /><i /><i /></span>Live</span>{pill}</div>
          <h2 className="jamStageName">{sessionName}</h2>
          <p className="jamStageRole">{hosting ? <><Crown size={14} />You're hosting. Everyone hears what you play.</> : <><Headphones size={14} />Listening as {clientStatus?.displayName}, hosted from {clientStatus?.host}</>}</p>
          <div className="jamNowPlaying">
            <small>{audio.current ? audio.playing ? "Playing for everyone" : "Paused for everyone" : "Nothing playing yet"}</small>
            <strong>{audio.current ? displayTrackTitle(audio.current) : hosting ? "Pick a song to start the Jam." : "Waiting for the host to press play."}</strong>
            {audio.current && <span>{displayArtist(audio.current.artist)}</span>}
          </div>
          <div className="jamTransport">
            {canControl && <button className="primaryAction" disabled={!audio.current || busy} aria-label={audio.playing ? "Pause Jam playback" : "Resume Jam playback"} onClick={() => void audioEngine.toggle()}>{audio.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}{audio.playing ? "Pause" : "Play"}</button>}
            {canControl && <button className="secondaryAction" onClick={() => navigation.view("songs")}><ListMusic size={15} />Choose music</button>}
            <button className="secondaryAction" disabled={!audio.current} onClick={() => window.dispatchEvent(new CustomEvent("loavy:open-lyrics"))}><Quote size={15} />Lyrics</button>
          </div>
        </div>
        <div className="jamListeners" aria-label={`${listeners.length} listening`}>
          <div className="jamAvatarStack">{listeners.slice(0, 8).map((person) => <span key={person.key} className="jamAvatar" data-role={person.role} style={avatarStyle(person.name)} title={`${person.name}${person.role === "host" ? " (host)" : ""}`}>{person.role === "host" ? <Crown size={13} /> : initial(person.name)}</span>)}{listeners.length > 8 && <span className="jamAvatar more">+{listeners.length - 8}</span>}</div>
          <span><strong>{listeners.length}</strong> listening{hosting && status?.maxUsers ? `, room for ${Math.max(status.maxUsers - status.connectedUsers, 0)} more` : ""}</span>
          <span className="jamControlChip"><ShieldCheck size={13} />{(hosting ? status?.allowGuestControl : clientStatus?.allowGuestControl) ? "Guests can pick songs" : "Host picks the songs"}</span>
        </div>
      </section>}

      {!live && <SegmentedTabs id={tabsId} className="jamModeSwitch" label="Jam mode" value={mode} onChange={value => { setMode(value); reportError(null); setJoinResult(null); }} panelId={`${tabsId}-${mode}-panel`} options={[{ value: "host", label: "Start a Jam", hint: "Play from your library", icon: <Radio size={18} />, panelId: `${tabsId}-host-panel` }, { value: "join", label: "Join friends", hint: "Listen to someone's Jam", icon: <UsersRound size={18} />, panelId: `${tabsId}-join-panel` }]} />}

      <div className={live ? "jamLiveGrid" : "jamSetupGrid"}>
        <form className="jamCard roomCreatePanel" id={`${tabsId}-host-panel`} role="tabpanel" aria-labelledby={`${tabsId}-host`} hidden={mode !== "host" || live} onSubmit={event => { event.preventDefault(); void createRoom(); }}>
          <header><span className="jamPanelIcon"><Radio size={18} /></span><div><h3>Open your room</h3><p>Name it, lock it, and share the invite.</p></div></header>
          <label className="field"><span>Room name</span><input value={name} maxLength={48} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span>Password</span><div className="jamPasswordInput"><Lock size={15} className="jamFieldIcon" /><input type={showHostPassword ? "text" : "password"} value={password} disabled={busy} autoComplete="off" placeholder="At least 4 characters" onChange={(event) => setPassword(event.target.value)} /><button className="iconButton" type="button" aria-label={showHostPassword ? "Hide Jam password" : "Show Jam password"} aria-pressed={showHostPassword} onClick={() => setShowHostPassword(value => !value)}>{showHostPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button></div><small className="roomFieldHint">Send it separately from the invite.</small></label>
          <label className="jamPermissionCard"><span className="jamPermissionIcon"><ListMusic size={17} /></span><span><strong>Guests can pick songs</strong><small>{allowGuestControl ? "Friends send songs from their own libraries." : "Only you choose what plays."}</small></span><input type="checkbox" role="switch" className="jamSwitch" disabled={busy} checked={allowGuestControl} onChange={(event) => setAllowGuestControl(event.target.checked)} /></label>
          {allowGuestControl && <label className="field"><span>Save guest songs to</span><div className="roomPathPicker"><input value={guestSongDir} onChange={(event) => setGuestSongDir(event.target.value)} placeholder="Music" /><button className="secondaryAction" onClick={() => void chooseGuestSongFolder()} type="button" title="Choose folder"><FolderOpen size={15} />Browse</button></div><small className="roomFieldHint">A guest's song is copied here, then played and streamed to everyone.</small></label>}
          <details className="jamAdvanced"><summary>Connection settings</summary><div className="jamFieldPair"><label className="field"><span>Max guests</span><input type="number" min={1} max={32} value={maxUsers} onChange={(event) => setMaxUsers(Number(event.target.value))} /></label><label className="field"><span>Port</span><input type="number" min={1024} max={65535} value={hostPort} onChange={(event) => setHostPort(Number(event.target.value))} /></label></div></details>
          <div className="settingsActions">
            <button type="submit" className="primaryAction" disabled={busy || !status || !clientStatus || (allowGuestControl && !guestSongDir.trim())}><Radio size={16} />{busy ? "Starting…" : "Start Jam"}</button>
          </div>
        </form>

        <form className="jamCard roomJoinPanel" id={`${tabsId}-join-panel`} role={connected ? undefined : "tabpanel"} aria-labelledby={connected ? undefined : `${tabsId}-join`} hidden={hosting || (mode !== "join" && !connected)} onSubmit={event => { event.preventDefault(); void joinRoom(); }}>
          {connected ? <>
            <header><span className="jamPanelIcon"><Wifi size={18} /></span><div><h3>You're in</h3><p>{clientStatus?.roomName} at {clientStatus?.host}:{clientStatus?.port}</p></div></header>
            <ul className="jamGuestPerks">
              <li><Radio size={15} /><span><strong>{clientStatus?.allowGuestControl ? "Songs are shared" : "The host leads"}</strong><small>{clientStatus?.allowGuestControl ? "Pick songs from your library and everyone hears them." : "Play, pause and song changes follow the host."}</small></span></li>
              <li><Volume2 size={15} /><span><strong>Your volume stays yours</strong><small>Turn it up or down without changing it for anyone else.</small></span></li>
              <li><Quote size={15} /><span><strong>Lyrics follow along</strong><small>Open lyrics to sing along with the room.</small></span></li>
            </ul>
            <div className="settingsActions"><button type="button" className="secondaryAction jamLeaveButton" onClick={leaveRoom} disabled={busy}><LogOut size={15} />{operation === "Leaving" ? "Leaving…" : "Leave Jam"}</button></div>
          </> : <>
            <header><span className="jamPanelIcon"><Radar size={18} /></span><div><h3>Find your friends</h3><p>Search this network, or paste the invite you were sent.</p></div><button type="button" className="secondaryAction roomSearchButton" onClick={() => void scanNearby()} disabled={discovering || busy}><RefreshCw className={discovering ? "spin" : ""} size={14} />{discovering ? "Searching…" : hasSearched ? "Search again" : "Search"}</button></header>
            {discoveredRooms.length ? <div className="nearbyRoomList">{discoveredRooms.map((room) => {
              const selected = joinName === room.name && joinPort === room.port && joinHost.includes(room.host);
              return <button className="nearbyRoom" data-selected={selected} key={`${room.host}:${room.port}`} onClick={() => useDiscoveredRoom(room)} disabled={busy} type="button" aria-pressed={selected}>
                <span className="nearbyRoomIcon"><Radio size={16} /></span>
                <span><strong>{room.name}</strong><small>{room.host}, {room.connectedUsers}{room.maxUsers ? ` of ${room.maxUsers}` : ""} listening</small></span>
                <span className="roomDiscoveryBadge">{room.allowGuestControl ? "Shared songs" : "Host picks"}</span>
                {selected ? <Check size={16} className="nearbyRoomCheck" /> : <ChevronRight size={16} className="nearbyRoomCheck" />}
              </button>;
            })}</div> : <div className="nearbyEmpty">{discovering ? <><span className="jamRadar" aria-hidden="true" />Looking for Jams on this network…</> : hasSearched ? "No Jams found here. Paste an invite below instead." : "Press Search after your friend starts their Jam."}</div>}
            <div className="roomManualDivider"><span>or connect with an invite</span></div>
            <label className="field"><span>Invite or address<button className="jamGuideButton" type="button" disabled={busy} onClick={() => void pasteInvite()}><ClipboardPaste size={13} />Paste invite</button></span><input disabled={busy} value={joinHost} placeholder="loavy://jam?… or 192.168.1.5:39177" onChange={(event) => applyInvite(event.target.value)} /></label>
            <div className="jamFieldPair">
              <label className="field"><span>Password</span><div className="jamPasswordInput"><Lock size={15} className="jamFieldIcon" /><input type={showJoinPassword ? "text" : "password"} value={joinPassword} disabled={busy} autoComplete="off" onChange={(event) => { setJoinPassword(event.target.value); setJoinResult(null); }} /><button className="iconButton" type="button" aria-label={showJoinPassword ? "Hide Jam password" : "Show Jam password"} aria-pressed={showJoinPassword} onClick={() => setShowJoinPassword(value => !value)}>{showJoinPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
              <label className="field"><span>Your name</span><input disabled={busy} maxLength={48} value={displayName} onChange={(event) => { setDisplayName(event.target.value); setJoinResult(null); }} /></label>
            </div>
            <details className="jamAdvanced"><summary>Room name and port</summary><div className="jamFieldPair"><label className="field"><span>Room</span><input disabled={busy} value={joinName} onChange={(event) => { setJoinName(event.target.value); setJoinResult(null); }} /></label><label className="field"><span>Port</span><input type="number" disabled={busy} min={1} max={65535} value={joinPort} onChange={(event) => { setJoinPort(Number(event.target.value)); setJoinResult(null); }} /></label></div></details>
            <div className="settingsActions">
              <button type="submit" className="primaryAction" disabled={busy || !status || !clientStatus || !joinPort}><Headphones size={15} />{operation === "Joining" ? "Joining…" : "Join Jam"}</button>
              <button type="button" className="secondaryAction" onClick={testJoin} disabled={busy || !joinPort}><Wifi size={15} />{operation === "Checking" ? "Checking…" : "Test connection"}</button>
            </div>
            {joinResult && <p className={joinResult.success ? "jamResult ok" : "jamResult"} role="status">{joinResult.success ? <Check size={14} /> : <Signal size={14} />}{joinResult.message}</p>}
          </>}
        </form>

        {!live && <aside className="jamCard jamWelcomePanel">
          <div className="jamOrbitArt" aria-hidden="true"><i /><i /><i /><span><Headphones size={30} /></span>{["Ana", "Leo", "Bia"].map((who) => <b key={who} style={avatarStyle(who)}>{who.slice(0, 1)}</b>)}</div>
          <h3>{mode === "host" ? "Your music, their speakers." : "Pull up a chair."}</h3>
          <p>{mode === "host" ? "Everyone hears the same second of the same song, from your library." : "Find your friend's Jam, enter the password, and you're listening together."}</p>
          <ol className="jamSteps">
            <li><span>1</span><div><strong>Share a network</strong><small>Same Wi-Fi, or the same VPN for friends far away.</small></div></li>
            <li><span>2</span><div><strong>{mode === "host" ? "Send the invite" : "Get the invite"}</strong><small>{mode === "host" ? "Copy it after you start, then send the password on its own." : "Your friend copies it from their Room page."}</small></div></li>
            <li><span>3</span><div><strong>Press play</strong><small>Play, pause and song changes follow the host.</small></div></li>
          </ol>
          <button className="jamGuideButton" type="button" onClick={() => void openRoomGuide()}>Connection help<ExternalLink size={13} /></button>
        </aside>}

        {hosting && <div className="jamCard roomStatusPanel">
          <header><span className="jamPanelIcon"><Copy size={17} /></span><div><h3>Invite friends</h3><p>Copy the invite for the network your friends use.</p></div><button className="secondaryAction jamEndButton" onClick={() => setConfirmStop(true)} disabled={busy}><Square size={12} fill="currentColor" />End Jam</button></header>
          <div className="roomAddressList">
            {addresses.map((entry) => (
              <div className="roomAddressRow" key={`${entry.interfaceName}-${entry.joinAddress}`} data-copied={copiedAddress === entry.address}>
                <span className="jamAddressIcon">{/vpn|tailscale|zerotier|hamachi|wireguard|tun|tap/i.test(entry.interfaceName) ? <Network size={17} /> : <Wifi size={17} />}</span>
                <span><strong>{entry.interfaceName}</strong><small>{entry.joinAddress}</small></span>
                <button className={copiedAddress === entry.address ? "primaryAction" : "secondaryAction"} onClick={() => void copyInvite(entry.address)} title={`Copy ${entry.interfaceName} invite`}>{copiedAddress === entry.address ? <Check size={14} /> : <Copy size={14} />}{copiedAddress === entry.address ? "Copied" : "Copy invite"}</button>
              </div>
            ))}
          </div>
          {!addresses.length && <p className="roomFieldHint">No shareable address yet. Connect to Wi-Fi or your VPN, then refresh.</p>}
          <div className="jamInviteFoot">
            {!!password && <button className="jamGuideButton jamCopyPassword" type="button" onClick={() => void copyPassword()}><Lock size={13} />Copy password</button>}
            <details className="jamNetworkHelp"><summary><Signal size={13} />Friends on another network?</summary><p>Join the same VPN, then copy the invite for that VPN adapter. A public internet IP won't work as an invite.</p><button className="jamGuideButton" type="button" onClick={() => void openRoomGuide()}><ExternalLink size={13} />Open the networking guide</button></details>
          </div>
          {status?.allowGuestControl && status.guestSongDir && <p className="roomFieldHint">Songs from guests are saved to {status.guestSongDir}.</p>}
        </div>}

        {hosting && <div className="jamCard roomUsersPanel">
          <header><span className="jamPanelIcon"><UsersRound size={17} /></span><div><h3>In the room</h3><p>{status!.connectedUsers} {status!.connectedUsers === 1 ? "guest" : "guests"}{status?.maxUsers ? ` of ${status.maxUsers}` : ""}</p></div><span className="jamPeopleCount">{status!.connectedUsers + 1}</span></header>
          <div className="roomUserList">
            <div className="roomUserRow jamHostRow"><span className="jamAvatar" data-role="host" style={avatarStyle("You")}><Crown size={14} /></span><div><strong>You</strong><span>Hosting on this computer</span></div><span className="jamRoleBadge">Host</span></div>
            {status!.users.map((user) => (
              <div className="roomUserRow" key={user.id}>
                <span className="jamAvatar" style={avatarStyle(user.displayName)}>{initial(user.displayName)}</span>
                <div><strong>{user.displayName}</strong><span>Joined {new Date(user.joinedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
                <button className="iconButton jamKickButton" onClick={() => setKickTarget(user)} disabled={busy} title={`Remove ${user.displayName}`} aria-label={`Remove ${user.displayName} from Jam`}><UserX size={15} /></button>
              </div>
            ))}
          </div>
          {!status!.users.length && <div className="jamGuestsEmpty"><strong>Your friends belong here.</strong><p>Send an invite. Names show up the moment they join.</p></div>}
        </div>}
      </div>

      {live && <footer className="jamSessionFooter"><span><Signal size={13} />{statusError ? "Status update unavailable" : lastChecked ? `Status checked at ${new Date(lastChecked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Checking status"}</span><button className="jamGuideButton" disabled={busy} onClick={() => void action(() => refresh(true), "Refreshing")}><RefreshCw size={13} />Refresh status</button></footer>}
      {confirmStop && <ConfirmDialog title="End this Jam?" description="Your friends will be disconnected. Your own playback keeps going." confirmLabel="End Jam" danger busy={busy} onClose={() => !busy && setConfirmStop(false)} onConfirm={() => void stopRoom()} />}
      {kickTarget && <ConfirmDialog title={`Remove ${kickTarget.displayName}?`} description="They'll be disconnected from your Jam. They can rejoin with the invite and password." confirmLabel="Remove guest" danger busy={busy} onClose={() => !busy && setKickTarget(null)} onConfirm={() => void kickUser(kickTarget.id)} />}
    </section>
  );
}

type Listener = { key: string; name: string; detail: string; role: "host" | "guest" | "you" };

function initial(name: string) {
  return [...name.trim()][0]?.toLocaleUpperCase() || "?";
}

/** A stable warm hue per name, so each friend keeps the same color between sessions. */
function avatarStyle(name: string): CSSProperties {
  const hue = [...name].reduce((hash, letter) => (hash * 31 + letter.charCodeAt(0)) % 360, 7);
  return { "--avatar-hue": hue } as CSSProperties;
}

function announceRoomStatus(status: RoomStatus, clientStatus: RoomClientStatus | null) {
  window.dispatchEvent(new CustomEvent("loavy:room-status", {
    detail: {
      hostRunning: status.running,
      client: {
        connected: Boolean(clientStatus?.connected),
        allowGuestControl: Boolean(clientStatus?.allowGuestControl),
        host: clientStatus?.host || null,
        port: clientStatus?.port || null
      }
    }
  }));
}
