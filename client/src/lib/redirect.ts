/**
 * Internal-redirect guard.
 *
 * After signing in, the app returns the user to wherever they were headed. That
 * "wherever" comes from `location.state.from`, which `ProtectedRoute` fills from
 * `location.pathname` — i.e. from the URL, which an attacker controls via a
 * crafted link.
 *
 * React Router's open-redirect advisory (GHSA-wrjc-x8rr-h8h6) is about
 * backslashes and protocol-relative forms being normalised into an absolute URL
 * by `<Link>` / `<Navigate>`. The fix is not "we don't use react-router
 * dangerously"; it is to refuse any destination that is not a plain internal
 * path, so the redirect target is decided here rather than by a parser.
 *
 * Accepted: `/dashboard`, `/contacts?page=2`
 * Refused: `//evil.com`, `https://evil.com`, `/\evil.com`, `/..%2f..%2f`,
 *          `javascript:...`, `data:...`, empty, non-strings
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
