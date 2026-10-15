/**
 * Background worker entrypoint.
 *
 * Boots like the API (validated config, driver, current schema) and then runs
 * the job-queue worker instead of listening. Run it as a separate process
 * next to as many API replicas as needed -- claiming is race-safe, so workers
 * never double-execute a job:
 *
 * npm run worker
 *
 * Handlers are registered here, at the composition root, never inside the
 * queue module: the queue is transport, this file decides what runs. Today
 * no production handlers are registered (see §4.4 -- the designated first
 * workloads are the export runner and notification digests, both of which
 * need their sync contracts reworked first), so a production worker idles.
 * That is deliberate and documented, not an oversight: an idle worker that is
 * tested beats a busy one wired to the wrong workload.
 */
import { initDriver } from './repositories/base.ts';
import { migrate, migrationStatus } from './db/migrate.ts';
import { logger } from './lib/logger.ts';
import { startWorker, stopWorker } from './services/queue.ts';

const WORKER_ID = `worker-${process.pid}`;
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5_000);

async function main(): Promise<void> {
 await initDriver();
 await migrate();
 const status = await migrationStatus();
 if (status.length === 0) {
 logger.error('no migrations recorded -- refusing to work');
 process.exit(1);
 }

 startWorker(WORKER_ID, INTERVAL_MS);

 const shutdown = (signal: string): void => {
 logger.info({ signal }, 'worker shutdown requested');
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
