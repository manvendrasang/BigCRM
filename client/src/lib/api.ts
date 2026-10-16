/**
 * BigCRM API client -- the security boundary between browser and API. The rules
 * enforced here (mirroring the server's RULE 30/38):
 *
 * 1. **Tokens live in memory only.** The access token is module-scoped and
 *    never written to `localStorage`, `sessionStorage`, IndexedDB or a
 *    JS-readable cookie: any of those survives the tab and is readable by any
 *    script on the origin, so one XSS payload or compromised dependency could
 *    exfiltrate a long-lived credential and replay it elsewhere. An in-memory
 *    value dies with the tab and is invisible to `document.cookie`. The refresh
 *    token is never in JS at all -- the server keeps it `HttpOnly`.
 * 2. **Credentials are `same-origin`, never `include`.** The client is served
 *    from the API's origin behind the dev proxy, so `same-origin` suffices.
 *    `include` would attach the session cookie to cross-site requests, which
 *    with `Access-Control-Allow-Credentials` on a permissive allowlist is the
 *    classic CSRF exfiltration setup. We never need it.
 * 3. **CSRF.** The double-submit token lives in a non-`HttpOnly` cookie (readable
 *    by us by design) and is echoed in `X-CSRF-Token` on state-changing
 *    requests. A cross-site attacker can cause the cookie to be sent but cannot
 *    read it, and setting the header cross-origin triggers a rejected preflight.
 * 4. **Bounded, single retry.** A 401 triggers at most one refresh and one
 *    retry, so a persistently-401 server cannot produce a refresh storm.
 * 5. **Nothing sensitive is logged or surfaced.** No bodies, headers or tokens;
 *    errors carry a status, a safe code and a safe message.
 */

/** Base path for every API call. Kept relative so requests stay same-origin. */
export const API_BASE = '/api/v1';

const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Name of the CSRF synchroniser cookie.
 *
 * This must match the server's `CSRF_COOKIE_NAME` (default `bigcrm_csrf`).
 * It was previously hard-coded here as `csrf_token`, which does not exist, so no
 * header was ever sent and the Origin check carried the whole CSRF defence on
 * its own. Overridable at build time so the two can never silently drift again.
 */
const CSRF_COOKIE_NAME =
 (import.meta.env?.VITE_CSRF_COOKIE_NAME as string | undefined) || 'bigcrm_csrf';
const CSRF_HEADER_NAME = 'X-CSRF-Token';

/**
 * Error thrown by the client. Intentionally narrow: `status`, a machine-readable
 * `code`, and a human-readable `message` that is always safe to render.
 * The raw response body, headers, and tokens are NOT retained -- see rule 5.
 */
export class ApiError extends Error {
 readonly status: number;
 readonly code: string;

 constructor(status: number, code: string, message: string) {
 super(message);
 this.name = 'ApiError';
 this.status = status;
 this.code = code;
 // Keep `instanceof` working when the class is down-levelled.
 Object.setPrototypeOf(this, ApiError.prototype);
 }
}

//  redaction (rule 5) 

const REDACTED = '[REDACTED]';

/** Keys whose values must never be rendered, logged, or serialised. */
const SECRET_KEYS = new Set([
 'password', 'newpassword', 'currentpassword', 'passwordhash', 'password_hash',
 'token', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token', 'idtoken',
 'secret', 'clientsecret', 'client_secret', 'apikey', 'api_key', 'authorization',
 'cookie', 'setcookie', 'set-cookie', 'csrftoken', 'csrf', 'sessionid', 'session_id',
 'tokenhash', 'token_hash', 'totpsecret', 'totp_secret', 'privatekey', 'private_key',
 'otp', 'code', 'mfatoken', 'mfa_token',
]);

/**
 * Recursively replaces secret-shaped values with `[REDACTED]`.
 *
 * This is the only sanctioned way to put anything originating from a response
 * in front of a human (error text, console, crash reporter). It is deliberately
 * conservative: unknown keys are preserved because losing them hides bugs, but
 * every well-known credential-bearing key is masked, and depth/cycles are bounded
 * so a hostile payload cannot cause unbounded work or a stack overflow.
 */
