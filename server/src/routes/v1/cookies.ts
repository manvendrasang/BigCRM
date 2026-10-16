/**
 * Session cookie contract, in one place so `auth.ts` and `mfa.ts` cannot drift
 * apart on the most security-sensitive pair of decisions in the service.
 *
 * - **Access token** -- in the JSON body *and* an HttpOnly cookie. The body
 *   serves clients with no cookie jar (mobile, CLI); the browser uses the
 *   cookie, which script cannot read, so XSS cannot exfiltrate it.
 * - **Refresh token** -- HttpOnly cookie only. Never in a body: it is the
 *   long-lived credential.
 * - **CSRF token** -- deliberately readable by same-origin script, and carrying
 *   no authority alone. A cross-site attacker cannot read it either, since the
 *   session cookie is equally out of reach. With `SameSite=Lax` and the
 *   Origin/Referer check in `csrfGuard`, that is three independent controls.
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


export { baseCookie };
