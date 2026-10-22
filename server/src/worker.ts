/**
 * Background worker entrypoint: boots like the API, then runs the job-queue
 * worker instead of listening. Run it as a separate process beside as many API
 * replicas as needed -- claiming is race-safe, so workers never double-execute
 * a job.
 *
 * `npm run worker`
 *
 * Handlers are registered here at the composition root, never inside the queue
 * module: the queue is transport, this file decides what runs.
 *
 * Two things run in this process. The queue worker executes jobs -- today only
 * `event_due_reminder`, which sends the two advance notices every meeting and
 * dated task earns. Beside it, the reminder sweep is the clock that notices
 * those jobs have come due and hands them over; it is separate from the
 * dispatch loop because finding work and running work are different jobs, and
 * a slow handler should not delay the search for the next one.
 */
import { initDriver } from './repositories/base.ts';
import { migrate, migrationStatus } from './db/migrate.ts';
import { logger } from './lib/logger.ts';
import { registerHandler, startWorker, stopWorker } from './services/queue.ts';
import {
 deliverDueReminder,
 startReminderSweep,
 stopReminderSweep,
 REMINDER_JOB_TYPE,
} from './services/reminders.ts';

const WORKER_ID = `worker-${process.pid}`;
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5_000);
const SWEEP_INTERVAL_MS = Number(process.env.REMINDER_SWEEP_INTERVAL_MS ?? 30_000);

registerHandler(REMINDER_JOB_TYPE, deliverDueReminder);

async function main(): Promise<void> {
 await initDriver();
 await migrate();
 const status = await migrationStatus();
 if (status.length === 0) {
 logger.error('no migrations recorded -- refusing to work');
 process.exit(1);
 }

 startWorker(WORKER_ID, INTERVAL_MS);
 startReminderSweep(SWEEP_INTERVAL_MS);

 const shutdown = (signal: string): void => {
 logger.info({ signal }, 'worker shutdown requested');
 stopReminderSweep();
 stopWorker();
 process.exit(0);
 };
 process.on('SIGTERM', () => shutdown('SIGTERM'));
 process.on('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((err) => {
 logger.fatal({ err }, 'worker failed to start');
 process.exit(1);
});