export function redact(input: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
 if (depth > 8) return '[TRUNCATED]';
 if (input === null || input === undefined) return input;
 if (typeof input === 'string') return input;
 if (typeof input !== 'object') return input;

 const asObject = input;
 if (seen.has(asObject)) return '[CIRCULAR]';
 seen.add(asObject);

 if (Array.isArray(input)) return input.slice(0, 100).map((item) => redact(item, depth + 1, seen));
 if (input instanceof Error) {
 return { name: input.name, message: input.message };
 }

 const out: Record<string, unknown> = {};
 for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
 const normalised = key.toLowerCase().replace(/[-_\s]/g, '');
 out[key] = SECRET_KEYS.has(normalised) ? REDACTED : redact(value, depth + 1, seen);
 }
 return out;
}

/**
 * Removes any live credential that may have been echoed into a string we are
 * about to display. Defence in depth: the API should never reflect a token, but a
 * misconfigured proxy or an error page might, and we would rather render
 * `[REDACTED]` than hand an attacker their own token back.
 */
function scrubSecrets(text: string): string {
 let out = text;
 if (accessToken && out.includes(accessToken)) out = out.split(accessToken).join(REDACTED);
 // Bare JWTs and long opaque tokens appearing anywhere in the string.
 out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
 out = out.replace(/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED);
 return out;
}

//  token store (rule 1) 

/**
 * THE ONLY PLACE AN ACCESS TOKEN IS STORED. Module scope == tab scope.
 * Never move this to a persistent store.
 */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
 accessToken = token;
}

/** Returns the token for tests/debugging. Callers must not log the result. */
export function getAccessToken(): string | null {
 return accessToken;
}

/** Drops every credential held in memory. Called on logout and refresh failure. */
export function clearTokens(): void {
 accessToken = null;
}

//  test seams 

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Overridable for tests. Resolves `globalThis.fetch` lazily on every call so a
 * `vi.stubGlobal('fetch', ...)` is picked up without re-importing the module.
 */
let fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init);

export function setFetchImplementation(fn: FetchLike): void {
 fetchImpl = fn;
}

export function resetFetchImplementation(): void {
 fetchImpl = (input, init) => globalThis.fetch(input, init);
}

type UnauthenticatedHandler = (path: string) => void;

/**
 * Fallback used when the app has not installed its own handler.
 *
 * It must never reload the document while already sitting on the target route.
 * The session bootstrap (`GET /auth/me`) legitimately 401s on a cold visit to
 * `/login`, which would otherwise reload the page, remount the provider, probe
 * again, and spin forever -- a hard navigation resets the router and every piece
 * of React state, so `<Navigate>` in `ProtectedRoute` never gets a chance to
 * run. `AuthProvider` installs a real handler; this guard is the backstop.
 */
function defaultUnauthenticatedHandler(path: string): void {
 if (typeof window === 'undefined') return;
 if (window.location.pathname === path) return;
 window.location.assign(path);
}

let onUnauthenticated: UnauthenticatedHandler = defaultUnauthenticatedHandler;

export function setUnauthenticatedHandler(handler: UnauthenticatedHandler): void {
 onUnauthenticated = handler;
}

export function resetUnauthenticatedHandler(): void {
 onUnauthenticated = defaultUnauthenticatedHandler;
}

/** Full teardown between tests: credentials, refresh state, and seams. */
export function resetApiClient(): void {
 clearTokens();
 refreshInFlight = null;
 resetFetchImplementation();
 resetUnauthenticatedHandler();
}

//  CSRF (rule 3) 

/**
 * Reads the double-submit CSRF token from its non-`HttpOnly` cookie.
 * Returns `null` when absent (e.g. on the very first request from a brand-new
 * tab) so the caller can decide whether to surface an error or continue.
 */
export function getCsrfToken(): string | null {
 if (typeof document === 'undefined') return null;
 const raw = document.cookie;
 if (!raw) return null;
 for (const part of raw.split(';')) {
 const eq = part.indexOf('=');
 if (eq === -1) continue;
 if (part.slice(0, eq).trim() === CSRF_COOKIE_NAME) {
 const value = part.slice(eq + 1).trim();
 try {
 return decodeURIComponent(value);
 } catch {
 return value;
 }
 }
 }
 return null;
}

//  core request (rules 2-5) 

