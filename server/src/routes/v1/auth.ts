/**
 * `/api/v1/auth` -- credential and session lifecycle.
 *
 * Token delivery (RULE 23/56):
 * The access token is returned in the JSON body **and** set as an HttpOnly
 * cookie. The body exists for non-browser clients (mobile, CLI) which have no
 * cookie jar; the browser path prefers the cookie, which JavaScript cannot
 * read, so an XSS payload cannot exfiltrate it. The refresh token is only ever
 * an HttpOnly cookie -- it never appears in a response body.
 *
 * CSRF: a readable, non-sensitive CSRF cookie is issued alongside the session
 * cookie so a same-origin client can echo it in `X-CSRF-Token`. Together with
 * the Origin/Referer check in `csrfGuard`, a cross-site state change is blocked
 * twice over.
 */
import express from 'express';
const { Router } = express;
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { asyncRoute } from './helpers.ts';
import {
 registerUser, loginUser, refreshSession, revokeSessions, revokeAllSessions,
 changePassword, requestPasswordReset, resetPassword, verifyEmail, resendVerification,
 listSessions, revokeSession, type Actor, type PublicUser,
} from '../../services/auth.ts';
import { getDb } from '../../db/driver.ts';
import {
 authenticate, authIpLimiter, authAccountLimiter, csrfGuard, sensitiveActionWindow,
} from '../../middleware/security.ts';
import { validationFailed, invalidCredentials } from '../../lib/errors.ts';
import {
 getThemePreference, setThemePreference, THEME_PREFERENCES,
} from '../../services/userPreferences.ts';
import { logger, securityLog } from '../../lib/logger.ts';
import { setSessionCookies, clearSessionCookies, setMfaChallengeCookie } from './cookies.ts';

export const authRouter = Router();

const clientInfo = (req: express.Request) => ({
 ip: req.clientIp,
 userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
 requestId: req.requestId,
});

/** The session-derived identity, shaped for a response. Never the password hash. */
const publicActor = (a: Actor): PublicUser & { role: string } => ({
 id: a.userId,
 email: a.email,
 name: a.name,
 // The session claim is authoritative; a stale column cannot grant access.
 emailVerified: true,
 mfaEnabled: false,
 role: a.role,
});

//  schemas 

const emailField = z.string().trim().min(3).max(320).email();
const passwordField = z.string().min(1).max(1024);

const registerSchema = z.object({
 name: z.string().trim().min(1).max(120),
 email: emailField,
 password: passwordField,
 organizationName: z.string().trim().min(1).max(160),
});

const loginSchema = z.object({
 email: emailField,
 password: passwordField,
});

const changePasswordSchema = z.object({
 currentPassword: passwordField,
 newPassword: passwordField,
});

const resetRequestSchema = z.object({ email: emailField });
const resetConfirmSchema = z.object({ token: z.string().min(10).max(400), newPassword: passwordField });
const verifySchema = z.object({ token: z.string().min(10).max(400) });

function fieldErrors(err: z.ZodError): Record<string, string> {
 // Only paths and messages. Submitted values are never echoed back.
 const out: Record<string, string> = {};
 for (const issue of err.issues) {
 const key = issue.path.join('.') || '_';
 if (!(key in out)) out[key] = issue.message;
 }
 return out;
}

const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
 const parsed = schema.safeParse(body);
 if (!parsed.success) throw validationFailed(fieldErrors(parsed.error));
 return schema.parse(parsed.data);
};

//  routes 

authRouter.post('/register', authIpLimiter, csrfGuard, asyncRoute(async (req, res) => {
 if (env.security.blockNewAccounts) {
 res.status(503).json({ code: 'REGISTRATION_CLOSED', message: 'Registration is currently closed.', requestId: req.requestId });
 return;
 }
 const body = parse(registerSchema, req.body);
 const result = await registerUser({
 name: body.name,
 email: body.email,
 password: body.password,
 organizationName: body.organizationName,
 client: clientInfo(req),
 });
 securityLog('auth.register', { userId: result.user.id, organizationId: result.organizationId, ip: req.clientIp });
 res.status(201).json({
 data: {
 user: result.user,
 organizationId: result.organizationId,
 organizationName: result.organizationName,
 },
 });
}));

