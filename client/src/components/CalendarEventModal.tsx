/**
 * The shared event window.
 *
 * A calendar chip and a notification row both open *this* component, and it
 * fetches one endpoint (`GET /calendar/events/:kind/:id`). "View the event"
 * therefore means exactly one thing everywhere: the same fields, in the same
 * order, with the same links to the underlying record.
 *
 * A meeting shows when it is, who scheduled it and the record it is attached
 * to. A task shows its due date, status, priority, assignee and the record it
 * belongs to. Nothing here is role-gated: if you can see the calendar, you can
 * open what is on it.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { getCalendarEvent } from '../lib/workspace';
import type { CalendarEventDetail, CalendarEventKind } from '../lib/workspace';
import { recordPath } from '../lib/calendar';

/** What the caller wants to look at. `null` closes the window. */
export interface CalendarEventTarget {
  kind: CalendarEventKind;
  id: string;
}

const pretty = (value: string | null): string =>
  value ? value.replace(/_/g, ' ') : '--';

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function CalendarEventModal({
  target,
  onClose,
}: {
  target: CalendarEventTarget | null;
  onClose: () => void;
}): JSX.Element | null {
  const [detail, setDetail] = useState<CalendarEventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const kind = target?.kind ?? null;
  const id = target?.id ?? null;

  // Fetch when the target changes. A stale response from a superseded request
  // is dropped rather than flashing the previous event's details.
  useEffect(() => {
    if (!kind || !id) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setDetail(null);
    void (async () => {
      try {
        const next = await getCalendarEvent(kind, id);
        if (!cancelled) setDetail(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load this event.');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, id]);

  // Escape closes; the scrim closes; body scroll is locked while open.
  useEffect(() => {
    if (!target) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [target, onClose]);

  if (!target) return null;

  const recordPathForEvent =
    detail?.kind === 'meeting'
      ? recordPath(detail.entityType, detail.entityId)
      : detail?.kind === 'task'
        ? `/tasks/${detail.id}`
        : null;
  const relatedPath = detail?.kind === 'task' ? recordPath(detail.relatedType, detail.relatedId) : null;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="event-dialog-title">
          {detail ? detail.title : target.kind === 'meeting' ? 'Meeting' : 'Task'}
        </h2>
        <p className="muted">{target.kind === 'meeting' ? 'Calendar meeting' : 'Calendar task'}</p>

        {isLoading && <p className="muted">Loading...</p>}
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}

        {detail && (
          <dl className="detail-grid">
            <Row label="When">
              {detail.when ? new Date(detail.when).toLocaleString() : 'Not set'}
            </Row>
            {detail.kind === 'task' && (
              <>
                <Row label="Status">{pretty(detail.status)}</Row>
                <Row label="Priority">{pretty(detail.priority)}</Row>
                <Row label="Assignee">{detail.assigneeName ?? 'Unassigned'}</Row>
              </>
            )}
            {detail.kind === 'meeting' && (
              <Row label="Scheduled by">{detail.creatorName ?? 'Unknown'}</Row>
            )}
            {relatedPath && (
              <Row label="Related record">
                <Link to={relatedPath}>Open record</Link>
              </Row>
            )}
          </dl>
        )}

        {detail?.description && <p className="muted">{detail.description}</p>}

        <div className="form-actions modal-actions">
          {recordPathForEvent && (
            <Link className="btn btn-primary" to={recordPathForEvent} onClick={onClose}>
              Open record
            </Link>
          )}
          <button ref={closeRef} type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
