import { useEffect, useState } from "react";
import { audioEngine } from "./audioEngine";

export function useAudio() {
  const [snapshot, setSnapshot] = useState(audioEngine.snapshot());

  useEffect(() => {
    return audioEngine.subscribe(() => setSnapshot(audioEngine.snapshot()));
  }, []);

  return snapshot;
}

