import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuPoint = { x: number; y: number };

export function ContextMenu({ point, label, children, onClose }: { point: MenuPoint; label: string; children: ReactNode; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [position, setPosition] = useState(point);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(point.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(point.y, window.innerHeight - rect.height - 8))
    });
  }, [point]);

  useEffect(() => {
    const menu = menuRef.current;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const items = () => [...(menu?.querySelectorAll<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])") || [])];
    items()[0]?.focus();

    function onPointerDown(event: PointerEvent) {
      if (!menu?.contains(event.target as Node)) onCloseRef.current();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const options = items();
      if (!options.length) return;
      event.preventDefault();
      const current = Math.max(0, options.indexOf(document.activeElement as HTMLElement));
      const index = event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[index]?.focus();
    }

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    const closeOnBlur = () => onCloseRef.current();
    window.addEventListener("blur", closeOnBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", closeOnBlur);
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={menuRef}
      className="contextMenu"
      role="menu"
      aria-label={label}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body
  );
}

export function MenuItem({ children, icon, danger, disabled, onSelect }: { children: ReactNode; icon?: ReactNode; danger?: boolean; disabled?: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? "contextMenuItem danger" : "contextMenuItem"}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={onSelect}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </button>
  );
}

export function MenuSeparator() {
  return <div className="contextMenuSeparator" role="separator" />;
}
