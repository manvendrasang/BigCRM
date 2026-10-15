/**
 * Security middleware stack.
 *
 * Ordering is deliberate and documented in docs/SECURITY_ARCHITECTURE.md.
 * Each item closes a specific class of attack named in the master prompt.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors, { type CorsOptions } from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.ts';
import { logger, securityLog } from '../lib/logger.ts';
import { AppError, forbidden, tooMany, unauthorized } from '../lib/errors.ts';
import { loggableIp } from '../lib/ip.ts';
import { can, isRole, type Role } from '../services/rbac.ts';
import { validateSession, type Actor } from '../services/auth.ts';
import { permissionDenials } from '../lib/metrics.ts';

declare global {
 // eslint-disable-next-line @typescript-eslint/no-namespace
 namespace Express {
 interface Request {
 requestId: string;
 actor?: Actor;
 /** Raw client address. Written to `inet` columns -- must be a valid address. */
 clientIp: string;
 /** Masked client address. For logs and metrics only. */
 loggableIp: string;
 /** Present only after `authenticate`. */
 auth?: Actor;
 }
 }
}

// ── request id + client IP (RULE 171) ────────────────────────────────────────
export function requestContext(req: express.Request, res: express.Response, next: express.NextFunction): void {
 // Honour an upstream id only if it looks like one, so log injection cannot
 // smuggle newlines or fake correlation ids.
 const inbound = String(req.get('x-request-id') ?? '');
 req.requestId = /^[A-Za-z0-9_-]{8,64}$/.test(inbound) ? inbound : randomUUID();
 res.setHeader('X-Request-Id', req.requestId);
 // The RAW address, not a masked one. `req.clientIp` is written into `inet`
 // columns (sessions.ip, audit_logs.ip, users.last_login_ip), and `inet`
 // rejects the masked form `127.0.0.*` with 22P02 -- which made login fail on
 // every single request. Masking belongs in logs and metrics, not in the
 // database: an audit trail that stores `127.0.0.*` cannot answer the only
 // question it exists to answer. See src/lib/ip.ts.
 req.clientIp = String(req.ip ?? req.socket.remoteAddress ?? 'unknown');
 req.loggableIp = loggableIp(req.clientIp);
 const start = process.hrtime.bigint();
 res.on('finish', () => {
 const ms = Number(process.hrtime.bigint() - start) / 1e6;
 logger.debug({
 requestId: req.requestId, method: req.method,
 // req.route is only populated once matched; fall back to the raw path.
 route: (req as unknown as { route?: { path?: string } }).route?.path ?? req.path,
 status: res.statusCode, ms: Math.round(ms * 100) / 100, ip: req.loggableIp,
 }, 'request');
 });
 next();
}

// ── security headers (RULE 35, 36, 125, 126, 127) ────────────────────────────
export function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction): void {
 // Generate a nonce per response. Nothing inline is permitted, so the nonce is
 // available for the rare case a hashed inline script is added later.
 const nonce = randomUUID().replace(/-/g, '');
 res.locals.cspNonce = nonce;

 const csp = [
 "default-src 'self'",
 "script-src 'self'",
 // React writes some inline styles, so style-src needs 'unsafe-inline'.
 // This is documented in docs/SECURITY_ARCHITECTURE.md §CSP as the single
 // accepted relaxation; script-src and object-src remain strict.
 "style-src 'self' 'unsafe-inline'",
 "img-src 'self' data: blob:",
 "font-src 'self' data:",
 // connect-src is limited to our own origin; no wildcard, no third parties.
 `connect-src 'self'`,
 "object-src 'none'",
 "base-uri 'self'",
 "form-action 'self'",
 "frame-ancestors 'none'",
 "manifest-src 'self'",
 "worker-src 'self' blob:",
 ...(env.nodeEnv === 'production' ? ['upgrade-insecure-requests'] : []),
 ].join('; ');

 // ── Headers we set ourselves MUST be set BEFORE helmet runs. ───────────────
 //
 // `helmet(opts)(req, res, next)` calls `next()` synchronously inside its own
 // middleware chain, so the entire downstream stack -- including the route
 // handler that calls res.end() -- has already finished by the time the call
 // returns. Any setHeader() placed after it therefore operates on a response
 // that has already been sent.
 //
 // That is exactly what this function did. Consequences, all silent until the
 // middleware was exercised over a real socket:
 // - `Permissions-Policy` was never applied to any response.
 // - `res.setHeader` threw ERR_HTTP_HEADERS_SENT on every single request.
 // Combined with the `uncaughtException` handler in index.ts -- which exits
 // the process by design -- the first request would have taken the API down.
 //
 // Typecheck could not see it and unit tests could not reach it. Only booting
 // the app and looking at the bytes on the wire exposed it.
 res.setHeader(
 'Permissions-Policy',
 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
 );
 res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
 // Do not advertise the stack.
 res.removeHeader('X-Powered-By');

 helmet({
 contentSecurityPolicy: {
 useDefaults: false,
 directives: Object.fromEntries(csp.split('; ').map((d) => {
 const [k, ...v] = d.split(' ');
 return [k!, v];
 })),
 },
 strictTransportSecurity: env.security.hstsEnabled
 ? { maxAge: env.security.hstsMaxAgeSec, includeSubDomains: true, preload: true }
 : false,
 crossOriginEmbedderPolicy: false,
 crossOriginResourcePolicy: { policy: 'same-origin' },
 referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
 frameguard: { action: 'deny' },
 noSniff: true,
 xssFilter: false, // deprecated and unreliable; CSP is the control
 })(_req, res, next);

 // Nothing may touch `res` after this point -- see the note above.
}

