import { createRoot } from "react-dom/client";
import { DownloaderView } from "../src/views/DownloaderView";
import "../src/styles.css";
import "../src/redesign.css";

// Native commands are controlled independently so the browser test can exercise
// the order of progress events, command responses, and tool-health refreshes.
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<string, number>();
let nextId = 0;
const browser = window as any;
browser.__TAURI_INTERNALS__ = {
  transformCallback(callback: (event: unknown) => void) {
    callbacks.set(++nextId, callback);
    return nextId;
  },
  async invoke(command: string, args: any) {
    if (command === "plugin:event|listen") listeners.set(args.event, args.handler);
    return args.handler;
  }
};
browser.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
const health = { state: "ready", version: "test", expectedVersion: "test", detail: null, provider: null };
const status: any = { running: false, ytDlp: health, ffmpeg: health, jsRuntime: health, spotdl: health };
const mock = browser.downloaderTest = {
  calls: [] as any[],
  rejectStatus: false,
  cancelCalls: 0,
  finish: (_result: any) => {},
  finishRepair: () => {},
  emit(name: string, payload: unknown) { callbacks.get(listeners.get(name)!)?.({ payload }); },
  result() {
    const request = this.calls.at(-1);
    return { ...request, destination: "C:\\Music", downloadedCount: 1, failedCount: 0,
      warnings: [], files: ["C:\\Music\\Test Song.m4a"] };
  }
};
createRoot(document.getElementById("root")!).render(
  <DownloaderView
    onDownloadMedia={(request) => new Promise((resolve) => { mock.calls.push(request); mock.finish = resolve; })}
    onGetStatus={async () => { if (mock.rejectStatus) throw new Error("Health check unavailable"); return status; }}
    onRepairTools={() => new Promise((resolve) => { mock.finishRepair = () => resolve(status); })}
    onCancel={async () => { mock.cancelCalls++; }}
    onSelectFolder={async () => { throw new Error("Picker unavailable"); }}
    onRevealDownload={async () => { throw new Error("Explorer unavailable"); }}
  />
);
