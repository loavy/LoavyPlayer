import { useId, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";

type Option<Value extends string> = { value: Value; label: string; hint?: string; icon?: ReactNode; badge?: number; disabled?: boolean; panelId?: string };
type Props<Value extends string> = { label: string; value: Value; options: Option<Value>[]; onChange: (value: Value) => void; panelId: string; id?: string; className?: string };

/** One tab stop per group, with automatic activation on arrow/Home/End navigation. */
export function SegmentedTabs<Value extends string>({ label, value, options, onChange, panelId, id, className = "" }: Props<Value>) {
  const generatedId = useId();
  const prefix = id || generatedId;
  const root = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, top: 0, width: 0, height: 0 });
  useLayoutEffect(() => {
    const group = root.current;
    if (!group) return;
    const measure = () => {
      const tab = group.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      if (!tab) return;
      const next = { left: tab.offsetLeft, top: tab.offsetTop, width: tab.offsetWidth, height: tab.offsetHeight };
      setIndicator(current => Object.keys(next).every(key => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    group.querySelectorAll("button").forEach(tab => observer.observe(tab));
    return () => observer.disconnect();
  }, [value, options.map(option => `${option.value}:${option.label}:${option.badge}`).join("|")]);
  return <div ref={root} className={`segmentedTabs ${className}`} role="tablist" aria-label={label}>
    <span className="tabIndicator" aria-hidden="true" style={{ width: indicator.width, height: indicator.height, transform: `translate(${indicator.left}px, ${indicator.top}px)`, opacity: indicator.width ? 1 : 0 }} />
    {options.map(option => <button type="button" role="tab" key={option.value} id={`${prefix}-${option.value}`} aria-selected={value === option.value} aria-controls={option.panelId || panelId} tabIndex={value === option.value ? 0 : -1} disabled={option.disabled} className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const enabled = options.filter(item => !item.disabled);
      if (!enabled.length) return;
      event.preventDefault();
      const current = enabled.findIndex(item => item.value === option.value);
      const index = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length;
      const next = enabled[index];
      document.getElementById(`${prefix}-${next.value}`)?.focus();
      onChange(next.value);
    }}>{option.icon}<span>{option.label}</span>{option.hint && <em className="tabHint">{option.hint}</em>}{option.badge !== undefined && option.badge > 0 && <small>{option.badge > 99 ? "99+" : option.badge}</small>}</button>)}
  </div>;
}

/** Keyboard support for tab lists with specialized content, such as source cards. */
export function navigateTabList(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[index].focus(); tabs[index].click();
}