export interface RequestOptions {
 method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
 /** Serialised as JSON. Never logged. */
 body?: unknown;
 /** Caller-supplied cancellation, combined with the internal timeout. */
 signal?: AbortSignal;
 /** Escape hatch for endpoints that must not trigger a refresh (e.g. login). */
 skipRefresh?: boolean;
 /**
 * Return the full response body instead of the unwrapped `data`.
 * Needed for list endpoints, where `pageInfo` is a sibling of `data` rather
 * than inside it -- the default unwrap would silently drop pagination. The
 * caller takes responsibility for the envelope shape.
 */
 raw?: boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function buildUrl(path: string): string {
 if (path.startsWith('http://') || path.startsWith('https://')) return path;
 return path.startsWith('/') ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
}

/**
 * Single-flight refresh. Concurrent 401s share one in-flight refresh rather than
 * each firing their own -- with rotating single-use refresh tokens, parallel
 * refreshes would trip the server's reuse detection and revoke the whole family.
 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * Attempts exactly one refresh using the `HttpOnly` refresh cookie.
 * Never throws -- resolves `false` so callers can simply fail the original call.
 */
async function refreshSession(): Promise<boolean> {
 if (refreshInFlight) return refreshInFlight;

 refreshInFlight = (async () => {
 try {
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
 try {
 const response = await fetchImpl(`${API_BASE}/auth/refresh`, {
 method: 'POST',
 // Rule 2: same-origin only, so the HttpOnly refresh cookie is sent.
 credentials: 'same-origin',
 headers: { ...csrfHeaders('POST'), Accept: 'application/json' },
 signal: controller.signal,
 });
 if (!response.ok) return false;

 // Both the new body token and the cookie must be adopted: `authenticate`
 // prefers the header, so a stale in-memory token would override the fresh
 // cookie and 401 again -- signing the user out every access-token TTL despite
 // a valid refresh cookie.
 //
 // Read defensively: a successful refresh returning an unreadable shape still
 // leaves a valid cookie, and the cookie path alone keeps the session alive.
 try {
 const body = (await response.json()) as { data?: { accessToken?: unknown } };
 const token = body?.data?.accessToken;
 if (typeof token === 'string' && token.length > 0) setAccessToken(token);
 } catch {
 // Body absent or malformed. The rotated cookie is still authoritative.
 }
 return true;
 } finally {
 clearTimeout(timer);
 }
 } catch {
 // Network failure, abort, or a throwing stub. Either way we cannot refresh.
 return false;
 }
 })();

 try {
 return await refreshInFlight;
 } finally {
 refreshInFlight = null;
 }
}

/** Rule 3: the CSRF header is attached to state-changing verbs only. */
function csrfHeaders(method: string): Record<string, string> {
 if (SAFE_METHODS.has(method)) return {};
 const token = getCsrfToken();
 return token ? { [CSRF_HEADER_NAME]: token } : {};
}

/** Converts a non-2xx response into a narrow, safe `ApiError`. */
/**
 * Field-level validation reasons from a `details` object.
 *
 * A 422 carries the useful part in `details` (`{ password: 'too short' }`) while
 * `message` is the fixed string "Request validation failed." Lifting only
 * `message` therefore told the user nothing: the admin-reset card rejected a
 * password and displayed "Request validation failed." with no reason, which is
 * indistinguishable from a server fault.
 *
 * Only string values are taken, in key order, and only when the body actually
 * has the documented shape -- an unexpected `details` must not be rendered.
 * The field name is prefixed only when more than one field failed, since a
 * single reason ("Password must be at least 12 characters.") reads better alone.
 */
function validationReasons(body: Record<string, unknown>): string[] {
 const details = body['details'];
 if (typeof details !== 'object' || details === null || Array.isArray(details)) return [];
 const entries: { field: string; reason: string }[] = [];
 for (const [field, value] of Object.entries(details as Record<string, unknown>)) {
  const texts = Array.isArray(value)
   ? value.filter((v): v is string => typeof v === 'string')
   : typeof value === 'string'
    ? [value]
    : [];
  for (const reason of texts) {
   const trimmed = reason.trim();
   if (trimmed.length > 0) entries.push({ field, reason: trimmed });
  }
 }
 if (entries.length === 0) return [];
 const many = new Set(entries.map((e) => e.field)).size > 1;
 return entries.map((e) => (many ? `${e.field}: ${e.reason}` : e.reason));
}

async function toApiError(response: Response): Promise<ApiError> {
 const { status } = response;

 // 5xx messages are replaced wholesale: internal detail must never reach the
 // browser (RULE 120), and a proxy error page may contain anything.
 if (status >= 500) {
 return new ApiError(status, 'SERVER_ERROR', 'Something went wrong. Please try again.');
 }

 let code = 'REQUEST_FAILED';
 let message = 'The request could not be completed.';

 try {
 const body: unknown = await response.json();
 if (typeof body === 'object' && body !== null) {
 const record = body as Record<string, unknown>;
 // Only `code` and `message` are lifted, and only when they are the expected
 // primitives. Everything else in the body is discarded.
 if (typeof record['code'] === 'string' && /^[A-Z0-9_]{1,64}$/.test(record['code'])) {
 code = record['code'];
 }
 if (typeof record['message'] === 'string' && record['message'].length > 0) {
 message = record['message'].slice(0, 300);
 }
 if (code === 'VALIDATION_FAILED') {
 const reasons = validationReasons(record);
 if (reasons.length > 0) message = reasons.join(' ');
 }
 }
 } catch {
 // Non-JSON body (HTML error page, empty body). The generic message stands.
 }

 return new ApiError(status, code, scrubSecrets(message).slice(0, 300));
}

/** Unwraps the `{ data, requestId }` envelope the API documents. */
async function unwrap(response: Response): Promise<unknown> {
 if (response.status === 204) return undefined;
 let body: unknown;
 try {
 body = await response.json();
 } catch {
 return undefined;
 }
 if (typeof body === 'object' && body !== null && 'data' in body) {
 return (body as Record<string, unknown>)['data'];
 }
 return body;
}

/**
 * Issues an API request.
 *
 * On a 401 it performs at most one refresh (`POST /api/v1/auth/refresh`, using
 * the HttpOnly refresh cookie) and retries the original request exactly once. If
 * the refresh fails, credentials are dropped and the user is sent to `/login`.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
 const method = options.method ?? 'GET';
 const url = buildUrl(path);

 const headers: Record<string, string> = {
 Accept: 'application/json',
 ...csrfHeaders(method),
 };
 if (options.body !== undefined) headers['Content-Type'] = 'application/json';
 // Rule 2: a bearer token is sent when we hold one; the cookie is the fallback.
 if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

 // Every request is time-boxed so a hung socket cannot wedge the UI; the caller's
 // signal is honoured alongside it.
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
 const external = options.signal;
 const forwardAbort = (): void => controller.abort();
 if (external) {
 if (external.aborted) controller.abort();
 else external.addEventListener('abort', forwardAbort);
 }

 try {
 const response = await fetchImpl(url, {
 method,
 credentials: 'same-origin',
 headers,
 signal: controller.signal,
 ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
 });

 if (response.status === 401 && !options.skipRefresh) {
 const refreshed = await refreshSession();
 if (!refreshed) {
 clearTokens();
 onUnauthenticated('/login');
 throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
 }
 return request<T>(path, { ...options, skipRefresh: true });
 }

 if (!response.ok) throw await toApiError(response);

 if (options.raw) {
 if (response.status === 204) return undefined as T;
 try {
 return (await response.json()) as T;
 } catch {
 return undefined as T;
 }
 }
 return (await unwrap(response)) as T;
 } catch (error) {
 if (error instanceof ApiError) throw error;
 if (controller.signal.aborted) {
 throw new ApiError(0, 'TIMEOUT', 'The request timed out. Please try again.');
 }
 // Deliberately terse: the underlying message could contain a URL or header.
 throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Please try again.');
 } finally {
 clearTimeout(timer);
 external?.removeEventListener('abort', forwardAbort);
 }
}

//  typed helpers 

export const api = {
 get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
 request<T>(path, { ...options, method: 'GET' }),
 post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
 request<T>(path, { ...options, method: 'POST', body }),
 patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
 request<T>(path, { ...options, method: 'PATCH', body }),
 put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'PUT', body }),
 del: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
 request<T>(path, { ...options, method: 'DELETE' }),
};