import { lrcOffset, lyricTimestamp, lyricWaveWords, parseLrc, plainLyrics, shiftLyrics, type TimedLine } from "./lyrics";

export type EditableLyricLine = { sourceIndex: number; line: TimedLine; end: number; timed: boolean };

/** Keep source line indexes so edits preserve metadata, blank lines, and other verses. */
export function editableLyricLines(draft: string, duration: number): EditableLyricLine[] {
  const offset = lrcOffset(draft);
  const rows = draft.split(/\r?\n/).flatMap((raw, sourceIndex) => {
    if (!raw.trim() || /^\s*\[(?:ar|al|ti|au|by|re|ve|length|offset):/i.test(raw)) return [];
    const parsed = parseLrc(`[offset:${offset}]\n${raw}`)[0];
    const text = plainLyrics(raw);
    if (!text || text === "[Instrumental]") return [];
    return [{ sourceIndex, line: parsed || { at: 0, text, key: String(sourceIndex) }, end: 0, timed: !!parsed }];
  });
  let nextAt = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    row.end = nextAt > row.line.at ? nextAt : Math.max(row.line.at + 6000, duration);
    if (row.timed) nextAt = row.line.at;
  }
  return rows;
}

/** One source-line replacement; absolute word times are written as Enhanced LRC. */
export function setWordTiming(draft: string, row: EditableLyricLine, starts: number[]): string {
  const words = lyricWaveWords(row.line, row.end);
  if (!words.length || starts.length !== words.length || starts.some((at, index) => !Number.isFinite(at) || at < 0 || (index > 0 && at < starts[index - 1]))) throw new Error("Keep word times in order. Adjust the previous or next word first.");
  if (starts.some(at => at >= row.end)) throw new Error("Keep word times before the next lyric line. Adjust the line timestamp in Text if needed.");
  const rawLines = draft.split(/\r?\n/);
  const raw = rawLines[row.sourceIndex];
  const offset = lrcOffset(draft);
  if (starts.some(at => at + offset < 0)) throw new Error("This file's offset puts the word before zero. Adjust the offset in Text first.");
  const first = Math.max(0, starts[0] + offset);
  const prefix = raw.match(/^(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\])+/)?.[0];
  const tags = prefix ? shiftLyrics(prefix, first - (row.line.at + offset)) : lyricTimestamp(first);
  const wordTags = words.map((word, index) => `<${lyricTimestamp(starts[index] + offset).slice(1, -1)}>${word.text}`).join("");
  const endTag = row.line.wordEnd !== undefined && row.line.wordEnd > starts[starts.length - 1] ? `<${lyricTimestamp(row.line.wordEnd + offset).slice(1, -1)}>` : "";
  rawLines[row.sourceIndex] = tags + wordTags + endTag;
  return rawLines.join("\n");
}
