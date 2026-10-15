/**
 * Durable job queue (PostgreSQL-backed).
 *
 * The seam where SQS plugs in: `enqueue`/`claimNext`/`complete`/`fail` are
 * the only operations a backend must provide, and the worker loop below only
 * speaks to them. Today the backend is this table; when SQS exists, the
 * worker becomes a long-polling consumer and this module keeps its shape —
 * producers (`enqueue` callers) do not change.
 *
 * Claiming is one statement (`SELECT ... FOR UPDATE SKIP LOCKED` inside a
 * CTE feeding the UPDATE), so two workers racing the same row cannot both
 * win it — on real PostgreSQL via row locks, on PGlite via session
 * serialisation. A crashed worker's claim is NOT auto-released (there is no
 * lease here, deliberately): a job stuck `claimed` is visible in the table
 * and re-runnable by hand, whereas an invisible lease turns a stuck job into
 * a duplicate execution. At-least-once with visible stuck rows beats
 * at-most-once with silent loss.
 */
import { getDb } from '../db/driver.ts';
import type { DbClient } from '../db/driver.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { logger } from '../lib/logger.ts';

export interface Job {
  id: string;
  organizationId: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
}

export type JobHandler = (job: Job) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/** Registers the function that executes jobs of one type. Last write wins. */
export function registerHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

/** Removes all handlers. Tests only — production wires once at boot. */
export function clearHandlers(): void {
  handlers.clear();
}

const toJob = (r: Record<string, unknown>): Job => ({
  id: String(r['id']),
  organizationId: r['organization_id'] === null ? null : String(r['organization_id']),
  type: String(r['type']),
  payload: (r['payload'] as Record<string, unknown>) ?? {},
  status: String(r['status']),
  attempts: Number(r['attempts'] ?? 0),
  maxAttempts: Number(r['max_attempts'] ?? 5),
  runAt: String(r['run_at']),
});

export async function enqueue(
  input: {
    type: string; payload?: Record<string, unknown>;
    organizationId?: string | null; runAt?: string; maxAttempts?: number;
  },
  db?: DbClient,
): Promise<string> {
  const type = String(input.type ?? '').trim();
  if (type.length < 1 || type.length > 80) throw new Error('Job type is required (1–80 chars).');
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 25) {
    throw new Error('maxAttempts must be an integer 1–25.');
  }
  const runAt = input.runAt ?? nowIso();
  if (Number.isNaN(new Date(runAt).getTime())) throw new Error('runAt must be a valid date.');
  const client = db ?? await getDb();
  const id = newId();
  await client.query(
    `INSERT INTO job_queue (id, organization_id, type, payload, max_attempts, run_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
    [id, input.organizationId ?? null, type, JSON.stringify(input.payload ?? {}), maxAttempts, runAt],
  );
  return id;
}

const BACKOFF_MS = [30_000, 300_000, 1_800_000, 10_800_000];

/** Backoff for attempt N (1-based): 30s, 5m, 30m, then 3h. Exported for tests. */
export function backoffForAttempt(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1]!;
}

/**
 * Claims the next due job. Exactly one caller wins each row: the CTE locks
 * the candidate with SKIP LOCKED and the UPDATE only fires on it, in a
 * single statement, so there is no read-then-write race to close.
 */
export async function claimNext(workerId: string, db?: DbClient): Promise<Job | null> {
  const client = db ?? await getDb();
  const rows = await client.query(
    `WITH next AS (
       SELECT id FROM job_queue
        WHERE status = 'queued' AND run_at <= now()
        ORDER BY run_at, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE job_queue j
        SET status = 'claimed', claimed_at = now(), claimed_by = $1, attempts = j.attempts + 1
       FROM next WHERE j.id = next.id AND j.status = 'queued'
     RETURNING j.id, j.organization_id, j.type, j.payload, j.status, j.attempts, j.max_attempts, j.run_at`,
    [workerId],
  );
  const row = rows.rows[0];
  return row ? toJob(row) : null;
}

export async function complete(jobId: string, db?: DbClient): Promise<void> {
  const client = db ?? await getDb();
  await client.query(
    `UPDATE job_queue SET status = 'completed', finished_at = $2 WHERE id = $1`,
    [jobId, nowIso()],
  );
}

/**
 * Records a failure. Attempts past the budget go terminal (`failed`,
 * inspectable in the table); anything else re-queues with backoff. The
 * decision reads the row's own counters, so a worker crash between claim and
 * fail cannot double-spend the budget — the next failure observes the
 * already-incremented attempt count.
 */
export async function fail(jobId: string, error: unknown, db?: DbClient): Promise<void> {
  const client = db ?? await getDb();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const row = await client.query<{ attempts: number; max_attempts: number }>(
    `SELECT attempts, max_attempts FROM job_queue WHERE id = $1 AND status = 'claimed'`,
    [jobId],
  );
  const current = row.rows[0];
  // Already settled (or never claimed): nothing to do. Settle paths are
  // idempotent so a retried settle cannot resurrect a finished job.
  if (!current) return;
  if (current.attempts >= current.max_attempts) {
    await client.query(
      `UPDATE job_queue SET status = 'failed', last_error = $2, finished_at = $3
        WHERE id = $1 AND status = 'claimed'`,
      [jobId, message, nowIso()],
    );
    return;
  }
  const waitMs = backoffForAttempt(current.attempts);
  await client.query(
    `UPDATE job_queue SET status = 'queued', last_error = $2, run_at = now() + ($3 * interval '1 second')
      WHERE id = $1 AND status = 'claimed'`,
    [jobId, message, waitMs / 1000],
  );
}

/**
 * One worker pass: claim, run, settle. Unknown job types fail the job rather
 * than crashing the loop — an unregistered type is a deployment bug, and the
 * failed row says so instead of wedging the worker.
 */
export async function runWorkerOnce(workerId: string, db?: DbClient): Promise<Job | null> {
  const client = db ?? await getDb();
  const job = await claimNext(workerId, client);
  if (!job) return null;
  const handler = handlers.get(job.type);
  if (!handler) {
    await fail(job.id, `no handler registered for job type '${job.type}'`, client);
    logger.error({ jobId: job.id, type: job.type }, 'job failed: unregistered type');
    return job;
  }
  try {
    await handler(job);
    await complete(job.id, client);
  } catch (err) {
    await fail(job.id, err, client);
    logger.error({ err, jobId: job.id, type: job.type }, 'job attempt failed');
  }
  return job;
}

let workerTimer: ReturnType<typeof setInterval> | null = null;

/** Starts the polling worker. Mirrors the retention scheduler's shape. */
export function startWorker(workerId: string, intervalMs = 5_000): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void runWorkerOnce(workerId).catch((err) => {
      logger.error({ err }, 'worker pass threw');
    });
  }, intervalMs);
  workerTimer.unref?.();
  logger.info({ workerId, intervalMs }, 'job worker started');
}

export function stopWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    logger.info('job worker stopped');
  }
}

export const __testing = { BACKOFF_MS, backoffForAttempt };
