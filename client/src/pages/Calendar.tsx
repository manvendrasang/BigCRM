/**
 * Calendar: month view of meetings and dated tasks.
 *
 * One grid, two sources. Meetings come from scheduled `activities` rows,
 * tasks from `due_date` -- the same rows the detail pages and task lists read,
 * fetched here in a single range request (`GET /api/v1/calendar`). Day cells
 * show up to three chips and a remainder; selecting a day renders its agenda
 * below with links back to the records. Overdue, unfinished business sorts
 * first in the agenda so the morning view answers "what needs me" directly.
 *
 * Scheduling itself lives on the record detail page, where the entity is
 * known -- this page reads. Every chip is a button that opens the shared event
 * window (`CalendarEventModal`), which is also what a calendar notification
 * opens from the notification list. A 403 (no `activities.read`) degrades to a
 * muted note rather than a blank shell.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { getCalendar, inviteToMeeting, listInvitees, listMyInvites, respondToInvite } from '../lib/workspace';
import type { CalendarMeeting, CalendarTask, MeetingInvitee, MyInvite } from '../lib/workspace';
import { buildMonthGrid, shiftMonth, MONTH_LABEL } from '../lib/calendar';
import { EmptyState, Skeleton } from '../components/ui';
import { CalendarEventModal } from '../components/CalendarEventModal';
import type { CalendarEventTarget } from '../components/CalendarEventModal';
import { useAuth } from '../lib/auth';

const ENTITY_PATH: Record<string, string> = {
  contact: 'contacts',
  company: 'companies',
  lead: 'leads',
  deal: 'deals',
  task: 'tasks',
};

const entityLink = (entityType: string, entityId: string): string => {
  const base = ENTITY_PATH[entityType];
  return base ? `/${base}/${entityId}` : '/dashboard';
};

interface AgendaEntry {
  key: string;
  when: string;
  kind: 'meeting' | 'task';
  title: string;
  detail: string | null;
  link: string;
  done: boolean;
  overdue: boolean;
}

const entryTime = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

const dayKeyOf = (iso: string): string | null => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function Calendar(): JSX.Element {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [meetings, setMeetings] = useState<CalendarMeeting[]>([]);
  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(() => dayKeyOf(now.toISOString()));
  const { actor } = useAuth();
  const canInvite = actor?.role !== 'viewer';

  const [eventTarget, setEventTarget] = useState<CalendarEventTarget | null>(null);
  const [inviteTarget, setInviteTarget] = useState<AgendaEntry | null>(null);
  const [directory, setDirectory] = useState<MeetingInvitee[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteDone, setInviteDone] = useState<string | null>(null);

  const [inbox, setInbox] = useState<MyInvite[]>([]);
  const [answeringId, setAnsweringId] = useState<string | null>(null);

  const loadInbox = useCallback(async () => {
    try {
      setInbox(await listMyInvites('invited'));
    } catch {
      setInbox([]);
    }
  }, []);

  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);

  async function answerInvite(id: string, status: 'accepted' | 'declined'): Promise<void> {
    setAnsweringId(id);
    try {
      await respondToInvite(id, status);
      await loadInbox();
    } catch {
      // An invite the server refuses to answer is not worth interrupting
      // anybody for; the inbox simply stays as it was.
    } finally {
      setAnsweringId(null);
    }
  }

  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);

  const load = useCallback(async () => {
    const first = weeks[0]?.[0];
    const lastWeek = weeks[weeks.length - 1];
    const last = lastWeek?.[lastWeek.length - 1];
    if (!first || !last) return;
    setIsLoading(true);
    setError(null);
    try {
      const agenda = await getCalendar(first.date.toISOString(), last.date.toISOString());
      setMeetings(agenda.meetings);
      setTasks(agenda.tasks);
      setForbidden(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError(err instanceof ApiError ? err.message : 'Could not load the calendar.');
    } finally {
      setIsLoading(false);
    }
  }, [weeks]);

  useEffect(() => {
    void load();
  }, [load]);

  const move = (delta: number): void => {
    const next = shiftMonth(year, month, delta);
    setYear(next.year);
    setMonth(next.month);
  };

  const goToday = (): void => {
    const d = new Date();
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setSelectedKey(dayKeyOf(d.toISOString()));
  };

  const byDay = useMemo(() => {
    const map = new Map<string, AgendaEntry[]>();
    const push = (key: string, entry: AgendaEntry): void => {
      const list = map.get(key) ?? [];
      list.push(entry);
      map.set(key, list);
    };
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    for (const m of meetings) {
      const key = dayKeyOf(m.occurredAt);
      if (!key) continue;
      push(key, {
        key: m.id,
        when: m.occurredAt,
        kind: 'meeting',
        title: m.subject || 'Meeting',
        detail: m.actorName ? `with ${m.actorName}` : null,
        link: entityLink(m.entityType, m.entityId),
        done: false,
        overdue: entryTime(m.occurredAt) < todayStart.getTime(),
      });
    }
    for (const t of tasks) {
      const key = dayKeyOf(t.dueDate);
      if (!key) continue;
      const done = t.status === 'completed' || t.status === 'cancelled';
      push(key, {
        key: t.id,
        when: t.dueDate,
        kind: 'task',
        title: t.title,
        detail: t.status,
        link: `/tasks/${t.id}`,
        done,
        overdue: !done && entryTime(t.dueDate) < todayStart.getTime(),
      });
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        if (a.done !== b.done) return a.done ? 1 : -1;
        return entryTime(a.when) - entryTime(b.when);
      });
    }
    return map;
  }, [meetings, tasks]);

  const agenda = (selectedKey ? byDay.get(selectedKey) ?? [] : []).slice();

  function openInvite(entry: AgendaEntry): void {
    setInviteTarget(entry);
    setSelected([]);
    setInviteError(null);
    setInviteDone(null);
    setDirectory([]);
    void (async () => {
      try {
        setDirectory(await listInvitees());
      } catch (err) {
        setInviteError(err instanceof ApiError ? err.message : 'Could not load members.');
      }
    })();
  }

  function toggleInvitee(id: string): void {
    setSelected((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  async function submitInvites(): Promise<void> {
    if (!inviteTarget || selected.length === 0) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const result = await inviteToMeeting(inviteTarget.key, selected);
      const parts = [`${result.invited.length} invited`];
      if (result.alreadyInvited.length > 0) parts.push(`${result.alreadyInvited.length} already invited`);
      setInviteDone(`${parts.join(', ')}.`);
      setSelected([]);
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : 'Could not send the invites.');
    } finally {
      setInviteBusy(false);
    }
  }

  return (
    <div className="enter">
    <h1>Calendar</h1>
    <p className="muted">Meetings and dated tasks across your workspace.</p>

    {error && (
    <p className="alert alert-error" role="alert">
    {error}
    </p>
    )}
    {forbidden && !error && (
    <p className="muted">You need the calendar permission to see this page. Ask an admin.</p>
    )}

    {!forbidden && (
    <>
    <div className="toolbar" role="group" aria-label="Month navigation">
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => move(-1)} aria-label="Previous month">
    &larr; Prev
    </button>
    <strong aria-live="polite">{MONTH_LABEL(year, month)}</strong>
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => goToday()}>
    Today
    </button>
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => move(1)} aria-label="Next month">
    Next &rarr;
    </button>
    </div>

    {isLoading ? (
    <div className="grid stagger">
    <div className="card section enter-fast">
    <Skeleton variant="title" />
    <Skeleton variant="line" />
    <Skeleton variant="line" />
    <Skeleton variant="line" />
    </div>
    </div>
    ) : (
    <div className="table-wrap">
    <table className="calendar-grid">
    <thead>
    <tr>
    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
    <th key={d} scope="col">
    {d}
    </th>
    ))}
    </tr>
    </thead>
    <tbody>
    {weeks.map((week, wi) => (
    <tr key={wi}>
    {week.map((day) => {
    const entries = byDay.get(day.key) ?? [];
    const selected = day.key === selectedKey;
    return (
    <td
    key={day.key}
    className={`cal-day${day.inMonth ? '' : ' cal-filler'}${selected ? ' cal-selected' : ''}`}
    >
    <button
    type="button"
    className="cal-date"
    aria-pressed={selected}
    aria-label={`${day.key}${entries.length ? `, ${entries.length} items` : ''}`}
    onClick={() => setSelectedKey(day.key)}
    >
    {day.date.getUTCDate()}
    </button>
    <div className="cal-chips">
    {entries.slice(0, 3).map((e) => (
    <button
    key={`${e.kind}-${e.key}`}
    type="button"
    className={`cal-chip cal-chip-${e.kind}${e.done ? ' cal-chip-done' : ''}${e.overdue ? ' cal-chip-overdue' : ''}`}
    title={e.title}
    onClick={() => setEventTarget({ kind: e.kind, id: e.key })}
    >
    {e.title}
    </button>
    ))}
    {entries.length > 3 && (
    <span className="cal-more">+{entries.length - 3} more</span>
    )}
    </div>
    </td>
    );
    })}
    </tr>
    ))}
    </tbody>
    </table>
    </div>
    )}

    {inbox.length > 0 && (
    <section className="card section" aria-label="Your invitations">
    <h2>Your invitations</h2>
    <ol className="timeline">
    {inbox.map((invite) => (
    <li key={invite.id} className="timeline-item">
    <p className="timeline-head">
    <span className="timeline-type">{invite.subject || 'Meeting'}</span>
    <time className="muted" dateTime={invite.occurredAt}>
    {new Date(invite.occurredAt).toLocaleString()}
    </time>
    </p>
    {invite.inviterName && <p className="muted">invited by {invite.inviterName}</p>}
    <p>
    <span className="btn-group">
    <button
    type="button"
    className="btn btn-secondary btn-sm"
    disabled={answeringId !== null}
    onClick={() => { void answerInvite(invite.id, 'accepted'); }}
    >
    {answeringId === invite.id ? 'Answering...' : 'Accept'}
    </button>
    <button
    type="button"
    className="btn btn-secondary btn-sm"
    disabled={answeringId !== null}
    onClick={() => { void answerInvite(invite.id, 'declined'); }}
    >
    Decline
    </button>
    </span>
    </p>
    </li>
    ))}
    </ol>
    </section>
    )}

    {selectedKey && (
    <section className="card section" aria-label="Agenda">
    <h2>Agenda -- {selectedKey}</h2>
    {agenda.length === 0 ? (
    <EmptyState message="Nothing scheduled for this day." />
    ) : (
    <ol className="timeline">
    {agenda.map((e) => (
    <li key={`${e.kind}-${e.key}`} className="timeline-item">
    <p className="timeline-head">
    <Link to={e.link}>{e.title}</Link>
    <span className={`cal-kind cal-kind-${e.kind}`}>
    {e.kind === 'meeting' ? 'Meeting' : 'Task'}
    {e.overdue ? ' - overdue' : ''}
    </span>
    </p>
    {e.detail && <p className="muted">{e.detail}</p>}
    {e.kind === 'meeting' && canInvite && (
    <p>
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => openInvite(e)}>
    Invite
    </button>
    </p>
    )}
    </li>
    ))}
    </ol>
    )}
    </section>
    )}
    </>
    )}

    {inviteTarget && (
    <div className="modal-scrim" onClick={() => setInviteTarget(null)}>
    <div
    className="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="invite-dialog-title"
    onClick={(e) => e.stopPropagation()}
    >
    <h2 id="invite-dialog-title">Invite to {inviteTarget.title}</h2>
    {inviteError && (
    <p className="alert alert-error" role="alert">
    {inviteError}
    </p>
    )}
    {inviteDone && (
    <p className="alert" role="status">
    {inviteDone}
    </p>
    )}
    <fieldset className="checklist">
    <legend>Workspace members</legend>
    {directory.length === 0 && !inviteError && <p className="muted">Loading...</p>}
    {directory.map((d) => (
    <label key={d.id}>
    <input
    type="checkbox"
    checked={selected.includes(d.id)}
    disabled={inviteBusy}
    onChange={() => toggleInvitee(d.id)}
    />{' '}
    {d.name || d.email} <span className="muted">{d.email}</span>
    </label>
    ))}
    </fieldset>
    <div className="form-actions modal-actions">
    <button
    type="button"
    className="btn btn-secondary"
    disabled={inviteBusy}
    onClick={() => setInviteTarget(null)}
    >
    Done
    </button>
    <button
    type="button"
    className="btn btn-primary"
    disabled={inviteBusy || selected.length === 0}
    onClick={() => { void submitInvites(); }}
    >
    {inviteBusy ? 'Inviting...' : `Invite${selected.length ? ` ${selected.length}` : ''}`}
    </button>
    </div>
    </div>
    </div>
    )}
    <CalendarEventModal target={eventTarget} onClose={() => setEventTarget(null)} />
    </div>
    );
}

export default Calendar;
