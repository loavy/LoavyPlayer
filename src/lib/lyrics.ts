export type TimedWord = { at: number; text: string };
export type TimedLine = { at: number; text: string; key: string; words?: TimedWord[]; wordEnd?: number };
export type WaveWord = { text: string; at: number; end: number };
function timestamp(tag: string) { const match = tag.match(/^(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?$/); return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 + Number((match[3] || "0").padEnd(3, "0")) : 0; }

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
    const content = line.replace(/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/g, "").trim();
    const tags = [...content.matchAll(/<(\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?)>/g)];
    const text = content.replace(/<\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?>/g, "").trim();
    const firstAt = timestamp(matches[0][0].slice(1, -1));
    const segments: TimedWord[] = [];
    const prefix = content.slice(0, tags[0]?.index || 0);
    if (prefix.trim()) segments.push({ at: firstAt, text: prefix });
    tags.forEach((tag, index) => {
      const text = content.slice(tag.index! + tag[0].length, tags[index + 1]?.index ?? content.length);
      if (text.trim()) segments.push({ at: timestamp(tag[1]), text });
    });
    const validWords = tags.length > 0 && segments.length > 0 && segments.every((word, index) => word.at >= firstAt && (index === 0 || word.at >= segments[index - 1].at)) && tags.every((tag, index) => index === 0 || timestamp(tag[1]) >= timestamp(tags[index - 1][1]));
    const lastTag = tags[tags.length - 1];
    const hasEnd = lastTag && !content.slice(lastTag.index! + lastTag[0].length).trim();
    matches.forEach((match, matchIndex) => {
      const rawAt = timestamp(match[0].slice(1, -1)), delta = rawAt - firstAt;
      lines.push({ at: Math.max(0, rawAt - offset), text, key: `${sourceIndex}-${matchIndex}`,
        ...(validWords ? { words: segments.map(word => ({ ...word, at: Math.max(0, word.at + delta - offset) })), ...(hasEnd ? { wordEnd: Math.max(0, timestamp(lastTag[1]) + delta - offset) } : {}) } : {}) });
    });
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
  return text.replace(/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]|<\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?>/g, tag => { const shifted = lyricTimestamp(Math.max(0, timestamp(tag.slice(1, -1)) + delta)); return tag.startsWith("<") ? `<${shifted.slice(1, -1)}>` : shifted; });
}

/** Fine timestamps take precedence; ordinary LRC uses an explicitly estimated sweep. */
export function lyricWaveWords(line: TimedLine, lineEnd: number): WaveWord[] {
  const end = Math.max(line.at + 1, lineEnd);
  const segments = line.words?.length && line.words.every(word => word.at < end) ? line.words : [{ at: line.at, text: line.text }];
  const words: WaveWord[] = [];
  const stops: number[] = [];
  let next = line.wordEnd ?? end;
  for (let index = segments.length - 1; index >= 0; index--) { if (index < segments.length - 1 && segments[index + 1].at > segments[index].at) next = segments[index + 1].at; stops[index] = next; }
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment.at >= end) continue;
    const stop = Math.max(segment.at + 1, Math.min(end, stops[index]));
    const parts = segment.text.match(/\S+\s*/gu) || [];
    const weights = parts.map(part => Math.max(1, [...part.trim()].length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsed = 0;
    parts.forEach((text, i) => { const start = segment.at + (stop - segment.at) * elapsed / total; elapsed += weights[i]; words.push({ text, at: start, end: segment.at + (stop - segment.at) * elapsed / total }); });
  }
  // Trimming the ends matches the rendered line without losing spaces between words.
  if (words.length) { words[0].text = words[0].text.trimStart(); words[words.length - 1].text = words[words.length - 1].text.trimEnd(); }
  return words;
}

export function plainLyrics(text: string): string {
  return text.split(/\r?\n/).filter(line => !/^\s*\[(?:ar|al|ti|au|by|re|ve|length|offset):[^\]]*\]\s*$/i.test(line))
    .map(line => line.replace(/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/g, "").replace(/<\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?>/g, "").trim()).join("\n").trim();
}