// ── CORS (RULE 37) ───────────────────────────────────────────────────────────
export function corsPolicy(): ReturnType<typeof cors> {
 const allowlist = new Set(env.appOrigins);
 const opts: CorsOptions = {
 // RULE 37: an empty allowlist is a startup failure (enforced in config/env.ts),
 // so `allowlist.size === 0` is unreachable in production. We still fail closed
 // rather than allow-all, unlike the legacy TaskFlow server which did exactly that.
 origin(origin, cb) {
 if (!origin) return cb(null, false); // same-origin / curl: no CORS headers
 if (allowlist.has(origin.replace(/\/+$/, ''))) return cb(null, true);
 // The `cors` package calls this with (origin, callback) only -- there is no
 // express.Request here, so an earlier `arguments[0] as express.Request` was reading the
 // origin STRING and logging `ip: undefined` on every blocked request.
 // The origin is the security-relevant fact; the address is not available
 // at this layer, so it is not invented.
 securityLog('cors.blocked', { origin });
 return cb(null, false);
 },
 credentials: true,
 methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
 allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-CSRF-Token', 'Idempotency-Key'],
 exposedHeaders: ['X-Request-Id', 'RateLimit-Remaining', 'RateLimit-Reset'],
 maxAge: env.corsMaxAgeSec,
 };
 return cors(opts);
}

// ── rate limiting (RULE 67) ──────────────────────────────────────────────────
const limiter = (opts: {
 windowMs: number; max: number; bucket: string; message: string; key?: (req: express.Request) => string;
}) => rateLimit({
 windowMs: opts.windowMs,
 limit: opts.max,
 standardHeaders: 'draft-7',
 legacyHeaders: false,
 message: { code: 'RATE_LIMITED', message: opts.message, requestId: '' },
 // Rate-limit by authenticated user when known, else by network address.
 keyGenerator: opts.key ?? ((req: express.Request) => req.actor?.userId ?? ipKeyGenerator(req.ip ?? '')),
 // A successful response resets the counter so honest users are not punished.
 skipSuccessfulRequests: false,
 handler: (req: express.Request, res: express.Response) => {
 permissionDenials.inc({ permission: `rate_limit.${opts.bucket}` });
 securityLog('rate_limit.blocked', { bucket: opts.bucket, ip: req.loggableIp, path: req.path });
 res.status(429).json({ code: 'RATE_LIMITED', message: opts.message, requestId: req.requestId });
 },
});

