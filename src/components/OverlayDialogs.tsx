import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

type DialogShellProps = {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  danger?: boolean;
  labelledBy: string;
};

export function DialogShell({ title, description, children, onClose, danger, labelledBy }: DialogShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("[autofocus], button, input, textarea, select, [tabindex]:not([tabindex='-1'])");
    first?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, []);

  return createPortal(
    <div className="dialogBackdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={danger ? "dialogPanel danger" : "dialogPanel"}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={description ? `${labelledBy}-description` : undefined}
      >
        <header className="dialogHeader">
          <span className="dialogIcon" aria-hidden="true">{danger ? <AlertTriangle size={20} /> : null}</span>
          <div>
            <h2 id={labelledBy}>{title}</h2>
            {description && <p id={`${labelledBy}-description`}>{description}</p>}
          </div>
          <button className="iconButton" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
        </header>
        {children}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog({
  title,
  description,
  detail,
  confirmLabel,
  busy = false,
  danger = false,
  onConfirm,
  onClose
}: {
  title: string;
  description?: string;
  detail?: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  return (
    <DialogShell title={title} description={description} onClose={busy ? () => undefined : onClose} danger={danger} labelledBy={titleId}>
      {detail && <div className="dialogDetail">{detail}</div>}
      <footer className="dialogActions">
        <button className="secondaryAction" onClick={onClose} disabled={busy} autoFocus>Cancel</button>
        <button className={danger ? "primaryAction dangerAction" : "primaryAction"} onClick={onConfirm} disabled={busy}>
          {busy && <LoaderCircle className="spin" size={16} />}
          {confirmLabel}
        </button>
      </footer>
    </DialogShell>
  );
}

export function PromptDialog({
  title,
  description,
  label,
  initialValue = "",
  submitLabel,
  busy = false,
  validate,
  onSubmit,
  onClose
}: {
  title: string;
  description?: string;
  label: string;
  initialValue?: string;
  submitLabel: string;
  busy?: boolean;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [value, setValue] = useState(initialValue);
  const [touched, setTouched] = useState(false);
  const validation = validate?.(value) || null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!value.trim() || validation) return;
    onSubmit(value.trim());
  }

  return (
    <DialogShell title={title} description={description} onClose={busy ? () => undefined : onClose} labelledBy={titleId}>
      <form onSubmit={submit} className="dialogForm">
        <label>
          <span>{label}</span>
          <input
            autoFocus
            value={value}
            maxLength={120}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={Boolean(touched && validation)}
          />
        </label>
        {touched && validation && <p className="fieldError">{validation}</p>}
        <footer className="dialogActions">
          <button type="button" className="secondaryAction" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primaryAction" disabled={busy || !value.trim() || Boolean(validation)}>
            {busy && <LoaderCircle className="spin" size={16} />}
            {submitLabel}
          </button>
        </footer>
      </form>
    </DialogShell>
  );
}

export function validateDisplayName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed.length > 120) return "Keep the name under 120 characters.";
  if(/[\u0000-\u001f]/.test(trimmed)) return "Control characters are not allowed.";
  return null;
}

export function validateWindowsFolderName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "Enter a folder name.";
  if (trimmed === "." || trimmed === "..") return "Choose another folder name.";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(trimmed)) return "That name contains a character Windows does not allow.";
  if (/[. ]$/.test(value)) return "Folder names cannot end with a dot or space.";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed)) return "That name is reserved by Windows.";
  return null;
}
