import { useEffect, useRef, useState } from "react";
import { audioEngine, type AudioSnapshot } from "./audioEngine";

export function useAudio() {
  const [snapshot, setSnapshot] = useState(audioEngine.snapshot());

  useEffect(() => {
    return audioEngine.subscribe(() => setSnapshot(audioEngine.snapshot()));
  }, []);

  return snapshot;
}

export function useAudioSelector<T>(selector: (snapshot: AudioSnapshot) => T, equal: (left: T, right: T) => boolean = Object.is) {
  const selectorRef = useRef(selector);
  const equalRef = useRef(equal);
  selectorRef.current = selector;
  equalRef.current = equal;
  const [value, setValue] = useState(() => selector(audioEngine.snapshot()));

  useEffect(() => audioEngine.subscribe(() => {
    const next = selectorRef.current(audioEngine.snapshot());
    setValue((current) => equalRef.current(current, next) ? current : next);
  }), []);

  return value;
}

