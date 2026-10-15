/**
 * Session cookie contract.
 *
 * Extracted so `auth.ts` and `mfa.ts` cannot drift apart on the single most
 * security-sensitive pair of decisions in the service.
 *
 *   • **Access token** — returned in the JSON body *and* set as an HttpOnly
 *     cookie. The body exists for clients with no cookie jar (mobile, CLI); the
 *     browser path uses the cookie, which script cannot read, so an XSS payload
 *     cannot exfiltrate it.
 *   • **Refresh token** — HttpOnly cookie only. It never appears in a response
 *     body, because it is the long-lived credential.
 *   • **CSRF token** — deliberately readable by same-origin script. It carries no
 *     authority on its own: it is a synchroniser that a cross-site attacker
 *     cannot read either, because the `HttpOnly` session cookie is equally out
 *     of reach. Pairing it with `SameSite=Lax` and the Origin/Referer check in
 *     `csrfGuard` gives three independent controls.
 */
import express from 'express';
import { env } from '../../config/env.ts';

const baseCookie = {
  secure: env.cookiesSecure,
  sameSite: env.cookiesSameSite,
  path: '/',
} as const;

/** Sets the full session cookie set. Returns the CSRF token for the response body. */
export function setSessionCookies(res: express.Response, accessToken: string, refreshToken: string): string {
  const csrfToken = crypto.randomUUID();

  res.cookie(env.jwt.cookieName, accessToken, {
    ...baseCookie, httpOnly: true, maxAge: env.jwt.accessTtlSec * 1000,
  });
  res.cookie(`${env.jwt.cookieName}_refresh`, refreshToken, {
    ...baseCookie, httpOnly: true, maxAge: env.jwt.refreshTtlSec * 1000,
  });
  res.cookie(env.jwt.csrfCookieName, csrfToken, {
    ...baseCookie, httpOnly: false, maxAge: env.jwt.accessTtlSec * 1000,
  });

  return csrfToken;
}

export function clearSessionCookies(res: express.Response): void {
  res.clearCookie(env.jwt.cookieName, { ...baseCookie });
  res.clearCookie(`${env.jwt.cookieName}_refresh`, { ...baseCookie });
  res.clearCookie(env.jwt.csrfCookieName, { ...baseCookie });
}

/** The short-lived MFA challenge cookie set right after a successful password check. */
export function setMfaChallengeCookie(res: express.Response, token: string, maxAgeSec: number): void {
  res.cookie('bigcrm_mfa', token, { ...baseCookie, httpOnly: true, maxAge: maxAgeSec * 1000 });
}

export const cookieNames = {
  access: env.jwt.cookieName,
  refresh: `${env.jwt.cookieName}_refresh`,
  csrf: env.jwt.csrfCookieName,
  mfaChallenge: 'bigcrm_mfa',
} as const;

export { baseCookie };
