import { memo, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { lyricWaveWords, type TimedLine } from "../lib/lyrics";
import { useAudio } from "../lib/useAudio";
import { audioEngine } from "../lib/audioEngine";

/** Only active lines subscribe to playback ticks. Motion is tied to the playhead. */
export const LyricWave = memo(function LyricWave({ line, end, trackId, offset }: { line: TimedLine; end: number; trackId: number; offset: number }) {
  const audio = useAudio();
  const root = useRef<HTMLSpanElement>(null);
  const position = audio.current?.id === trackId ? audio.position + offset : line.at;
  const words = useMemo(() => lyricWaveWords(line, end), [line, end]);
  const provided = line.words?.length && line.words.every(word => word.at < end);
  useEffect(() => {
    if (!audio.playing || audio.current?.id !== trackId) return;
    let frame = 0;
    const paint = () => {
      const snapshot = audioEngine.snapshot();
      if (!snapshot.playing || snapshot.current?.id !== trackId) return;
      const at = audioEngine.playhead() + offset;
      root.current?.querySelectorAll<HTMLElement>(".lyricWord").forEach((element, index) => {
        const word = words[index];
        const progress = Math.max(0, Math.min(1, (at - word.at) / Math.max(1, word.end - word.at)));
        const wave = Math.sin(progress * Math.PI);
        element.style.setProperty("--word-fill", `${progress * 100}%`);
        element.style.setProperty("--word-rise", `${-7 * wave}px`);
        element.style.setProperty("--word-scale", String(1 + .045 * wave));
        element.dataset.wordState = progress >= 1 ? "sung" : at >= word.at ? "current" : "upcoming";
      });
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [audio.playing, audio.current?.id, trackId, offset, words]);
  return <span ref={root} className="lyricWave" data-word-timing={provided ? "provided" : "estimated"} data-playing={audio.current?.id === trackId && audio.playing}>{words.map((word, index) => {
    const progress = Math.max(0, Math.min(1, (position - word.at) / Math.max(1, word.end - word.at)));
    const wave = Math.sin(progress * Math.PI);
    const style = { "--word-fill": `${progress * 100}%`, "--word-rise": `${-7 * wave}px`, "--word-scale": 1 + .045 * wave } as CSSProperties;
    return <span key={index} className="lyricWord" data-word-state={progress >= 1 ? "sung" : position >= word.at ? "current" : "upcoming"} style={style}>{word.text}</span>;
  })}</span>;
});
