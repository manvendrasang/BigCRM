-- 0007 — durable job queue.
--
-- A `job_queue` table is the durable half of background work: rows survive
-- restarts, and claiming uses `FOR UPDATE SKIP LOCKED` so N workers (or N
-- replicas each running a worker) never execute the same job twice. Statuses
-- are `queued` → `claimed` → `completed`, with `failed` terminal after
-- `max_attempts`. `run_at` is both "not before" scheduling and the backoff
-- mechanism — a failed attempt re-queues itself in the future rather than
-- needing a separate retry table.
--
-- `organization_id` is nullable on purpose: some jobs are per-tenant
-- (a future export runner), some are global (retention sweeps). Tenant
-- isolation for per-tenant jobs is enforced by the handler reading the row's
-- own `organization_id`, never by trusting the payload.
CREATE TABLE IF NOT EXISTS job_queue (
  id               uuid PRIMARY KEY,
  organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (length(btrim(type)) BETWEEN 1 AND 80),
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','claimed','completed','failed')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  run_at           timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  claimed_by       text,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
-- The dispatcher read: due, unclaimed rows first. Partial so the steady-state
-- table (mostly completed history) costs nothing to skip.
CREATE INDEX IF NOT EXISTS idx_job_queue_due
  ON job_queue (run_at, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_job_queue_org
  ON job_queue (organization_id, status) WHERE organization_id IS NOT NULL;
