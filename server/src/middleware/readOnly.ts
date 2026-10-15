/**
 * Read-only degraded mode guard.
 *
 * When `env.security.readOnlyMode` is true, this middleware rejects every
 * state-changing request (anything except GET, HEAD, OPTIONS) with 503,
 * before it reaches the router. Reads continue to serve normally so the
 * API stays usable for reference during a database failover, restore, or
 * any maintenance where writes are unsafe but the API must stay up.
 *
 * The switch lives in the environment, not the database: the mode exists for
 * when the database cannot be trusted, so its switch cannot live inside the
 * database. An operator toggles it via `READ_ONLY_MODE=true` and restarts
 * (or signals) the API containers.
 */
import express from 'express';
import { env } from '../config/env.ts';
import { serviceUnavailable } from '../lib/errors.ts';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Middleware that rejects non-read requests when read-only mode is enabled.
 * Placed after authentication but before the router so it covers every route.
 */
export function readOnlyGuard(req: express.Request, _res: express.Response, next: express.NextFunction): void {
 if (!env.security.readOnlyMode) return next();
 if (READ_METHODS.has(req.method)) return next();

 // The request body may contain credentials or PII; do not log it.
 // The request ID is always safe.
 throw serviceUnavailable('Service is in read-only mode; this operation is not available.');
}