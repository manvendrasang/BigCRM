/**
 * JWT design (RULE 24).
 *
 * Two-token scheme:
 * access -- 15 min, sent on every request, held in a cookie.
 * refresh -- rotating, single-use, bound to a session row.
 *
 * Every refresh token carries `sid` (session id). Rotation is one-way: the old
 * refresh token's `jti` is burned, and presenting an already-burned token is
 * treated as theft -- the entire session family is revoked (reuse detection).
 * The legacy TaskFlow app issued a single unrevocable 7-day token; this design
 * is the replacement.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.ts';
import { unauthorized } from './errors.ts';

export type AccessClaims = {
 iss: string; aud: string; sub: string; iat: number; exp: number; jti: string;
 org: string; // active organization id
 role: string; // active role within that organization
 sid: string; // session id
 typ: 'access';
};
export type RefreshClaims = {
 iss: string; aud: string; sub: string; iat: number; exp: number; jti: string;
 sid: string; typ: 'refresh';
 fam: string; // token-family id; constant across rotations
};

export type TokenPair = { accessToken: string; refreshToken: string; accessExpiresIn: number; refreshExpiresIn: number };

const b64u = (s: string | Buffer): string =>
 Buffer.from(s).toString('base64url');

const sign = (header: string, payload: string, secret: string): string => {
 const data = `${header}.${payload}`;
 const sig = createHmac('sha256', secret).update(data).digest('base64url');
 return `${data}.${sig}`;
};

const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

const newJti = (): string => crypto.randomUUID();

function encode(payload: Record<string, unknown>, secret: string): string {
 return sign(header, b64u(JSON.stringify(payload)), secret);
}

function decode(token: string, secret: string): Record<string, unknown> {
 const parts = String(token ?? '').split('.');
 if (parts.length !== 3) throw unauthorized('Malformed token.');
 const [h, p, s] = parts as [string, string, string];
 const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
 const a = Buffer.from(s); const b = Buffer.from(expected);
 if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized('Token signature is invalid.');
 let parsed: Record<string, unknown>;
 try { parsed = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { throw unauthorized('Malformed token.'); }
 if (parsed.iss !== env.jwt.issuer) throw unauthorized('Unexpected token issuer.');
 if (parsed.aud !== env.jwt.audience) throw unauthorized('Unexpected token audience.');
 const exp = Number(parsed.exp);
 if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) throw unauthorized('Token has expired.');
 return parsed;
}

export function issueAccessToken(args: {
 userId: string; orgId: string; role: string; sessionId: string; ttlSec?: number;
}): { token: string; jti: string; exp: number } {
 const iat = Math.floor(Date.now() / 1000);
 const exp = iat + (args.ttlSec ?? env.jwt.accessTtlSec);
 const jti = newJti();
 const claims: AccessClaims = {
 iss: env.jwt.issuer, aud: env.jwt.audience, sub: args.userId, iat, exp, jti,
 org: args.orgId, role: args.role, sid: args.sessionId, typ: 'access',
 };
 return { token: encode(claims, env.jwt.accessSecret), jti, exp };
}

export function issueRefreshToken(args: {
 userId: string; sessionId: string; familyId: string; ttlSec?: number;
}): { token: string; jti: string; exp: number } {
 const iat = Math.floor(Date.now() / 1000);
 const exp = iat + (args.ttlSec ?? env.jwt.refreshTtlSec);
 const jti = newJti();
 const claims: RefreshClaims = {
 iss: env.jwt.issuer, aud: env.jwt.audience, sub: args.userId, iat, exp, jti,
 sid: args.sessionId, fam: args.familyId, typ: 'refresh',
 };
 return { token: encode(claims, env.jwt.refreshSecret), jti, exp };
}

/** Verifies and narrows to a typed claim set. Never returns unvalidated fields. */
function claims<T extends Record<string, unknown>>(token: string, secret: string, typ: 'access' | 'refresh'): T {
 const raw = decode(token, secret);
 if (raw.typ !== typ) throw unauthorized(`Expected a ${typ} token.`);
 for (const k of ['sub', 'jti', 'sid'] as const) {
 if (typeof raw[k] !== 'string' || !raw[k]) throw unauthorized('Token is missing required claims.');
 }
 return raw as unknown as T;
}

export const verifyAccessToken = (token: string): AccessClaims => {
 const c = claims<AccessClaims>(token, env.jwt.accessSecret, 'access');
 if (typeof c.org !== 'string' || typeof c.role !== 'string') throw unauthorized('Token is missing organization claims.');
 return c;
};

export const verifyRefreshToken = (token: string): RefreshClaims => {
 const c = claims<RefreshClaims>(token, env.jwt.refreshSecret, 'refresh');
 if (typeof c.fam !== 'string' || !c.fam) throw unauthorized('Token is missing its family claim.');
 return c;
};

/** SHA-256 of the raw refresh token. Only this is ever persisted (RULE 19). */
export const hashRefreshToken = (token: string): string =>
 createHmac('sha256', env.jwt.refreshSecret).update(token).digest('hex');