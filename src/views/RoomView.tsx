import { Copy, Radio, ShieldAlert, Square, UserX, UsersRound, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { RoomJoinResult, RoomStatus } from "../types";

type Props = {
  onError: (message: string | null) => void;
};

export function RoomView({ onError }: Props) {
  const [status, setStatus] = useState<RoomStatus | null>(null);
  const [name, setName] = useState("Loavy Room");
  const [password, setPassword] = useState("");
  const [maxUsers, setMaxUsers] = useState(4);
  const [hostPort, setHostPort] = useState(39177);
  const [allowGuestQueue, setAllowGuestQueue] = useState(true);
  const [joinHost, setJoinHost] = useState("127.0.0.1");
  const [joinPort, setJoinPort] = useState(0);
  const [joinName, setJoinName] = useState("Loavy Room");
  const [joinPassword, setJoinPassword] = useState("");
  const [displayName, setDisplayName] = useState("Guest");
  const [joinResult, setJoinResult] = useState<RoomJoinResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setStatus(await api.getRoomStatus());
  }

  useEffect(() => {
    refresh().catch((err) => onError(String(err)));
    const timer = window.setInterval(() => refresh().catch(() => undefined), 2500);
    return () => window.clearInterval(timer);
  }, []);

  async function createRoom() {
    setBusy(true);
    onError(null);
    try {
      const next = await api.createRoom({
        name,
        password,
        maxUsers,
        allowGuestQueue,
        bindAddr: "0.0.0.0",
        port: hostPort
      });
      setStatus(next);
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
    await refresh();
  }

  async function kickUser(userId: number) {
    onError(null);
    try {
      await api.kickRoomUser(userId);
      await refresh();
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

  const localJoinInfo = status?.running ? `${status.localJoin || `${status.shareAddr}:${status.port}`} / ${status.name}` : "";
  const publicJoinInfo = status?.running && status.publicJoin ? `${status.publicJoin} / ${status.name}` : "";

  return (
    <section className="roomLayout">
      <div className="settingsPanel">
        <header><Radio size={19} /><h2>Create room</h2></header>
        <label className="field"><span>Room name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label className="field"><span>Max users</span><input type="number" min={1} max={32} value={maxUsers} onChange={(event) => setMaxUsers(Number(event.target.value))} /></label>
        <label className="field"><span>Port</span><input type="number" min={1024} max={65535} value={hostPort} onChange={(event) => setHostPort(Number(event.target.value))} /></label>
        <label className="toggleRow"><span>Guests can add to queue</span><input type="checkbox" checked={allowGuestQueue} onChange={(event) => setAllowGuestQueue(event.target.checked)} /></label>
        <div className="settingsActions">
          <button className="primaryAction" onClick={createRoom} disabled={busy}><Wifi size={17} /> Start room</button>
          <button className="secondaryAction" onClick={stopRoom} disabled={!status?.running}><Square size={15} /> Stop room</button>
        </div>
      </div>

      <div className="settingsPanel">
        <header><UsersRound size={19} /><h2>Room status</h2></header>
        {status?.running ? (
          <>
            <div className="roomStatusGrid">
              <span>Name</span><strong>{status.name}</strong>
              <span>LAN/VPN</span><strong>{localJoinInfo}</strong>
              <span>Public</span><strong>{publicJoinInfo || "Unavailable"}</strong>
              <span>Users</span><strong>{status.connectedUsers}{status.maxUsers ? ` / ${status.maxUsers}` : ""}</strong>
              <span>Guest queue</span><strong>{status.allowGuestQueue ? "Allowed" : "Host only"}</strong>
            </div>
            <div className="settingsActions">
              <button className="secondaryAction" onClick={() => void navigator.clipboard.writeText(localJoinInfo)}><Copy size={17} /> Copy LAN/VPN</button>
              <button className="secondaryAction" onClick={() => void navigator.clipboard.writeText(publicJoinInfo || localJoinInfo)}><Copy size={17} /> Copy public</button>
            </div>
            <div className="roomWarning">
              <ShieldAlert size={17} />
              <p>For people on another internet connection, forward TCP port {status.port} on your router to this PC, or use Tailscale, ZeroTier, Radmin VPN, or similar. Do not expose the room publicly unless you trust the people joining.</p>
            </div>
            <p className="muted">Control sync is active. Audio streaming endpoints are reserved for the next pass.</p>
          </>
        ) : (
          <p className="muted">No room is running.</p>
        )}
      </div>

      <div className="settingsPanel">
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

      <div className="settingsPanel">
        <header><Wifi size={19} /><h2>Join test</h2></header>
        <label className="field"><span>Host</span><input value={joinHost} onChange={(event) => setJoinHost(event.target.value)} /></label>
        <label className="field"><span>Port</span><input type="number" value={joinPort} onChange={(event) => setJoinPort(Number(event.target.value))} /></label>
        <label className="field"><span>Room</span><input value={joinName} onChange={(event) => setJoinName(event.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} /></label>
        <label className="field"><span>Name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <button className="primaryAction" onClick={testJoin} disabled={busy || !joinPort}><Wifi size={17} /> Test join</button>
        {joinResult && <p className={joinResult.success ? "scanSummary" : "muted"}>{joinResult.message}</p>}
      </div>
    </section>
  );
}