authRouter.post('/login', authIpLimiter, authAccountLimiter, csrfGuard, asyncRoute(async (req, res) => {
 const body = parse(loginSchema, req.body);
 const result = await loginUser({ email: body.email, password: body.password, client: clientInfo(req) });

 if (result.kind === 'mfa_required') {
 // The MFA token authorises nothing except submitting the second factor, and
 // expires in minutes. It is an HttpOnly cookie so it is not script-readable.
 setMfaChallengeCookie(res, result.mfaToken, result.expiresIn);
 res.status(200).json({ data: { mfaRequired: true, expiresIn: result.expiresIn } });
 return;
 }

 const csrfToken = setSessionCookies(res, result.accessToken, result.refreshToken);
 res.status(200).json({
 data: {
 user: result.user,
 organizationId: result.actor.organizationId,
 role: result.actor.role,
 accessToken: result.accessToken,
 expiresIn: result.accessExpiresIn,
 csrfToken,
 },
 });
}));

authRouter.post('/refresh', csrfGuard, asyncRoute(async (req, res) => {
 const cookies = req.cookies as Record<string, string | undefined> | undefined;
 const presented = cookies?.[`${env.jwt.cookieName}_refresh`];
 const bodyToken = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
 const refreshToken = typeof bodyToken === 'string' && bodyToken !== ''
 ? bodyToken
 : typeof presented === 'string' ? presented : '';

 if (!refreshToken) throw invalidCredentials();

 const result = await refreshSession(refreshToken, clientInfo(req));

 if (!result.ok) {
 clearSessionCookies(res);
 if (result.compromised) {
 // Refresh-token reuse means the token was captured. The entire family has
 // already been revoked inside refreshSession; tell the client plainly.
 securityLog('auth.token_refresh_reuse_detected', { ip: req.clientIp, requestId: req.requestId });
 res.status(401).json({
 code: 'SESSION_REVOKED',
 message: 'This session has been revoked. Sign in again.',
 requestId: req.requestId,
 });
 return;
 }
 res.status(401).json({ code: 'INVALID_REFRESH_TOKEN', message: 'Sign in again.', requestId: req.requestId });
 return;
 }

 const csrfToken = setSessionCookies(res, result.accessToken, result.refreshToken);
 securityLog('auth.token_refresh', { userId: result.actor.userId, ip: req.clientIp });
 res.status(200).json({
 data: {
 user: result.user,
 organizationId: result.actor.organizationId,
 role: result.actor.role,
 accessToken: result.accessToken,
 expiresIn: result.accessExpiresIn,
 csrfToken,
 },
 });
}));

authRouter.post('/logout', csrfGuard, authenticate, asyncRoute(async (req, res) => {
 const actor = req.actor!;
 const sessionId = actor.sessionId;
 const revoked = sessionId
 ? await revokeSessions(await getDb(), actor.userId, [sessionId], 'logout')
 : 0;
 clearSessionCookies(res);
 securityLog('auth.logout', { userId: actor.userId, organizationId: actor.organizationId });
 logger.debug({ userId: actor.userId, revoked }, 'logout');
 res.status(200).json({ data: { revoked } });
}));

authRouter.post('/logout-all', csrfGuard, authenticate, asyncRoute(async (req, res) => {
 const actor = req.actor!;
 const revoked = await revokeAllSessions(actor.userId, 'logout_all');
 clearSessionCookies(res);
 securityLog('auth.logout_all', { userId: actor.userId, organizationId: actor.organizationId, revoked });
 res.status(200).json({ data: { revoked } });
}));

authRouter.get('/me', authenticate, asyncRoute(async (req, res) => {
 const actor = req.actor!;
 res.json({
 data: {
 user: publicActor(actor),
 organizationId: actor.organizationId,
 role: actor.role,
 sessionId: actor.sessionId,
 },
 });
}));

authRouter.get('/sessions', authenticate, asyncRoute(async (req, res) => {
 const actor = req.actor!;
 res.json({ data: await listSessions(actor.userId, actor.sessionId) });
}));

//  appearance preference (cosmetic, per account) 

