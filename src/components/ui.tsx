import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

export function Logo({ className }: { className?: string }) {
  return (
    <span className={`brand ${className ?? ''}`}>
      <svg viewBox="0 0 64 40" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="square" aria-hidden="true">
        <path d="M2 8h16c10 0 12 24 22 24h22" />
        <path d="M2 32h16c10 0 12-24 22-24h22" />
      </svg>
      <span className="wordmark">Tenflow</span>
    </span>
  );
}

const ICON = { info: Info, warn: AlertTriangle, error: XCircle, ok: CheckCircle2 };
export function Alert({ kind = 'info', title, children }: { kind?: keyof typeof ICON; title?: string; children?: ReactNode }) {
  const I = ICON[kind];
  return (
    <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <I aria-hidden="true" />
      <div>{title && <b>{title}</b>}{title && children ? <div>{children}</div> : children}</div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty">{icon}<b style={{ color: 'var(--ink)' }}>{title}</b>{children && <p>{children}</p>}</div>;
}

/** Native <dialog>: focus trapping, Esc and inert background come from the platform. Children stay mounted so the exit can animate; remount via `key` to reset state. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-label={title} onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {children}
    </dialog>
  );
}

export const pct = (v: number | null | undefined, d = 1) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);
export const bytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const period = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const periodShort = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('id-ID', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function download(buffer: ArrayBuffer, filename: string) {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
