/**
 * Health, readiness and metrics.
 *
 * RULE 118: `/health` and `/ready` report *state only*. No version strings, no
 * hostnames, no dependency DSNs, no counts that would help an attacker size the
 * deployment. `/metrics` is not public -- see the guard below.
 */
import { Router } from 'express';
import { env } from '../../config/env.ts';
import { getDb } from '../../db/driver.ts';
import { asyncRoute } from './helpers.ts';
import { authenticate, requirePermission } from '../../middleware/security.ts';
import { metricsText } from '../../lib/metrics.ts';
import { logger } from '../../lib/logger.ts';

export const healthRouter = Router();

const startedAt = Date.now();

/** Liveness. Answers as long as the event loop can serve a request. */
healthRouter.get('/health', (_req, res) => {
 res.status(200).json({ status: 'ok' });
});

/**
 * Readiness. Checks the database, and fails closed when a required dependency is
 * down so the load balancer stops sending traffic rather than serving errors.
 */
healthRouter.get('/ready', asyncRoute(async (_req, res) => {
 const checks: Record<string, 'ok' | 'unavailable'> = {};
 let ok = true;

 const t0 = Date.now();
 try {
 await (await getDb()).query('SELECT 1');
 checks.database = 'ok';
 } catch (err) {
 checks.database = 'unavailable';
 ok = false;
 logger.error({ err }, 'readiness: database probe failed');
 }
 void t0;

 res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks });
}));

/**
 * Metrics. Gated three ways: it must be enabled, the caller must be
 * authenticated, and the caller must hold `security.read`. An open
 * `/metrics` endpoint is a reconnaissance gift -- it exposes request rates,
 * error classes and bucket names.
 *
 * The path is normalised to a leading slash: `METRICS_PATH` is configurable and
 * Express treats `'internal/metrics'` (no leading slash) as a different route
 * than `'/internal/metrics'`, so a misconfigured value silently 404s the
 * endpoint instead of exposing it. That direction of failure is safe, but it
 * makes the setting untestable, so it is fixed here rather than left to chance.
 */
const METRICS_ROUTE = `/${env.observability.metricsPath.replace(/^\/+/, '')}`;

healthRouter.get(METRICS_ROUTE,
 authenticate, requirePermission('security.read'),
 asyncRoute(async (_req, res) => {
 if (!env.observability.metricsEnabled) {
 res.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' });
 return;
 }
 res.type('text/plain; version=0.0.4').send(await metricsText());
 }));

export const __testing = { startedAt, METRICS_ROUTE };
