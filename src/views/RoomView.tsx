import { Copy, ExternalLink, FolderOpen, LogOut, Radio, Radar, RefreshCw, ShieldCheck, Square, UserX, UsersRound, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { jamInvite, parseJamAddress } from "../lib/jam";
import { useAudioSelector } from "../lib/useAudio";
import { displayArtist, displayTrackTitle } from "../lib/format";
import { Cover } from "../components/Cover";
import { ConfirmDialog } from "../components/OverlayDialogs";
import type { DiscoveredRoom, RoomClientStatus, RoomJoinResult, RoomStatus } from "../types";

type Props = {
  onError: (message: string | null) => void;
};

const ROOM_GUIDE_URL = "https://github.com/loavy/LoavyPlayer#room--jam-mode";

export function RoomView({ onError }: Props) {
  const [mode, setMode] = useState<"host" | "join">("host");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const reportError = (message: string | null) => { setRoomError(message); if (!message) onError(null); };
  const operationRef = useRef(false);
  const audio = useAudioSelector((value) => ({ current: value.current, playing: value.playing }), (a, b) => a.current === b.current && a.playing === b.playing);
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
  const [displayName, setDisplayName] = useState("Guest");
  const [joinResult, setJoinResult] = useState<RoomJoinResult | null>(null);
  const [clientStatus, setClientStatus] = useState<RoomClientStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshRevisionRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  async function action(task: () => Promise<void>) {
    if (operationRef.current) return;
    operationRef.current = true; setBusy(true); reportError(null); setFeedback(null);
    refreshRevisionRef.current++;
    try { await task(); }
    catch (error) { reportError(String(error)); }
    finally { operationRef.current = false; setBusy(false); }
  }
  function applyInvite(value: string) {
    setJoinHost(value);
    try {
      const parsed = parseJamAddress(value);
      if (value.startsWith("loavy://jam?")) setJoinPort(parsed.port);
      if (parsed.roomName) setJoinName(parsed.roomName);
    } catch { /* Allow partial addresses while typing. */ }
  }
  function joinDetails() {
    const parsed = parseJamAddress(joinHost);
    const port = joinHost.includes(":") ? parsed.port : joinPort;
    const roomName = parsed.roomName || joinName.trim();
    if (!roomName || !displayName.trim() || !joinPassword || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter the invite address, Jam name, password and your display name.");
    return { host: parsed.host, port, roomName, password: joinPassword, displayName: displayName.trim() };
  }
  async function copyInvite(host: string) {
    try { await navigator.clipboard.writeText(jamInvite(host, status!.port!, status!.name!)); setFeedback("Invite copied. Share the password separately."); }
    catch { reportError("Clipboard unavailable. Share the address, Jam name and password manually."); }
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
        announceRoomStatus(nextStatus, nextClientStatus);
      })
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
    };
  }, []);

  async function scanNearby() {
    setDiscovering(true);
    setHasSearched(true);
    reportError(null);
    try {
      setDiscoveredRooms(await api.discoverRooms());
    } catch (err) {
      setDiscoveredRooms([]);
      reportError(String(err));
    } finally {
      setDiscovering(false);
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
    await action(async () => { await api.stopRoom(); setConfirmStop(false); await refresh(true); setFeedback("Jam ended. See you next time."); });
  }

  async function kickUser(userId: number) {
    await action(async () => { await api.kickRoomUser(userId); await refresh(true); });
  }

  async function testJoin() {
    await action(async () => { setJoinResult(null); setJoinResult(await api.joinRoomProbe(joinDetails())); });
  }

  async function joinRoom() {
    await action(async () => {
      setJoinResult(null);
      const result = await api.joinRoom(joinDetails());
      setJoinResult(result);
      await refresh(true);
    });
  }

  async function leaveRoom() {
    await action(async () => { await api.leaveRoom(); setJoinResult(null); await refresh(true); setFeedback("You left the Jam."); });
  }

  function useDiscoveredRoom(room: DiscoveredRoom) {
    setMode("join");
    setJoinHost(room.host.includes(":") ? `[${room.host}]:${room.port}` : room.host);
    setJoinPort(room.port);
    setJoinName(room.name);
    setJoinResult(null);
  }

  return (
    <section className="roomLayout jamView" data-mode={mode} data-hosting={!!status?.running} data-connected={!!clientStatus?.connected}>
      <div className="roomIntro">
        <div className="roomIntroIcon"><Radio size={24} /></div>
        <div className="roomIntroCopy">
          <span className="roomEyebrow">BETTER TOGETHER · JAM</span>
          <h2>Same song. Same moment.</h2>
          <p>A private listening session for you and your friends, on the same Wi-Fi or VPN.</p>
        </div>
        <div className="roomFeaturePills">
          <span><Radar size={14} /> Nearby discovery</span>
          <span><ShieldCheck size={14} /> Password protected</span>
        </div>
      </div>
      {roomError && <div className="jamNotice error" role="alert">{roomError}<button className="secondaryAction" onClick={() => void action(() => refresh(true))} disabled={busy}>Retry status</button></div>}
      {feedback && <div className="jamNotice" role="status">{feedback}</div>}
      {!status?.running && !clientStatus?.connected && <div className="jamModeSwitch" role="group" aria-label="Jam mode"><button aria-pressed={mode === "host"} onClick={() => setMode("host")}><Radio size={17} /> Start a Jam</button><button aria-pressed={mode === "join"} onClick={() => setMode("join")}><UsersRound size={17} /> Join friends</button></div>}
      {(status?.running || clientStatus?.connected) && <section className="jamLiveCard"><div><span className="jamLiveBadge">LIVE JAM</span><h3>{status?.running ? status.name : clientStatus?.roomName}</h3><p>{status?.running ? `You're hosting · ${status.connectedUsers} friends connected` : `Joined as ${clientStatus?.displayName}`}</p></div><div className="jamNowPlaying"><Cover path={audio.current?.coverPath} size="md" /><div><small>{audio.current ? audio.playing ? "LISTENING TOGETHER" : "PAUSED" : "READY WHEN YOU ARE"}</small><strong>{audio.current ? displayTrackTitle(audio.current) : "Your next favorite moment"}</strong><span>{audio.current ? displayArtist(audio.current.artist) : "Choose a song from the host's library to get started."}</span></div></div></section>}

      <div className="settingsPanel roomCreatePanel">
        <header><Radio size={19} /><h2>Start a Jam</h2></header>
        <p className="roomPanelIntro">Host a session from this computer and choose what guests are allowed to control.</p>
        <label className="field"><span>Room name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <details className="jamAdvanced"><summary>Connection settings</summary>
        <label className="field"><span>Max users</span><input type="number" min={1} max={32} value={maxUsers} onChange={(event) => setMaxUsers(Number(event.target.value))} /></label>
        <label className="field"><span>Port</span><input type="number" min={1024} max={65535} value={hostPort} onChange={(event) => setHostPort(Number(event.target.value))} /></label>
        </details>
        <label className="toggleRow"><span>Guests can change songs</span><input type="checkbox" checked={allowGuestControl} onChange={(event) => setAllowGuestControl(event.target.checked)} /></label>
        {allowGuestControl && (
          <>
            <label className="field">
              <span>Save guest songs</span>
              <div className="roomPathPicker">
                <input value={guestSongDir} onChange={(event) => setGuestSongDir(event.target.value)} placeholder="Music" />
                <button className="secondaryAction" onClick={() => void chooseGuestSongFolder()} type="button" title="Choose folder">
                  <FolderOpen size={17} /> Browse
                </button>
              </div>
            </label>
            <p className="muted roomFieldHint">A guest's selected audio file is copied here, then played by the host and streamed to everyone.</p>
          </>
        )}
        <div className="settingsActions">
          <button className="primaryAction" onClick={createRoom} disabled={busy || !status || !clientStatus || (allowGuestControl && !guestSongDir.trim())}><Wifi size={17} />{busy ? "Starting…" : "Start Jam"}</button>
        </div>
      </div>

      <div className="settingsPanel roomStatusPanel">
        <header><UsersRound size={19} /><h2>Invite your friends</h2><button className="secondaryAction" onClick={() => setConfirmStop(true)} disabled={busy}><Square size={15} /> End Jam</button></header>
        {status?.running ? (
          <>
            <div className="roomStatusGrid">
              <span>Name</span><strong>{status.name}</strong>
              <span>Users</span><strong>{status.connectedUsers}{status.maxUsers ? ` / ${status.maxUsers}` : ""}</strong>
              <span>Guest control</span><strong>{status.allowGuestControl ? "Allowed" : "Host only"}</strong>
              {status.guestSongDir && <><span>Guest songs</span><strong>{status.guestSongDir}</strong></>}
            </div>
            <div className="roomAddressHeading">Addresses your friends can use</div>
            <div className="roomAddressList">
              {(status.networkAddresses.length ? status.networkAddresses : [{
                interfaceName: "LAN/VPN",
                address: status.shareAddr || "127.0.0.1",
                joinAddress: status.localJoin || `${status.shareAddr}:${status.port}`
              }]).map((entry) => (
                <div className="roomAddressRow" key={`${entry.interfaceName}-${entry.joinAddress}`}>
                  <span>
                    <strong>{entry.interfaceName}</strong>
                    <small>{entry.joinAddress}</small>
                  </span>
                  <button className="secondaryAction" onClick={() => void copyInvite(entry.address)} title={`Copy ${entry.interfaceName} invite`}>
                    <Copy size={16} /> Copy invite
                  </button>
                </div>
              ))}
            </div>
            <div className="roomWarning">
              <ShieldCheck size={17} />
              <p>For a friend outside your home network, both computers should join the same VPN. Send them the address belonging to that VPN adapter—not your public internet IP.</p>
            </div>
            <a className="guideLink" href={ROOM_GUIDE_URL} onClick={(event) => {
              event.preventDefault();
              void openRoomGuide();
            }}>
              <ExternalLink size={16} /> Open the full Room networking guide
            </a>
            <p className="muted">When guest control is on, a guest's selected file is saved on this computer before the host streams it to the room.</p>
          </>
        ) : (
          <p className="muted">No room is running.</p>
        )}
      </div>

      <div className="settingsPanel roomUsersPanel">
        <header><UsersRound size={19} /><h2>Connected users</h2></header>
        {status?.running && status.users.length ? (
          <div className="roomUserList">
            {status.users.map((user) => (
              <div className="roomUserRow" key={user.id}>
                <div>
                  <strong>{user.displayName}</strong>
                  <span>{user.remoteAddr} - joined {new Date(user.joinedAt).toLocaleTimeString()}</span>
                </div>
                <button className="secondaryAction dangerAction" onClick={() => void kickUser(user.id)} disabled={busy} title="Kick user">
                  <UserX size={16} /> Kick
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">{status?.running ? "No guests connected yet." : "Start a room to see connected users."}</p>
        )}
      </div>

      <div className="settingsPanel roomJoinPanel">
        <header><Wifi size={19} /><h2>{clientStatus?.connected ? "You're connected" : "Join your friends"}</h2></header>
        <p className="roomPanelIntro">{clientStatus?.connected ? clientStatus.allowGuestControl ? "You can choose songs from your library to share with everyone." : "The host controls playback. Set your own volume and enjoy the music." : "Find a nearby Jam, or paste the invite your friend shared."}</p>
        {clientStatus?.connected && (
          <div className="roomConnectedBanner">
            <strong>Connected as {clientStatus.displayName}</strong>
            <span>{clientStatus.roomName} at {clientStatus.host}:{clientStatus.port} - local match or host stream</span>
          </div>
        )}
        <div className="jamJoinSetup" hidden={!!clientStatus?.connected}>
        <div className="nearbyRoomsHeader">
          <span><Radar size={16} /> Rooms nearby</span>
          <button className="secondaryAction roomSearchButton" onClick={() => void scanNearby()} disabled={discovering}>
            <RefreshCw className={discovering ? "spin" : ""} size={15} />
            {discovering ? "Searching..." : hasSearched ? "Search again" : "Search"}
          </button>
        </div>
        {discoveredRooms.length ? (
          <div className="nearbyRoomList">
            {discoveredRooms.map((room) => (
              <button
                className="nearbyRoom"
                key={`${room.host}:${room.port}`}
                onClick={() => useDiscoveredRoom(room)}
                type="button"
              >
                <span>
                  <strong>{room.name}</strong>
                  <small>{room.host}:{room.port} · {room.connectedUsers}{room.maxUsers ? ` / ${room.maxUsers}` : ""} guests</small>
                </span>
                <span className="roomDiscoveryBadge">{room.allowGuestControl ? "Guest songs on" : "Host controls"}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="muted nearbyEmpty">
            {discovering
              ? "Looking on your LAN/VPN..."
              : hasSearched
                ? "No rooms found. You can still connect manually below."
                : "Search when your friend has started their room."}
          </p>
        )}
        <div className="roomManualDivider"><span>Manual connection</span></div>
        <label className="field"><span>Invite or host address</span><input value={joinHost} placeholder="Paste a Jam invite or host:port" onChange={(event) => applyInvite(event.target.value)} /></label>
        <label className="field"><span>Port</span><input type="number" value={joinPort} onChange={(event) => setJoinPort(Number(event.target.value))} /></label>
        <label className="field"><span>Room</span><input value={joinName} onChange={(event) => setJoinName(event.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} /></label>
        <label className="field"><span>Name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        </div>
        <div className="settingsActions">
          <button className="secondaryAction" onClick={testJoin} disabled={busy || !joinPort || clientStatus?.connected}><Wifi size={17} /> Check only</button>
          <button className="primaryAction" onClick={joinRoom} disabled={busy || !status || !clientStatus || !joinPort || clientStatus?.connected}><Wifi size={17} /> Join Jam</button>
          <button className="secondaryAction" onClick={leaveRoom} disabled={busy || !clientStatus?.connected}><LogOut size={17} /> Leave Jam</button>
        </div>
        {joinResult && <p className={joinResult.success ? "scanSummary" : "muted"}>{joinResult.message}</p>}
      </div>
      {confirmStop && <ConfirmDialog title="End this Jam?" description="Your friends will be disconnected. Your local playback will continue." confirmLabel="End Jam" danger busy={busy} onClose={() => !busy && setConfirmStop(false)} onConfirm={() => void stopRoom()} />}
    </section>
  );
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
