/**
 * Due reminders: the two advance notices every scheduled item earns.
 *
 * A meeting, or a task with a due date, is announced when it lands on the
 * calendar. What it is not announced for is the approach of its due time --
 * and that is the announcement a workspace actually needs. So each such item
 * schedules two notices through the durable queue: one an hour before, one
 * fifteen minutes before.
 *
 * The split of responsibility is deliberate, because "send it twice, once"
 * fails in two different directions:
 * * `event_reminders` (the ledger) remembers, per item and per lead time,
 *   whether the notice has gone out. It is the only thing that makes the
 *   feature exactly-once, so it is written in the same transaction as the
 *   notification it guards.
 * * `enqueue` hands the work to the queue, which owns retries and backoff.
 * * `sweepDueReminders` is the clock: it moves due ledger rows onto the queue,
 *   each one once, and is safe to run from any number of workers.
 * * `deliverDueReminder` is the handler: it claims the ledger row, re-reads the
 *   item, and tells every member of the workspace.
 *
 * Nothing here is role-gated. These are due reminders rather than permissions:
 * every role gets them, and so does whoever scheduled the item in the first
 * place.
 */
import { TenantScope } from '../repositories/base.ts';
import type { DbClient } from '../db/driver.ts';
import { getDb } from '../db/driver.ts';
import { newId } from '../lib/ids.ts';
import { logger } from '../lib/logger.ts';
import { enqueue } from './queue.ts';
import type { Job } from './queue.ts';
import { notifyAllMembers } from './activity.ts';

/** What the reminder points at: a calendar meeting, or a dated task. */
export type EventKind = 'meeting' | 'task';

/** The two lead times, in minutes. Exported so tests state the same numbers. */
export const REMINDER_LEAD_MINUTES: readonly number[] = [60, 15];

/** The queue job type the sweep enqueues and the worker runs. */
export const REMINDER_JOB_TYPE = 'event_due_reminder';

/** How many due notices one sweep may hand over. A backlog drains a batch a pass. */
const SWEEP_BATCH = 100;

/** Poll interval for the sweep, if the caller does not choose one. */
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/**
 * Item titles are capped at 200 characters, and the notification title is
 * `Due in <lead>: <item>`. Leave room for the prefix so a long title is
 * trimmed at a word boundary rather than cut mid-sentence by the column limit.
 */
const TITLE_BUDGET = 180;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "1 hour" / "15 minutes" -- the phrase the notification title reads as. */
export const leadLabel = (minutes: number): string =>
  minutes >= 60 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`;

/** The type a lead time sends under: `calendar_due_1h`, `calendar_due_15m`. */
export const reminderType = (minutes: number): string =>
  `calendar_due_${minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`}`;

export interface EventReminder {
  id: string;
  leadMinutes: number;
  dueAt: string;
  fireAt: string;
  sentAt: string | null;
}

/** The ledger rows for one item, soonest lead first. Powers the tests and any debug view. */
export async function eventRemindersFor(
  organizationId: string,
  kind: EventKind,
  id: string,
): Promise<EventReminder[]> {
  const db = await getDb();
  const r = await db.query<{
    id: string; lead_minutes: number; due_at: string; fire_at: string; sent_at: string | null;
  }>(
    `SELECT id, lead_minutes, due_at, fire_at, sent_at
    FROM event_reminders
    WHERE organization_id = $1 AND entity_kind = $2 AND entity_id = $3
    ORDER BY lead_minutes DESC`,
    [organizationId, kind, id],
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    leadMinutes: Number(row.lead_minutes),
    dueAt: String(row.due_at),
    fireAt: String(row.fire_at),
    sentAt: row.sent_at === null ? null : String(row.sent_at),
  }));
}

/**
 * Arms (or re-arms) the two notices for one item.
 *
 * Passing no usable date cancels any pending notices, so a single call keeps
 * the ledger in step with the row: gaining a date arms it, moving one re-arms
 * it at the new times, and losing one retires it.
 *
 * Written against a `TenantScope` so the call site can join the caller's
 * transaction: the ledger and the task it describes commit together, or not at
 * all.
 */
export async function scheduleEventReminders(
  scope: TenantScope,
  input: { organizationId: string; kind: EventKind; id: string; dueAt: string | null },
): Promise<void> {
  const due = input.dueAt ? new Date(input.dueAt) : null;
  if (!due || Number.isNaN(due.getTime())) {
    await cancelEventReminders(scope, input.organizationId, input.kind, input.id);
    return;
  }

  for (const lead of REMINDER_LEAD_MINUTES) {
    await scope.unsafe.query(
      `INSERT INTO event_reminders
       (id, organization_id, entity_kind, entity_id, lead_minutes, due_at, fire_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (organization_id, entity_kind, entity_id, lead_minutes) DO UPDATE
       SET due_at = EXCLUDED.due_at,
           fire_at = EXCLUDED.fire_at,
           enqueued_at = NULL,
           sent_at = NULL,
           updated_at = now()`,
      [
        newId(), input.organizationId, input.kind, input.id, lead,
        due.toISOString(),
        new Date(due.getTime() - lead * 60_000).toISOString(),
      ],
    );
  }
}

/**
 * Retires the pending notices for one item.
 *
 * Only unsent rows are deleted: a notice already delivered is history, and
 * leaving it means an item that is later rescheduled cannot be confused with
 * one whose old notices never went out. A reschedule re-arms through the upsert
 * above either way.
 */
