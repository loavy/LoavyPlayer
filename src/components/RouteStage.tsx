import { useLayoutEffect, useRef, type ReactNode, type UIEvent } from "react";
import { navigation } from "../lib/navigation";

/** Restore each view's nested scroll containers without retaining hidden libraries. */
export function RouteStage({ routeKey, children }: { routeKey: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const locations = useRef(new Map<string, Map<string, { top: number; left: number }>>());
  const currentKey = useRef(routeKey);
  const restoring = useRef(false);
  function remember(event: UIEvent<HTMLDivElement>) {
    const element = event.target as HTMLElement;
    if (!restoring.current && element instanceof HTMLElement) record(element);
  }
  function record(element: HTMLElement) {
    if (!root.current) return;
    const path: number[] = [];
    let child = element;
    while (child !== root.current && child.parentElement) { path.unshift(Array.prototype.indexOf.call(child.parentElement.children, child)); child = child.parentElement; }
    if (child !== root.current) return;
    let positions = locations.current.get(currentKey.current);
    if (!positions) { positions = new Map(); locations.current.set(currentKey.current, positions); }
    positions.set(path.join("/"), { top: element.scrollTop, left: element.scrollLeft });
    if (locations.current.size > 100) locations.current.delete(locations.current.keys().next().value!);
  }
  useLayoutEffect(() => navigation.beforeChange(() => {
    root.current?.querySelectorAll<HTMLElement>("*").forEach(element => {
      if (!element.getClientRects().length) return;
      const style = getComputedStyle(element);
      if ((/auto|scroll|overlay/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) || (/auto|scroll|overlay/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1)) record(element);
    });
  }), []);
  useLayoutEffect(() => {
    currentKey.current = routeKey;
    const stage = root.current;
    if (!stage) return;
    restoring.current = true;
    const saved = [...(locations.current.get(routeKey)?.entries() || [])];
    const restore = () => {
      saved.forEach(([path, position]) => {
        let element: Element | undefined = stage;
        for (const part of path.split("/").filter(Boolean)) element = element?.children[Number(part)];
        if (element instanceof HTMLElement) element.scrollTo({ top: position.top, left: position.left, behavior: "instant" });
      });
    };
    restore();
    const frame = requestAnimationFrame(() => { restore(); restoring.current = false; });
    const reduced = document.documentElement.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animation = !reduced ? stage.animate([{ opacity: .6, transform: "translateY(5px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" }) : undefined;
    return () => { cancelAnimationFrame(frame); restoring.current = false; animation?.cancel(); };
  }, [routeKey]);
  return <div className="routeStage" ref={root} onScrollCapture={remember}>{children}</div>;
}
