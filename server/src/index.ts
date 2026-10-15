/**
 * Process entrypoint.
 *
 * Responsibilities, in order: prove the configuration is safe, prove the schema
 * is current, open the database, start listening, and then install signal
 * handlers that drain rather than drop connections.
 *
 * A server that starts with an out-of-date schema serves 500s that look like
 * application bugs, so migrations are checked here and a missing one is fatal.
 */
import { createApp } from './app.ts';
import { env } from './config/env.ts';
import { initDriver } from './repositories/base.ts';
import { closeDb as closePool } from './db/driver.ts';
import { migrate, migrationStatus } from './db/migrate.ts';
import { initKeyProvider } from './lib/kms.ts';
import { logger } from './lib/logger.ts';
import { startRetentionScheduler, stopRetentionScheduler } from './services/retention.ts';

const SHUTDOWN_GRACE_MS = 15_000;

async function main(): Promise<void> {
  // 1. Configuration is validated at import time in config/env.ts — if we got
  //    here, the environment is internally consistent and fail-closed.

  // 1b. Field-encryption keys. The single KMS decrypt (when configured)
  //     happens here, before anything can encrypt: a KMS outage or a bad
  //     ciphertext refuses to boot rather than serving with no working MFA.
  const keys = await initKeyProvider();
  logger.info({ provider: keys.id }, 'field-encryption key provider ready');

  // 2. Database.
  await initDriver();

  // 3. Schema. Apply anything pending, then confirm we are current.
  const applied = await migrate();
  if (applied.applied.length > 0) {
    logger.warn({ applied: applied.applied }, 'migrations applied at startup');
  }
  const status = await migrationStatus();
  if (status.length === 0) {
    logger.error('no migrations recorded — refusing to serve');
    process.exit(1);
  }
  logger.info({ migrations: status.length, latest: status[status.length - 1]?.version }, 'schema ready');

  // 4. Optional integrations.
  //    DISABLED 2026-10-11: the MongoDB Atlas document store was removed. The
  //    PostgreSQL system of record is the only database this service uses, so a
  //    secondary store is not started, probed or awaited. The rationale is
  //    preserved in server/src/integrations/mongodb.ts, which is commented out.
  //
  //    The original loop here failed *open* — a degraded secondary store logged
  //    an error and continued. That is deliberate: the core CRM never depended on
  //    it, and refusing to start would have taken the product down for something
  //    non-essential. If a future integration IS essential to correctness, it must
  //    be checked with `if (!ok) process.exit(1)` instead.

  // 5. Listen.
  const app = createApp();
  const server = app.listen(env.port, env.host, () => {
    logger.info({
      host: env.host, port: env.port, env: env.envName, nodeEnv: env.nodeEnv,
    }, 'bigcrm api listening');
    // Plain line (not JSON) so the address is visible at a glance in dev:
    // the structured log above is easy to miss in a scrolling terminal.
    // `console.warn` (not `log`) because the lint config forbids `console.log`
    // while explicitly allowing warn/error — and a boot banner belongs on
    // stderr next to every other diagnostic this process emits.
    const displayHost = env.host === '0.0.0.0' ? 'localhost' : env.host;
    console.warn(`BigCRM API ready → http://${displayHost}:${env.port}  (app UI runs separately, see client README)`);
  });

  // Slightly above a typical 60s ALB idle timeout so the load balancer closes
  // first; otherwise Node answers with a 502 for a request the client abandoned.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // Bound the header read window: a slowloris client must not hold a socket.
  server.requestTimeout = 30_000;

  // ── graceful shutdown ──────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested — draining');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    server.close(() => {
      void (async () => {
        try {
          stopRetentionScheduler();
          await closePool();
          logger.info('shutdown complete');
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'error during shutdown');
          process.exit(1);
        }
      })();
    });
  };

  // 6. Retention. Bounded, batched, and never touching the audit trail.
  startRetentionScheduler();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state. Log it and
  // exit so the orchestrator restarts a clean process rather than a poisoned one.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection — exiting');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
