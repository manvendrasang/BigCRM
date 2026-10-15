/**
 * Express application assembly.
 *
 * Middleware order is load-bearing and is documented in
 * `docs/SECURITY_ARCHITECTURE.md`. The short version:
 *
 * 1. `trust proxy` -- so `req.ip` is the real client, but only for a fixed
 * number of hops; an unbounded value lets a client
 * spoof `X-Forwarded-For` and defeat IP rate limiting.
 * 2. `requestContext` -- assign/validate the request id before anything logs.
 * 3. `securityHeaders` -- headers are set on every response, including errors.
 * 4. `corsPolicy` -- must precede the limiter so a rejected preflight is
 * not rate-limited into a confusing 429.
 * 5. parsers -- a size cap, so a large body is refused before parsing.
 * 6. `globalLimiter` -- broad bucket for everything.
 * 7. routes -- each applies its own authenticate/permission chain.
 * 8. `notFoundHandler` / `errorHandler` -- terminal, and the only place an
 * error message is turned into a response.
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

 // RULE 67/171: exactly `trustProxyHops` proxies are trusted. `true` would let
 // any client assert its own address and walk straight through IP rate limits.
 app.set('trust proxy', env.trustProxyHops);
 app.disable('x-powered-by');
 app.disable('etag');

 app.use(requestContext);
 app.use(securityHeaders);
 app.use(corsPolicy());

 // Health is mounted before the global limiter so a probe cannot be throttled
 // into reporting a false outage -- and it is mounted before any auth because a
 // load balancer has no session.
 app.use('/', healthRouter);

 app.use(cookieParser());
 app.use(express.json({ limit: env.bodyLimitBytes, strict: true }));
 app.use(express.urlencoded({ extended: false, limit: env.bodyLimitBytes }));
 // Raw CSV bodies for the import endpoint (`POST /api/v1/transfers/imports`,
 // Content-Type: text/csv). Without this the body arrives unparsed and every
 // import 400s with "must be CSV text" -- which is what the first live probe
 // proved. Scoped to text/csv and text/plain only, so JSON routes are
 // unaffected; the size limit matches the JSON body limit.
 app.use(express.text({ type: ['text/csv', 'text/plain'], limit: env.bodyLimitBytes }));
 // Raw bytes for the attachment upload (`POST /api/v1/attachments`,
 // Content-Type: application/octet-stream). Same scoping rationale as above.
 app.use(express.raw({ type: 'application/octet-stream', limit: env.bodyLimitBytes }));
 app.use(globalLimiter);

 // Read-only degraded mode: rejects all non-GET/HEAD/OPTIONS requests with 503
 // when `READ_ONLY_MODE=true`. Placed after the limiter so a probe during a
 // maintenance window gets the 503 cleanly rather than a 429 from the limiter
 // fighting the guard. Reads bypass the guard entirely so the API stays
 // usable for reference during a database failover or restore.
 app.use(readOnlyGuard);

 app.use('/api/v1', v1Router);

 // Anything not matched above.
 app.use(notFoundHandler);
 app.use(errorHandler);

 logger.debug({ routes: 'mounted', prefix: '/api/v1' }, 'app assembled');
 return app;
}

export default createApp;
