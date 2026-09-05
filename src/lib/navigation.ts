import { useSyncExternalStore } from "react";
import type { ViewKey } from "../types";

export type FolderLocation = { rootId: number; relativePath: string; path: string; rootName: string };
export type AppRoute = {
  view: ViewKey;
  collection: { type: "album" | "artist"; value: string } | null;
  playlist: string | null;
  folder: FolderLocation | null;
};
const initial: AppRoute = { view: "songs", collection: null, playlist: null, folder: null };
let entries: AppRoute[] = [initial];
let index = 0;
let snapshot = { route: initial, canBack: false, canForward: false };
const listeners = new Set<() => void>();
function publish() {
  snapshot = { route: entries[index], canBack: index > 0, canForward: index < entries.length - 1 };
  listeners.forEach((listener) => listener());
}
export const navigation = {
  current: () => snapshot.route,
  navigate(route: AppRoute, replace = false) {
    if (JSON.stringify(route) === JSON.stringify(entries[index])) return;
    if (replace) entries[index] = route;
    else {
      entries = [...entries.slice(0, index + 1), route].slice(-150);
      index = entries.length - 1;
    }
    publish();
  },
  view(view: ViewKey) { this.navigate({ ...initial, view }); },
  back() { if (index > 0) { index--; publish(); } },
  forward() { if (index < entries.length - 1) { index++; publish(); } }
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useNavigation = () => useSyncExternalStore(subscribe, () => snapshot);

/** Handle both DOM side buttons and keyboard events emitted by mouse drivers. */
export function installMouseNavigation() {
  const blocked = () => !!document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]');
  const preventSideDefault = (event: MouseEvent) => {
    if (event.button === 3 || event.button === 4) { event.preventDefault(); event.stopPropagation(); }
  };
  const onSideButton = (event: MouseEvent) => {
    if (event.button !== 3 && event.button !== 4) return;
    preventSideDefault(event);
    if (!blocked()) event.button === 3 ? navigation.back() : navigation.forward();
  };
  const onKey = (event: KeyboardEvent) => {
    const back = event.key === "BrowserBack" || (event.altKey && event.key === "ArrowLeft");
    const forward = event.key === "BrowserForward" || (event.altKey && event.key === "ArrowRight");
    if (!back && !forward) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat && !blocked()) back ? navigation.back() : navigation.forward();
  };
  window.addEventListener("mousedown", preventSideDefault, true);
  window.addEventListener("mouseup", preventSideDefault, true);
  window.addEventListener("auxclick", onSideButton, true);
  window.addEventListener("keydown", onKey, true);
  return () => {
    window.removeEventListener("mousedown", preventSideDefault, true);
    window.removeEventListener("mouseup", preventSideDefault, true);
    window.removeEventListener("auxclick", onSideButton, true);
    window.removeEventListener("keydown", onKey, true);
  };
}
