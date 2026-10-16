/**
 * Express application assembly.
 *
 * Middleware order is load-bearing (see `docs/SECURITY_ARCHITECTURE.md`):
 * `trust proxy` -> request id -> security headers -> CORS -> body parsers ->
 * global limiter -> read-only guard -> routes -> error handlers. CORS precedes
 * the limiter so a rejected preflight is not rate-limited into a confusing 429;
 * the read-only guard follows it so a maintenance probe gets a clean 503.
 */
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { env } from './config/env.ts';
import {
 requestContext, securityHeaders, corsPolicy, globalLimiter,
 notFoundHandler, errorHandler, readOnlyGuard,
} from './middleware/security.ts';
import { v1Router } from './routes/v1/index.ts';
import { healthRouter } from './routes/v1/health.ts';
import { logger } from './lib/logger.ts';

export function createApp(): Express {
 const app = express();

 // RULE 67/171: trust exactly `trustProxyHops` proxies. `true` would let any
 // client assert its own address and walk through IP rate limits.
 app.set('trust proxy', env.trustProxyHops);
 app.disable('x-powered-by');
 app.disable('etag');

 app.use(requestContext);
 app.use(securityHeaders);
 app.use(corsPolicy());

 // Health sits before the limiter (a probe must not be throttled into a false
 // outage) and before auth (a load balancer has no session).
 app.use('/', healthRouter);

 app.use(cookieParser());
 app.use(express.json({ limit: env.bodyLimitBytes, strict: true }));
 app.use(express.urlencoded({ extended: false, limit: env.bodyLimitBytes }));
 // Raw CSV for `POST /api/v1/transfers/imports`, and raw bytes for
 // `POST /api/v1/attachments`. Without these parsers both bodies arrive
 // unparsed and 400. Scoped by content type so JSON routes are unaffected.
 app.use(express.text({ type: ['text/csv', 'text/plain'], limit: env.bodyLimitBytes }));
 app.use(express.raw({ type: 'application/octet-stream', limit: env.bodyLimitBytes }));
 app.use(globalLimiter);
 app.use(readOnlyGuard);

 app.use('/api/v1', v1Router);
 app.use(notFoundHandler);
 app.use(errorHandler);

 logger.debug({ routes: 'mounted', prefix: '/api/v1' }, 'app assembled');
 return app;
}

export default createApp;