/**
 * Schedule-meeting form for the record detail page.
 *
 * The entity is known here (the page owns it), so the form asks only for the
 * time and the title -- no UUID paste boxes. On success the parent reloads its
 * timeline; the new meeting shows in the detail history and on the calendar.
 * Viewers never see this form (`activities.create` is not in the viewer set),
 * and the server enforces that regardless of what the UI offers.
 */
import { useState } from 'react';
import { ApiError } from '../lib/api';
import { scheduleMeeting } from '../lib/workspace';

const toLocalInput = (d: Date): string => {
 const pad = (n: number): string => String(n).padStart(2, '0');
 return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function ScheduleMeetingForm({
 entityType,
 entityId,
 onScheduled,
}: {
 entityType: string;
 entityId: string;
 onScheduled: () => void;
}): JSX.Element {
 const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 3_600_000)));
 const [subject, setSubject] = useState('');
 const [error, setError] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);

 async function submit(e: React.FormEvent): Promise<void> {
 e.preventDefault();
 if (!subject.trim() || !when) return;
 setBusy(true);
 setError(null);
 try {
 // `datetime-local` carries no zone; interpret it in the browser's zone
 // and send UTC, so a 10:00 pick stays 10:00 for the viewer.
 const occurredAt = new Date(when).toISOString();
 if (Number.isNaN(Date.parse(occurredAt))) throw new Error('Enter a valid date and time.');
 await scheduleMeeting({ entityType, entityId, occurredAt, subject: subject.trim() });
 setSubject('');
 onScheduled();
 } catch (err) {
 setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not schedule the meeting.');
 } finally {
 setBusy(false);
 }
 }

 return (
 <section className="card section" aria-label="Schedule a meeting">
 <h2>Schedule a meeting</h2>
 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}
 <form onSubmit={(e) => { void submit(e); }}>
 <div className="form-grid">
 <label className="field">
 <span>When *</span>
 <input
 type="datetime-local"
 value={when}
 required
 onChange={(e) => setWhen(e.target.value)}
 />
 </label>
 <label className="field">
 <span>Title *</span>
 <input
 value={subject}
 required
 maxLength={200}
 placeholder="e.g. Discovery call"
 onChange={(e) => setSubject(e.target.value)}
 />
 </label>
 </div>
 <div className="form-actions">
 <button type="submit" className="btn btn-primary" disabled={busy || !subject.trim()}>
 {busy ? 'Scheduling...' : 'Schedule meeting'}
 </button>
 </div>
 </form>
 </section>
 );
}
