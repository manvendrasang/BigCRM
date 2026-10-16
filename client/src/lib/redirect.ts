/**
 * Internal-redirect guard.
 *
 * `ProtectedRoute` fills the post-sign-in destination from `location.pathname`,
 * which an attacker controls via a crafted link. The open-redirect risk
 * (GHSA-wrjc-x8rr-h8h6) is backslashes and protocol-relative forms being
 * normalised into an absolute URL by `<Link>` / `<Navigate>`. So the target is
 * decided here, not by a parser: anything that is not a plain internal path is
 * refused.
 *
 * Accepted: `/dashboard`, `/contacts?page=2`
 * Refused: `//evil.com`, `https://evil.com`, `/\evil.com`, `javascript:...`,
 * empty, non-strings
 */
export const DASHBOARD_PATH = '/dashboard';

/** Returns `input` when it is a safe same-origin path, otherwise `fallback`. */
export function safeInternalPath(input: unknown, fallback: string = DASHBOARD_PATH): string {
 if (typeof input !== 'string') return fallback;

 const path = input.trim();
 if (path === '' || path.length > 2048) return fallback;

 // Must be root-relative. A leading `//` or `/\` is protocol-relative once a
 // browser or URL parser normalises the backslash.
 if (!path.startsWith('/')) return fallback;
 const second = path.charAt(1);
 if (second === '/' || second === '\\') return fallback;

 // A scheme can never legitimately appear after the leading slash.
 if (/^\/[a-z][a-z0-9+.-]*:/i.test(path)) return fallback;

 // Backslashes anywhere are treated as path separators by several parsers,
 // which is exactly how `/\evil.com` becomes `//evil.com`. Reject outright.
 if (path.includes('\\')) return fallback;

 // Control characters can smuggle a newline into a Location header or a log.
 // eslint-disable-next-line no-control-regex
 if (/[\u0000-\u001f\u007f]/.test(path)) return fallback;

 return path;
}

/** The post-login destination, validated. Never returns an attacker-chosen origin. */
export function redirectTargetFrom(state: unknown): string {
 if (state && typeof state === 'object' && 'from' in state) {
 return safeInternalPath((state as { from?: unknown }).from);
 }
 return DASHBOARD_PATH;
}
