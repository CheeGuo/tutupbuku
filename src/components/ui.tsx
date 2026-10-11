import React, { useEffect, useRef } from 'react';
import { humanStatus } from '../lib/format';
import { useData } from '../state/store';

type Tone = 'neutral' | 'blue' | 'mint' | 'lime' | 'peach' | 'red';

const STATUS_TONE: Record<string, Tone> = {
  UPLOADED: 'neutral', EXTRACTED: 'blue', MATCHED: 'blue', NEEDS_REVIEW: 'peach', VERIFIED: 'mint', REJECTED: 'red',
  OPEN: 'peach', UNDER_REVIEW: 'blue', RESOLVED: 'mint', DISMISSED: 'neutral',
  PLAUSIBLE: 'lime', APPROVED: 'mint', CORRECTION_REQUESTED: 'peach',
  INFO: 'blue', WARNING: 'lime', HIGH: 'red',
};

export function Pill({ status, label }: { status: string; label?: string }) {
  return <span className={`pill pill-${STATUS_TONE[status] ?? 'neutral'}`}>{label ?? humanStatus(status)}</span>;
}

export function Severity({ level }: { level: 'INFO' | 'WARNING' | 'HIGH' }) {
  return <span className={`sev sev-${level.toLowerCase()}`}><span className="sev-dot" aria-hidden="true" />{humanStatus(level)}</span>;
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function Disclosure({ title, meta, defaultOpen, children }: { title: string; meta?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  return <details className="disclosure" open={defaultOpen}>
    <summary><span>{title}</span>{meta !== undefined && <span className="disclosure-meta">{meta}</span>}</summary>
    <div className="disclosure-body">{children}</div>
  </details>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void; label: string }) {
  return <div className="segmented" role="tablist" aria-label={label}>
    {options.map(o => <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
      {o.label}{o.count !== undefined && <span className="segmented-count">{o.count}</span>}
    </button>)}
  </div>;
}

/** Native <dialog>: focus trap, Esc to close and backdrop come from the platform. */
export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); }, []);
  return <dialog ref={ref} className="dialog" onClose={onClose} onClick={e => { if (e.target === ref.current) onClose(); }}>
    <form method="dialog" className="dialog-head"><h2>{title}</h2><button className="icon-btn" aria-label="Close dialog">✕</button></form>
    <div className="dialog-body">{children}</div>
    {footer && <div className="dialog-foot">{footer}</div>}
  </dialog>;
}

export function Toasts() {
  const { toasts, dismissToast } = useData();
  return <div className="toasts" role="status" aria-live="polite">
    {toasts.map(t => <div key={t.id} className={`toast toast-${t.tone}`}><span>{t.message}</span><button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss message">✕</button></div>)}
  </div>;
}
