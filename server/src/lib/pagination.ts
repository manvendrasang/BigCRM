/**
 * Bounded, signed cursor pagination (RULE 75).
 *
 * Cursors are opaque and HMAC-signed so a client cannot widen the page size,
 * reorder the sort, or rewind by editing parameters. The response reports only
 * the values actually applied -- the legacy CRM echoed the raw, unclamped query
 * values back to the caller, so its envelope lied about the window applied.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.ts';
import { badRequest } from './errors.ts';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export type CursorPayload = { t: string; id: string; d?: string };

export type PageInfo = {
 hasNextPage: boolean;
 hasPreviousPage: boolean;
 startCursor: string | null;
 endCursor: string | null;
};

export type PageResult<T> = { data: T[]; pageInfo: PageInfo; totalCount: number | null };

const b64u = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const sign = (body: string): string =>
 createHmac('sha256', env.secretsPepper).update(`cursor:${body}`).digest('base64url').slice(0, 32);

export const encodeCursor = (payload: CursorPayload): string => {
 const body = b64u(JSON.stringify(payload));
 return `${body}.${sign(body)}`;
};

export const decodeCursor = (cursor: string): CursorPayload => {
 const [body, sig] = String(cursor ?? '').split('.');
 if (!body || !sig) throw badRequest('Malformed pagination cursor.');
 const expected = sign(body);
 const a = Buffer.from(sig);
 const b = Buffer.from(expected);
 if (a.length !== b.length || !timingSafeEqual(a, b)) {
 throw badRequest('Pagination cursor failed integrity check.');
 }
 let parsed: unknown;
 try {
 parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
 } catch {
 throw badRequest('Malformed pagination cursor.');
 }
 const p = parsed as CursorPayload | null;
 if (!p || typeof p.t !== 'string' || typeof p.id !== 'string') throw badRequest('Malformed pagination cursor.');
 return p;
};

export type PageInput = { first: number; after?: CursorPayload };

/** Rejects out-of-range `first` outright rather than silently clamping. */
export function parsePageInput(first: unknown, after: unknown): PageInput {
 const raw = first === undefined || first === '' ? DEFAULT_PAGE_SIZE : Number(first);
 if (!Number.isInteger(raw)) throw badRequest('`first` must be an integer.');
 if (raw < 1) throw badRequest('`first` must be at least 1.');
 if (raw > MAX_PAGE_SIZE) throw badRequest(`\`first\` must not exceed ${MAX_PAGE_SIZE}.`);
 const out: PageInput = { first: raw };
 if (after !== undefined && after !== null && after !== '') out.after = decodeCursor(String(after));
 return out;
}

/** Row shape expected by the cursor builder: needs the sort key used in the query. */
export type CursorRow = { id: string; cursor_sort_value?: string | number | null };

export function buildPage<T extends CursorRow>(
 rows: T[],
 first: number,
 totalCount?: number | null,
): PageResult<T> {
 const hasNextPage = rows.length > first;
 const data = hasNextPage ? rows.slice(0, first) : rows;
 const toCursor = (r: T | undefined): string | null => {
 if (!r) return null;
 const sort = r.cursor_sort_value ?? r.id;
 return encodeCursor({ t: String(sort), id: String(r.id) });
 };
 return {
 data,
 pageInfo: {
 hasNextPage,
 hasPreviousPage: false,
 startCursor: toCursor(data[0]),
 endCursor: toCursor(data[data.length - 1]),
 },
 totalCount: totalCount ?? null,
 };
}