import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLibraryActions, errorMessage } from "../lib/LibraryContext";

export function hasNativeWindow() { return Boolean((window as Window & { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata); }
export function WindowControls() {
  const { notify } = useLibraryActions();
  if (!hasNativeWindow()) return null;
  const run = (action: "minimize" | "toggleMaximize" | "close") => { void getCurrentWindow()[action]().catch((error) => notify(errorMessage(error), "error")); };
  return <div className="windowControls"><button aria-label="Minimize window" onClick={() => run("minimize")}><Minus size={15} /></button><button aria-label="Maximize or restore window" onClick={() => run("toggleMaximize")}><Square size={12} /></button><button className="windowClose" aria-label="Close window" onClick={() => run("close")}><X size={16} /></button></div>;
}