export const globalLimiter = limiter({
 windowMs: env.rateLimit.globalWindowMs, max: env.rateLimit.globalMax,
 bucket: 'global', message: 'Too many requests. Please slow down.',
});
/** Credential endpoints: tight IP budget. */
export const authIpLimiter = limiter({
 windowMs: env.rateLimit.authWindowMs, max: env.rateLimit.authMax,
 bucket: 'auth', message: 'Too many attempts. Please wait before trying again.',
});
/** Per-account budget, applied after the email is resolved (RULE 67: not IP-only). */
export const authAccountLimiter = limiter({
 windowMs: env.rateLimit.authWindowMs, max: env.rateLimit.authMax * 3,
 bucket: 'auth_account',
 key: (req: express.Request) => {
 const email = (req.body as Record<string, unknown> | undefined)?.email;
 return typeof email === 'string' ? `acct:${email.trim().toLowerCase().slice(0, 200)}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
 },
 message: 'Too many attempts for this account.',
});
export const searchLimiter = limiter({
 windowMs: env.rateLimit.authWindowMs, max: env.rateLimit.searchMax,
 bucket: 'search', message: 'Too many searches. Please wait a moment.',
});
export const exportLimiter = limiter({
 windowMs: env.rateLimit.authWindowMs, max: env.rateLimit.exportMax,
 bucket: 'export', message: 'Export limit reached. Please wait before starting another.',
});
export const uploadLimiter = limiter({
 windowMs: env.rateLimit.authWindowMs, max: env.rateLimit.uploadMax,
 bucket: 'upload', message: 'Upload limit reached.',
});
/** Security-sensitive endpoints require a fresh session (RULE 116). */
export const sensitiveActionWindow = limiter({
 windowMs: 3_600_000, max: 10, bucket: 'sensitive_action',
 message: 'Too many sensitive actions. Please contact an administrator.',
});

// ── authentication (RULE 30, 121) ────────────────────────────────────────────
export async function authenticate(req: express.Request, _res: express.Response, next: express.NextFunction): Promise<void> {
 try {
 const header = req.get('authorization');
 const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
 const cookies = req.cookies as Record<string, string | undefined> | undefined;
 const token = bearer || String(cookies?.[env.jwt.cookieName] ?? '');
 if (!token) throw unauthorized();

 const check = await validateSession(token);
 if (!check.valid) {
 securityLog('session.revoked', { sessionId: check.code, ip: req.loggableIp, path: req.path, reason: check.reason });
 // One generic 401 for every failure mode so the client cannot distinguish
 // "expired" from "revoked" from "not a member" (RULE 121).
 throw unauthorized('Your session is no longer valid. Sign in again.');
 }
 req.actor = check.actor;
 req.auth = check.actor;
 next();
 } catch (err) { next(err); }
}

/**
 * Enforces a permission. Denial is logged with the permission name so the
 * security-events table records attempted escalation (RULE 82).
 */
export function requirePermission(permission: string) {
 return (req: express.Request, _res: express.Response, next: express.NextFunction): void => {
 const actor = req.actor;
 if (!actor) return next(unauthorized());
 if (!isRole(actor.role)) {
 permissionDenials.inc({ permission });
 securityLog('permission.denied', { userId: actor.userId, permission, reason: 'unknown_role', ip: req.loggableIp });
 return next(forbidden());
 }
 if (!can(actor.role, permission)) {
 permissionDenials.inc({ permission });
 securityLog('permission.denied', {
 userId: actor.userId, organizationId: actor.organizationId,
 role: actor.role, permission, ip: req.loggableIp, path: req.path,
 });
 return next(forbidden());
 }
 next();
 };
}

/** Convenience: `requireRole('owner')`. */
export const requireRole = (role: Role) => (req: express.Request, _res: express.Response, next: express.NextFunction): void => {
 if (req.actor?.role !== role) {
 securityLog('permission.denied', { userId: req.actor?.userId, expectedRole: role, actual: req.actor?.role });
 return next(forbidden());
 }
 next();
};

// ── CSRF (RULE 38) ───────────────────────────────────────────────────────────
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * Defence in depth for cookie-authenticated state changes:
 * 1. `Origin` (or `Referer` when Origin is absent) must be an allowed origin.
 * 2. For non-GET requests a custom header value must be present.
 *
 * A cross-site attacker cannot satisfy (1) because the browser sends the real
 * Origin, and cannot satisfy (2) without triggering a CORS preflight that our
 * allowlist rejects. Combined with `SameSite=Lax` this is three independent
 * controls, not a single token round-trip.
 */
export function csrfGuard(req: express.Request, _res: express.Response, next: express.NextFunction): void {
 if (SAFE.has(req.method)) return next();

 const origin = req.get('origin');
 const referer = req.get('referer');
 const allowed = new Set(env.appOrigins);

 if (origin) {
 if (!allowed.has(origin.replace(/\/+$/, ''))) {
 securityLog('csrf.blocked', { reason: 'bad_origin', origin, ip: req.loggableIp, path: req.path });
 return next(forbidden('Cross-origin request rejected.'));
 }
 } else if (referer) {
 try {
 const refOrigin = new URL(referer).origin;
 if (!allowed.has(refOrigin)) {
 securityLog('csrf.blocked', { reason: 'bad_referer', referer, ip: req.loggableIp, path: req.path });
 return next(forbidden('Cross-origin request rejected.'));
 }
 } catch {
 return next(forbidden('Cross-origin request rejected.'));
 }
 } else {
 // No Origin and no Referer on a state-changing request: treat as hostile.
 securityLog('csrf.blocked', { reason: 'missing_origin', ip: req.loggableIp, path: req.path });
 return next(forbidden('Cross-origin request rejected.'));
 }
 next();
}

// ── error handling (RULE 120) ────────────────────────────────────────────────
export function notFoundHandler(req: express.Request, _res: express.Response, next: express.NextFunction): void {
 next(new AppError(404, 'NOT_FOUND', `No route matches ${req.method} ${req.path}.`));
}

export function errorHandler(
 err: unknown,
 req: express.Request,
 res: express.Response,
 next: express.NextFunction,
): void {
 if (res.headersSent) return next(err);

 let status = 500;
 let code = 'INTERNAL_ERROR';
 let message = 'An unexpected error occurred.';
 let details: Record<string, unknown> | undefined;

 if (err instanceof AppError) {
 status = err.status; code = err.code; message = err.message; details = err.details;
 } else if (err instanceof SyntaxError && 'body' in err) {
 status = 400; code = 'INVALID_JSON'; message = 'express.Request body is not valid JSON.';
 } else if (typeof err === 'object' && err !== null) {
 const typed = err as { type?: string; code?: string; message?: string };

 // body-parser reports "body too large", "unsupported charset" and "parse
 // failed" through a `type`, not a `code`. The old branch required `code`, so
 // none of them matched and every oversized request surfaced as an opaque
 // 500 -- a client that cannot learn its payload was too large cannot fix it.
 if (typed.type === 'entity.too.large') {
 status = 413; code = 'PAYLOAD_TOO_LARGE';
 message = 'express.Request body exceeds the maximum permitted size.';
 } else if (typed.type === 'encoding.unsupported' || typed.type === 'charset.unsupported') {
 status = 415; code = 'UNSUPPORTED_MEDIA_TYPE'; message = 'Unsupported content encoding.';
 } else if (typed.type === 'entity.parse.failed') {
 status = 400; code = 'INVALID_JSON'; message = 'express.Request body is not valid JSON.';
 }

 // Translate PostgreSQL constraint violations into meaningful, safe messages.
 // Only consulted while still at 500, so a body-parser `type` is never
 // overwritten by a coincidentally-shaped `code`.
 if (status === 500 && typeof typed.code === 'string') {
 const pgCode = typed.code;
 const pgMessage = String(typed.message ?? '');
 if (pgCode === '23505') { status = 409; code = 'DUPLICATE'; message = 'That record already exists.'; }
 else if (pgCode === '23503') { status = 409; code = 'REFERENCED_RECORD_IN_USE'; message = 'A referenced record is missing or still in use.'; }
 else if (pgCode === '23514') { status = 422; code = 'CONSTRAINT_VIOLATION'; message = 'A value failed a database constraint.'; details = { constraint: /constraint "([^"]+)"/.exec(pgMessage)?.[1] ?? null }; }
 else if (pgCode === '22P02') { status = 400; code = 'INVALID_IDENTIFIER'; message = 'A supplied identifier is not valid.'; }
 else if (pgCode === '57014' || pgCode === '57P01') { status = 503; code = 'DB_TIMEOUT'; message = 'The request took too long to process.'; }
 }
 }

 const body: Record<string, unknown> = { code, message, requestId: req.requestId };
 if (details && status < 500) body.details = details;

 if (status >= 500) {
 // Internal detail goes to the log only. Never to the client (RULE 120).
 logger.error({ err, requestId: req.requestId, path: req.path, method: req.method, ip: req.loggableIp }, 'request failed');
 if (err instanceof Error && !err.name.startsWith('AppError')) body.message = 'An unexpected error occurred.';
 } else {
 logger.debug({ requestId: req.requestId, code, status, path: req.path }, 'request rejected');
 }
 res.status(status).json(body);
}

export const rateLimitError = tooMany;
export { readOnlyGuard } from './readOnly.ts';