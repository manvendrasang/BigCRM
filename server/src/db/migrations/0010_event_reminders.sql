-- 0010 -- due reminders for calendar events.
--
-- A meeting, or a task with a due date, earns the workspace two advance
-- notices: one an hour before it is due, one fifteen minutes before. Those two
-- instants are in the future, so they cannot be written as notifications at
-- creation time -- a notification written now is a notification *now*. They
-- have to become scheduled work instead, and this table is where that
-- scheduling is remembered.
--
-- The table is an idempotency ledger, not a queue. The queue says "run this";
-- this table says "this notice has already gone out". Both halves are needed:
-- without the ledger, every retry of a failed job and every sweep that races a
-- worker would send the same "due in an hour" twice, which is the one failure
-- a reminder cannot shrug off.
--
-- `entity_id` has no foreign key on purpose: a reminder points at either an
-- `activities` row (a meeting) or a `tasks` row, and one column cannot
-- reference two tables. The handler re-reads the row it names and delivers
-- nothing when that row is gone, so an orphan is a no-op rather than a leak.
CREATE TABLE IF NOT EXISTS event_reminders (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 entity_kind text NOT NULL CHECK (entity_kind IN ('meeting','task')),
 entity_id uuid NOT NULL,
 lead_minutes integer NOT NULL CHECK (lead_minutes BETWEEN 1 AND 10080),
 due_at timestamptz NOT NULL,
 fire_at timestamptz NOT NULL,
 enqueued_at timestamptz,
 sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 -- One row per notice per event. Rescheduling rewrites `fire_at` in place and
 -- re-arms the row, so moving a meeting cannot pile up a trail of stale
 -- notices behind it.
 CONSTRAINT uq_event_reminders_notice
 UNIQUE (organization_id, entity_kind, entity_id, lead_minutes)
);
-- The sweep read: unsent rows, soonest first. Partial, so the settled ledger
-- (already-delivered history) costs nothing to skip.
CREATE INDEX IF NOT EXISTS idx_event_reminders_pending
 ON event_reminders (fire_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_reminders_org
 ON event_reminders (organization_id, entity_id);