/**
 * `GET`/`PUT /auth/me/preferences` -- the caller's own theme.
 *
 * A separate endpoint rather than a field on `/auth/me` because it is the only
 * preference that exists, it changes rarely, and it must stay readable by a
 * viewer who can do almost nothing else. It is also the only preference that
 * has to survive logout-on-window-close, which is why it is stored per account
 * rather than in browser storage (see services/userPreferences.ts).
 *
 * The write is CSRF-guarded because it is a state change, even though the state
 * it changes is cosmetic: an unauthenticated cross-site POST must not be able to
 * alter anything, and one unguarded write endpoint is how that rule gets
 * quietly relaxed.
 */
authRouter.get('/me/preferences', authenticate, asyncRoute(async (req, res) => {
 res.json({ data: { theme: await getThemePreference(req.actor!) } });
}));

const themeSchema = z.object({ theme: z.enum(THEME_PREFERENCES) });

authRouter.put('/me/preferences', csrfGuard, authenticate, asyncRoute(async (req, res) => {
 const parsed = themeSchema.safeParse(req.body);
 if (!parsed.success) throw validationFailed(fieldErrors(parsed.error));
 res.json({ data: await setThemePreference(req.actor!, parsed.data.theme) });
}));

authRouter.delete('/sessions/:id', csrfGuard, authenticate, asyncRoute(async (req, res) => {
 const actor = req.actor!;
 const sessionId = String(req.params.id ?? '');
 const ok = await revokeSession(actor.userId, sessionId);
 if (!ok) {
 // Another user's session id is indistinguishable from a missing one.
 res.status(404).json({ code: 'NOT_FOUND', message: 'Session not found.', requestId: req.requestId });
 return;
 }
 securityLog('session.revoked', { userId: actor.userId, sessionId });
 if (sessionId === actor.sessionId) clearSessionCookies(res);
 res.status(204).end();
}));

authRouter.post('/password', csrfGuard, authenticate, sensitiveActionWindow, asyncRoute(async (req, res) => {
 const body = parse(changePasswordSchema, req.body);
 const result = await changePassword({
 userId: req.actor!.userId,
 currentPassword: body.currentPassword,
 newPassword: body.newPassword,
 client: clientInfo(req),
 });
 // A password change invalidates every session, including this one, so the
 // client must re-authenticate rather than keep a token minted from the old
 // password.
 clearSessionCookies(res);
 securityLog('auth.password_changed', { userId: req.actor!.userId, ip: req.clientIp, revoked: result.revoked });
 res.status(200).json({ data: { changed: true, revokedSessions: result.revoked } });
}));

authRouter.post('/password/forgot', authIpLimiter, csrfGuard, asyncRoute(async (req, res) => {
 const body = parse(resetRequestSchema, req.body);
 const result = await requestPasswordReset(body.email, clientInfo(req));
 securityLog('auth.password_reset_requested', { ip: req.clientIp, found: Boolean(result.userId) });
 // Identical response whether or not the address exists (RULE 121).
 // Outside production the token is echoed so the flow is completable without a
 // mail server. Production never does this.
 const devToken = env.nodeEnv !== 'production' ? result.token : undefined;
 res.status(202).json({ data: { accepted: true, ...(devToken ? { devToken } : {}) } });
}));

authRouter.post('/password/reset', authIpLimiter, csrfGuard, asyncRoute(async (req, res) => {
 const body = parse(resetConfirmSchema, req.body);
 const result = await resetPassword({ token: body.token, newPassword: body.newPassword, client: clientInfo(req) });
 clearSessionCookies(res);
 securityLog('auth.password_reset_completed', { userId: result.userId, ip: req.clientIp });
 res.status(200).json({ data: { reset: true } });
}));

authRouter.post('/verify-email', authIpLimiter, csrfGuard, asyncRoute(async (req, res) => {
 const body = parse(verifySchema, req.body);
 const result = await verifyEmail(body.token, clientInfo(req));
 securityLog('auth.email_verified', { userId: result.userId, ip: req.clientIp });
 res.status(200).json({ data: { verified: true } });
}));

authRouter.post('/verify-email/resend', authIpLimiter, authenticate, asyncRoute(async (req, res) => {
 const result = await resendVerification(req.actor!.userId, clientInfo(req));
 securityLog('auth.email_verification_resent', { userId: req.actor!.userId });
 const devToken = env.nodeEnv !== 'production' ? result.token : undefined;
 res.status(202).json({ data: { accepted: true, ...(devToken ? { devToken } : {}) } });
}));

export const __testing = { parse, fieldErrors, registerSchema, loginSchema };
