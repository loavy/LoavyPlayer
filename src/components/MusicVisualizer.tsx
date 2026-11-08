import { useEffect, useRef } from "react";
import { audioGraph } from "../lib/audioGraph";
import { useAudioPreferences } from "../lib/audioPreferences";
import { useAudioSelector } from "../lib/useAudio";

export function MusicVisualizer({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const playing = useAudioSelector((audio) => audio.playing);
  const { visualizer } = useAudioPreferences();
  useEffect(() => {
    const canvas = ref.current; if (!canvas || !visualizer) return;
    const context = canvas.getContext("2d"); if (!context) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, lastFrame = 0;
    const bins = new Uint8Array(1024), heights = new Float32Array(48);
    const resize = () => { const rect = canvas.getBoundingClientRect(); const ratio = Math.min(devicePixelRatio || 1, 2); canvas.width = Math.max(1, Math.round(rect.width * ratio)); canvas.height = Math.max(1, Math.round(rect.height * ratio)); };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const draw = (time: number) => {
      if (time - lastFrame < 32) { frame = requestAnimationFrame(draw); return; } lastFrame = time;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!playing || media.matches || document.documentElement.dataset.motion === "reduced" || document.hidden) { frame = 0; return; }
      const analyser = audioGraph.getAnalyser();
      if (analyser) analyser.getByteFrequencyData(bins);
      const color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#f2b661";
      context.fillStyle = color;
      const step = canvas.width / heights.length;
      for (let i = 0; i < heights.length; i++) {
        const start = Math.floor(2 ** (i / (heights.length - 1) * 9));
        const end = Math.min(bins.length, Math.max(start + 1, Math.floor(2 ** ((i + 1) / (heights.length - 1) * 9))));
        let sum = 0; for (let bin = start; bin < end; bin++) sum += bins[bin];
        const value = analyser ? sum / (end - start) / 255 : 0;
        heights[i] += (value - heights[i]) * .3;
        const height = heights[i] * canvas.height * .9;
        if (height > .5) context.fillRect(i * step, canvas.height - height, Math.max(1, step - 3), height);
      }
      frame = requestAnimationFrame(draw);
    };
    const restart = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const motion = new MutationObserver(restart); motion.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    document.addEventListener("visibilitychange", restart); media.addEventListener("change", restart); restart();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); motion.disconnect(); document.removeEventListener("visibilitychange", restart); media.removeEventListener("change", restart); };
  }, [playing, visualizer]);
  return visualizer ? <canvas ref={ref} className={`musicVisualizer ${className}`} aria-hidden="true" /> : null;
}
