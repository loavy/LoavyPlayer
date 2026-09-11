export function parseJamAddress(value: string): { host: string; port: number; roomName?: string } {
  const text = value.trim();
  if (!text) throw new Error("Paste an invite or enter your friend's address.");
  let host: string, port: number, roomName: string | undefined;
  if (text.startsWith("loavy://jam?")) {
    const url = new URL(text);
    host = url.searchParams.get("host") || "";
    port = Number(url.searchParams.get("port"));
    roomName = url.searchParams.get("room") || undefined;
  } else {
    const match = text.match(/^\[([^\]]+)\](?::(\d+))?$/) || text.match(/^([^:/\s]+)(?::(\d+))?$/);
    if (!match) throw new Error("Use a host address, host:port, or a Loavy Jam invite.");
    host = match[1]; port = match[2] ? Number(match[2]) : 39177;
  }
  if (!host || /[\s/?#@]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The invite needs a valid host and port (1–65535).");
  return { host: host.replace(/^\[|\]$/g, ""), port, roomName };
}

export function jamInvite(host: string, port: number, room: string) {
  return `loavy://jam?${new URLSearchParams({ host, port: String(port), room })}`;
}
