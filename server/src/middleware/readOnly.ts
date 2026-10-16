/**
 * Read-only degraded mode.
 *
 * When `READ_ONLY_MODE=true`, every non-GET/HEAD/OPTIONS request is rejected
 * with 503 before reaching a route, so reads keep serving during a failover or
 * restore. The switch lives in the environment rather than the database
 * precisely because the mode exists for when the database cannot be trusted.
 */
import express from 'express';
import { env } from '../config/env.ts';
import { serviceUnavailable } from '../lib/errors.ts';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Mounted after authentication and before the router, so it covers every route. */
export function readOnlyGuard(req: express.Request, _res: express.Response, next: express.NextFunction): void {
 if (!env.security.readOnlyMode) return next();
 if (READ_METHODS.has(req.method)) return next();

 // The body may carry credentials or PII; only the request id is safe to log.
 throw serviceUnavailable('Service is in read-only mode; this operation is not available.');
}