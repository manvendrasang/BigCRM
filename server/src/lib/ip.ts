/**
 * IP address normalisation.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 *
 * `audit_logs.ip`, `sessions.ip`, `users.last_login_ip` and
 * `idempotency_keys.requested_ip` are all PostgreSQL `inet` columns. `inet`
 * accepts `127.0.0.1` and `::1`; it rejects `127.0.0.*`.
 *
 * `middleware/security.ts` used to set `req.clientIp = maskIp(...)` -- masking the
 * last octet before the value ever reached a query. Every write that included
 * the client address therefore failed with `22P02 invalid_text_representation`,
 * which `errorHandler` maps to a 400 `INVALID_IDENTIFIER`. The practical effect
 * was that **login was impossible over HTTP**: creating a session inserts the
 * caller's address, and that insert always failed.
 *
 * It typechecked. It passed 137 service-level security assertions, because those
 * tests set a literal `10.0.0.1` rather than going through the middleware. Only
 * a request over a real socket exposed it.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * - **Persist the real address.** It is an audit record; an audit trail that
 * stores `127.0.0.*` cannot answer "which address did this", which is the
 * only question it exists to answer. Access to that table is already gated by
 * `audit.read` and the append-only trigger.
 * - **Mask in logs and metrics**, where precision is not needed and the value
 * is far more widely exposed.
 * - **Never let a malformed address break a business write.** A bad IP is
 * recorded as NULL, never as a failed transaction.
 */
import { isIP } from 'node:net';
import { maskIp } from './redact.ts';

/** Returns a value PostgreSQL `inet` will accept, or null. */
export function toInet(value: unknown): string | null {
 if (typeof value !== 'string') return null;
 let candidate = value.trim();
 if (candidate === '') return null;

 // `::ffff:127.0.0.1` is valid input but pointless to store; normalise it.
 const v4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(candidate);
 if (v4Mapped?.[1]) candidate = v4Mapped[1];

 // Strip an IPv6 zone index (`fe80::1%eth0`) -- PostgreSQL rejects it.
 candidate = candidate.replace(/%.*$/, '');

 // `isIP` is the authoritative check; anything else is discarded rather than
 // passed to the driver to reject.
 if (isIP(candidate) !== 0) return candidate;
 return null;
}

/**
 * The address to persist. Falls back to null rather than substituting a
 * placeholder, so "unknown" is represented honestly instead of by a value that
 * looks like a real address.
 */
export function persistableIp(value: unknown): string | null {
 return toInet(value);
}

/** The address to write to logs and metrics. */
export function loggableIp(value: unknown): string {
 const inet = toInet(value);
 return inet ? maskIp(inet) : 'unknown';
}
