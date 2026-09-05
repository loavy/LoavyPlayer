import { Copy, ExternalLink, FolderOpen, LogOut, Radio, Radar, RefreshCw, ShieldCheck, Square, UserX, UsersRound, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import type { DiscoveredRoom, RoomClientStatus, RoomJoinResult, RoomStatus } from "../types";

type Props = {
  onError: (message: string | null) => void;
};

const ROOM_GUIDE_URL = "https://github.com/loavy/LoavyPlayer#room--jam-mode";

export function RoomView({ onError }: Props) {
  const [status, setStatus] = useState<RoomStatus | null>(null);
  const [name, setName] = useState("Loavy Room");
  const [password, setPassword] = useState("");
  const [maxUsers, setMaxUsers] = useState(4);
  const [hostPort, setHostPort] = useState(39177);
  const [allowGuestQueue, setAllowGuestQueue] = useState(true);
  const [allowGuestControl, setAllowGuestControl] = useState(false);
  const [guestSongDir, setGuestSongDir] = useState("");
  const [discoveredRooms, setDiscoveredRooms] = useState<DiscoveredRoom[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [joinHost, setJoinHost] = useState("127.0.0.1");
  const [joinPort, setJoinPort] = useState(0);
  const [joinName, setJoinName] = useState("Loavy Room");
  const [joinPassword, setJoinPassword] = useState("");
  const [displayName, setDisplayName] = useState("Guest");
  const [joinResult, setJoinResult] = useState<RoomJoinResult | null>(null);
  const [clientStatus, setClientStatus] = useState<RoomClientStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshRevisionRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  async function openRoomGuide() {
    try {
      await openUrl(ROOM_GUIDE_URL);
    } catch (error) {
      onError(`Could not open the Room networking guide: ${String(error)}`);
    }
  }

  function refresh(force = false) {
    if (!force && refreshInFlightRef.current) return refreshInFlightRef.current;
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
    refresh(true).catch((err) => onError(String(err)));
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
    onError(null);
    try {
      setDiscoveredRooms(await api.discoverRooms());
    } catch (err) {
      setDiscoveredRooms([]);
      onError(String(err));
    } finally {
      setDiscovering(false);
    }
  }

  async function chooseGuestSongFolder() {
    const folder = await api.selectGuestSongFolder();
    if (folder) setGuestSongDir(folder);
  }

  async function createRoom() {
    if (allowGuestControl && !guestSongDir.trim()) {
      onError("Choose where songs sent by guests should be saved.");
      return;
    }
    setBusy(true);
    onError(null);
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
      onError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stopRoom() {
    await api.stopRoom();
    await refresh(true);
  }

  async function kickUser(userId: number) {
    onError(null);
    try {
      await api.kickRoomUser(userId);
      await refresh(true);
    } catch (err) {
      onError(String(err));
    }
  }

  async function testJoin() {
    setBusy(true);
    onError(null);
    try {
      setJoinResult(await api.joinRoomProbe({
        host: joinHost,
        port: joinPort,
        roomName: joinName,
        password: joinPassword,
        displayName
      }));
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom() {
    setBusy(true);
    onError(null);
    try {
      const result = await api.joinRoom({
        host: joinHost,
        port: joinPort,
        roomName: joinName,
        password: joinPassword,
        displayName
      });
      setJoinResult(result);
      await refresh(true);
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function leaveRoom() {
    onError(null);
    try {
      await api.leaveRoom();
      setJoinResult({ success: true, message: "Left room.", playback: null });
      await refresh(true);
    } catch (err) {
      onError(String(err));
    }
  }

  function useDiscoveredRoom(room: DiscoveredRoom) {
    setJoinHost(room.host);
    setJoinPort(room.port);
    setJoinName(room.name);
    setJoinResult(null);
  }

  return (
    <section className="roomLayout">
      <div className="roomIntro">
        <div className="roomIntroIcon"><Radio size={24} /></div>
        <div className="roomIntroCopy">
          <span className="roomEyebrow">Room & Jam Mode</span>
          <h2>Listen together, from your own libraries.</h2>
          <p>Start a private room over LAN or VPN. Loavy keeps playback synchronized and can securely copy guest-selected songs to the host.</p>
        </div>
        <div className="roomFeaturePills">
          <span><Radar size={14} /> Nearby discovery</span>
          <span><ShieldCheck size={14} /> Password protected</span>
        </div>
      </div>

      <div className="settingsPanel roomCreatePanel">
        <header><Radio size={19} /><h2>Create room</h2></header>
        <p className="roomPanelIntro">Host a session from this computer and choose what guests are allowed to control.</p>
        <label className="field"><span>Room name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label className="field"><span>Max users</span><input type="number" min={1} max={32} value={maxUsers} onChange={(event) => setMaxUsers(Number(event.target.value))} /></label>
        <label className="field"><span>Port</span><input type="number" min={1024} max={65535} value={hostPort} onChange={(event) => setHostPort(Number(event.target.value))} /></label>
        <label className="toggleRow"><span>Guests can suggest queue</span><input type="checkbox" checked={allowGuestQueue} onChange={(event) => setAllowGuestQueue(event.target.checked)} /></label>
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
          <button className="primaryAction" onClick={createRoom} disabled={busy || (allowGuestControl && !guestSongDir.trim())}><Wifi size={17} /> Start room</button>
          <button className="secondaryAction" onClick={stopRoom} disabled={!status?.running}><Square size={15} /> Stop room</button>
        </div>
      </div>

      <div className="settingsPanel roomStatusPanel">
        <header><UsersRound size={19} /><h2>Room status</h2></header>
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
                  <button className="secondaryAction" onClick={() => void navigator.clipboard.writeText(entry.joinAddress)} title={`Copy ${entry.interfaceName} address`}>
                    <Copy size={16} /> Copy
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
                <button className="secondaryAction dangerAction" onClick={() => void kickUser(user.id)} title="Kick user">
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
        <header><Wifi size={19} /><h2>Join room</h2></header>
        <p className="roomPanelIntro">Search once for rooms visible on this LAN/VPN, or enter the host's VPN address manually.</p>
        {clientStatus?.connected && (
          <div className="roomConnectedBanner">
            <strong>Connected as {clientStatus.displayName}</strong>
            <span>{clientStatus.roomName} at {clientStatus.host}:{clientStatus.port} - local match or host stream</span>
          </div>
        )}
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
        <label className="field"><span>Host</span><input value={joinHost} onChange={(event) => setJoinHost(event.target.value)} /></label>
        <label className="field"><span>Port</span><input type="number" value={joinPort} onChange={(event) => setJoinPort(Number(event.target.value))} /></label>
        <label className="field"><span>Room</span><input value={joinName} onChange={(event) => setJoinName(event.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} /></label>
        <label className="field"><span>Name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <div className="settingsActions">
          <button className="secondaryAction" onClick={testJoin} disabled={busy || !joinPort || clientStatus?.connected}><Wifi size={17} /> Check only</button>
          <button className="primaryAction" onClick={joinRoom} disabled={busy || !joinPort || clientStatus?.connected}><Wifi size={17} /> Join room</button>
          <button className="secondaryAction" onClick={leaveRoom} disabled={!clientStatus?.connected}><LogOut size={17} /> Leave</button>
        </div>
        {joinResult && <p className={joinResult.success ? "scanSummary" : "muted"}>{joinResult.message}</p>}
      </div>
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
