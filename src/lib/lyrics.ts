export type TimedLine = { at: number; text: string; key: string };

export function lrcOffset(value: string): number {
  const tags = [...value.matchAll(/^\s*\[offset:([+-]?\d+)\]\s*$/gim)];
  const offset = Number(tags[tags.length - 1]?.[1] || 0);
  return Number.isSafeInteger(offset) ? offset : 0;
}

export function parseLrc(value: string): TimedLine[] {
  const lines: TimedLine[] = [];
  const offset = lrcOffset(value);
  value.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line, sourceIndex) => {
    const matches = [...line.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)];
    if (!matches.length) return;
    const text = line.replace(/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/g, "").replace(/<\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?>/g, "").trim();
    matches.forEach((match, matchIndex) => lines.push({
      at: Math.max(0, (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number((match[3] || "0").padEnd(3, "0")) - offset),
      text, key: `${sourceIndex}-${matchIndex}`
    }));
  });
  return lines.sort((a, b) => a.at - b.at);
}

export function activeLyricIndex(lines: TimedLine[], position: number): number {
  let low = 0, high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle].at <= position) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function lyricTimestamp(position: number): string {
  const centiseconds = Math.max(0, Math.round(position / 10));
  return `[${String(Math.floor(centiseconds / 6000)).padStart(2, "0")}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}]`;
}

export function shiftLyrics(text: string, delta: number): string {
  return text.replace(/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/g, tag => lyricTimestamp(Math.max(0, parseLrc(tag)[0].at + delta)));
}

export function plainLyrics(text: string): string {
  return text.split(/\r?\n/).filter(line => !/^\s*\[(?:ar|al|ti|au|by|re|ve|length|offset):[^\]]*\]\s*$/i.test(line))
    .map(line => line.replace(/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/g, "").replace(/<\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?>/g, "").trim()).join("\n").trim();
}