export async function cancelEventReminders(
  scope: TenantScope,
  organizationId: string,
  kind: EventKind,
  id: string,
): Promise<void> {
  await scope.unsafe.query(
    `DELETE FROM event_reminders
    WHERE organization_id = $1 AND entity_kind = $2 AND entity_id = $3 AND sent_at IS NULL`,
    [organizationId, kind, id],
  );
}

/**
 * Moves every notice that has come due onto the queue, each one once.
 *
 * The claim is a single `UPDATE ... RETURNING` over a CTE, so two sweeps
 * racing cannot both take the same row, and a sweep that dies mid-pass leaves
 * the remaining rows claimable rather than lost. Rows already `sent_at` are
 * never touched, which is what keeps a retried job from sending twice.
 */
export async function sweepDueReminders(db?: DbClient): Promise<number> {
  const client = db ?? await getDb();
  const claimed = await client.query<{
    id: string; organization_id: string; entity_kind: string;
    entity_id: string; lead_minutes: number;
  }>(
    `WITH due AS (
      SELECT id FROM event_reminders
      WHERE sent_at IS NULL AND enqueued_at IS NULL AND fire_at <= now()
      ORDER BY fire_at
      LIMIT ${SWEEP_BATCH}
    )
    UPDATE event_reminders e SET enqueued_at = now()
    FROM due WHERE e.id = due.id
    RETURNING e.id, e.organization_id, e.entity_kind, e.entity_id, e.lead_minutes`,
  );

  let handedOff = 0;
  for (const row of claimed.rows) {
    try {
      await enqueue(
        {
          type: REMINDER_JOB_TYPE,
          organizationId: String(row.organization_id),
          payload: {
            reminderId: String(row.id),
            kind: String(row.entity_kind),
            entityId: String(row.entity_id),
            leadMinutes: Number(row.lead_minutes),
          },
        },
        client,
      );
      handedOff += 1;
    } catch (err) {
      // The row is already claimed, so an enqueue failure would strand the
      // notice forever. Hand it back to the next sweep instead.
      await client
        .query(`UPDATE event_reminders SET enqueued_at = NULL WHERE id = $1`, [row.id])
        .catch(() => undefined);
      logger.error({ err, reminderId: row.id }, 'could not enqueue a due reminder');
    }
  }
  return handedOff;
}

/**
 * Sends one due notice to everybody.
 *
 * The claim and the notifications share a transaction, which is what makes the
 * guarantee exact: a retried job, a duplicated job, or two workers racing all
 * find the row already sent and stop here, while a crash before anybody was
 * told rolls the claim back with everything else. The row's own `entity_kind`
 * decides what is read, never the payload -- a job cannot be pointed at a
 * different table than the ledger says it came from.
 */
export async function deliverDueReminder(job: Job): Promise<void> {
  const organizationId = job.organizationId;
  const reminderId = String(job.payload['reminderId'] ?? '');
  if (!organizationId || !UUID_RE.test(reminderId)) return;

  const scope = new TenantScope(organizationId);
  await scope.transaction(async (tx) => {
    const claimed = await tx.unsafe.query<{
      entity_kind: string; entity_id: string; lead_minutes: number; due_at: string;
    }>(
      `UPDATE event_reminders SET sent_at = now(), updated_at = now()
      WHERE organization_id = $1 AND id = $2 AND sent_at IS NULL
      RETURNING entity_kind, entity_id, lead_minutes, due_at`,
      [organizationId, reminderId],
    );
    const reminder = claimed.rows[0];
    if (!reminder) return;

    const kind = String(reminder.entity_kind) as EventKind;
    const entityId = String(reminder.entity_id);
    const lead = Number(reminder.lead_minutes);
    const dueAt = String(reminder.due_at);

    // Re-read the item: it may have been deleted, finished or un-dated since
    // the notice was armed, and a reminder about nothing is pure noise.
    const event = kind === 'task'
      ? await tx.queryOne(
        `SELECT title, status FROM tasks
        WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [organizationId, entityId],
      )
      : await tx.queryOne(
        `SELECT subject FROM activities
        WHERE organization_id = $1 AND id = $2 AND type = 'meeting'`,
        [organizationId, entityId],
      );
    if (!event) return;

    // A finished or abandoned task has no due time worth announcing.
    const status = String(event['status'] ?? '');
    if (status === 'completed' || status === 'cancelled') return;

    const raw = kind === 'task' ? event['title'] : event['subject'];
    const title = String(raw ?? '').trim().slice(0, TITLE_BUDGET) || 'Calendar event';

    await notifyAllMembers(tx, organizationId, {
      type: reminderType(lead),
      title: `Due in ${leadLabel(lead)}: ${title}`,
      body: `"${title}" is due at ${dueAt}.`,
      link: '/calendar',
      entityType: kind,
      entityId,
    });
  });
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Starts polling for notices that have come due. Idempotent, like the worker. */
export function startReminderSweep(intervalMs = DEFAULT_SWEEP_INTERVAL_MS): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweepDueReminders().catch((err) => {
      logger.error({ err }, 'reminder sweep threw');
    });
  }, intervalMs);
  sweepTimer.unref?.();
  logger.info({ intervalMs }, 'reminder sweep started');
}

export function stopReminderSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    logger.info('reminder sweep stopped');
  }
}

export const __testing = { SWEEP_BATCH, DEFAULT_SWEEP_INTERVAL_MS, TITLE_BUDGET };
