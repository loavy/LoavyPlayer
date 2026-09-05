import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { audioEngine, type AudioSnapshot } from "./audioEngine";

const subscribe = (listener: () => void) => audioEngine.subscribe(listener);
const getSnapshot = () => audioEngine.snapshot();

export function useAudio() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useAudioSelector<T>(selector: (snapshot: AudioSnapshot) => T, equal: (left: T, right: T) => boolean = Object.is) {
  const selectorRef = useRef(selector);
  const equalRef = useRef(equal);
  selectorRef.current = selector;
  equalRef.current = equal;
  const [value, setValue] = useState(() => selector(audioEngine.snapshot()));

  useEffect(() => {
    const update = () => {
      const next = selectorRef.current(audioEngine.snapshot());
      setValue((current) => equalRef.current(current, next) ? current : next);
    };
    const unsubscribe = audioEngine.subscribe(update);
    update();
    return unsubscribe;
  }, []);

  return value;
}

