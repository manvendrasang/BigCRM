/**
 * Shared UI primitives.
 *
 * Every page inherits the theme automatically through the tokens in
 * `styles/tokens.css`; these components exist so the *structure* cannot drift
 * either. Before this module, each page hand-rolled its own KPI cards, empty
 * states, destructive confirms (`window.confirm`, which is unstyled,
 * untestable and blocks the event loop) and section spacing (magic `24`s in
 * inline styles). New pages must compose from here rather than inventing a
 * sixth row-action button style.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

// ── KPI cards ───────────────────────────────────────────────────────────────

export function KpiCard({
  title,
  value,
  note,
}: {
  title: string;
  value: ReactNode;
  note?: ReactNode;
}): JSX.Element {
  return (
    <article className="card stat">
      <h2>{title}</h2>
      <p className="stat-value">{value}</p>
      {note !== undefined && <p className="stat-note">{note}</p>}
    </article>
  );
}

export function KpiLinkCard({
  title,
  value,
  note,
  to,
}: {
  title: string;
  value: ReactNode;
  note?: ReactNode;
  to: string;
}): JSX.Element {
  return (
    <Link className="card stat link-card" to={to}>
      <h2>{title}</h2>
      <p className="stat-value">{value}</p>
      {note !== undefined && <p className="stat-note">{note}</p>}
    </Link>
  );
}

// ── sections ────────────────────────────────────────────────────────────────

/**
 * A titled card section with the standard rhythm. Replaces the ad-hoc
 * `<section className="card" style={{ marginTop: 24 }}>` / `marginBottom: 24`
 * variants scattered across Reports, Settings and RecordExtras — one class,
 * one spacing, both directions.
 */
export function Section({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="card section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

// ── empty states ────────────────────────────────────────────────────────────

export function EmptyState({
  message,
  action,
}: {
  message: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty-state">
      <p className="muted">{message}</p>
      {action}
    </div>
  );
}

// ── badges ──────────────────────────────────────────────────────────────────

export function CountBadge({ count }: { count: number }): JSX.Element | null {
  if (count <= 0) return null;
  const label = count > 99 ? '99+' : String(count);
  return (
    <span className="count-badge" aria-label={`${count} unread`}>
      {label}
    </span>
  );
}

// ── confirm dialog ──────────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel: string;
}

/**
 * Themed replacement for `window.confirm`. The dialog traps nothing — it is a
 * single decision, not a form — but it takes initial focus, closes on Escape
 * and on scrim click, and locks body scroll while open. The promise resolves
 * `true` on confirm, `false` on any dismissal.
 */
export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  dialog: JSX.Element;
} {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setPending({ ...options, resolve });
      }),
    [],
  );

  const close = useCallback(
    (value: boolean) => {
      setPending((current) => {
        current?.resolve(value);
        return null;
      });
    },
    [],
  );

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.title ?? ''}
      message={pending?.message ?? ''}
      confirmLabel={pending?.confirmLabel ?? 'Confirm'}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  );

  return { confirm, dialog };
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        {message && <p className="muted">{message}</p>}
        <div className="form-actions modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
