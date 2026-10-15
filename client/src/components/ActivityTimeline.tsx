/**
 * Record activity timeline.
 *
 * Powers the history section on the detail page from
 * `GET /api/v1/activities/:entityType/:entityId` (newest first, camelCase —
 * see BIG-33). A 403 hides the section entirely: the timeline is auxiliary,
 * and a viewer without `activities.read` should see the record, not an error
 * about its history. Any other failure degrades to a muted note.
 */
import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { listActivities } from '../lib/workspace';
import type { ActivityRow } from '../lib/workspace';
import { EmptyState } from './ui';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function ActivityTimeline({
  entityType,
  entityId,
  refreshSignal = 0,
}: {
  entityType: string;
  entityId: string;
  /** Increment to reload (e.g. after scheduling a meeting on this record). */
  refreshSignal?: number;
}): JSX.Element | null {
  const [items, setItems] = useState<ActivityRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setFailed(false);
    setVisible(true);
    void (async () => {
      try {
        const rows = await listActivities(entityType, entityId);
        if (!cancelled) setItems(rows);
      } catch (err) {
        if (cancelled) return;
        // No permission: the section does not exist for this user, same as
        // RecordExtras. Anything else is a muted note, not a page error.
        if (err instanceof ApiError && err.status === 403) setVisible(false);
        else setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId, refreshSignal]);

  if (!visible) return null;
  if (failed) {
    return (
      <section className="card section" aria-label="Activity">
        <h2>Activity</h2>
        <p className="muted">Activity history is unavailable right now.</p>
      </section>
    );
  }

  return (
    <section className="card section" aria-label="Activity">
      <h2>Activity</h2>
      {items === null ? (
        <p className="muted" role="status">
          Loading activity…
        </p>
      ) : items.length === 0 ? (
        <EmptyState message="No activity yet." />
      ) : (
        <ol className="timeline">
          {items.map((a) => (
            <li key={a.id} className="timeline-item">
              <p className="timeline-head">
                <span className="timeline-type">{a.type}</span>
                <time className="muted" dateTime={a.occurredAt}>
                  {formatWhen(a.occurredAt)}
                </time>
              </p>
              {a.subject && <p className="timeline-subject">{a.subject}</p>}
              {a.description && <p className="muted">{a.description}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
