/**
 * IP address normalisation.
 *
 * `audit_logs.ip`, `sessions.ip` and `users.last_login_ip` are PostgreSQL
 * `inet` columns, which reject `127.0.0.*`. An earlier revision masked the last
 * octet before the value reached a query, so every write carrying a client
 * address failed with `22P02` -- and login became impossible over HTTP. It
 * typechecked and passed 137 service-level assertions, which set a literal
 * address instead of going through the middleware. Only a real socket exposed
 * it.
 *
 * The rule: persist the real address, mask in logs and metrics, and never let a
 * malformed address fail a business write (store NULL instead).
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

 // `isIP` is authoritative; discard anything else rather than letting the
 // driver reject it and fail the surrounding transaction.
 if (isIP(candidate) !== 0) return candidate;
 return null;
}

/** The address to persist. NULL for unknown, never a placeholder. */
export function persistableIp(value: unknown): string | null {
 return toInet(value);
}

/** The address to write to logs and metrics. */
export function loggableIp(value: unknown): string {
 const inet = toInet(value);
 return inet ? maskIp(inet) : 'unknown';
}