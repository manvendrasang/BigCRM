/**
 * `/api/v1/auth/mfa` -- enrollment, login challenge, recovery codes, disable.
 *
 * Two audiences share this file and the split is deliberate:
 *
 * - **Authenticated** -- enroll, confirm, status, regenerate, disable. These
 * act on the caller's own account only. No handler here reads a user id from
 * the request, so one member can never enroll, disable or re-key another's
 * second factor.
 * - **Public** -- completing the login challenge. The caller has no session; the
 * credential is the challenge token `loginUser` issued *after* verifying the
 * password. On success this route mints the session itself, so the second
 * factor is folded into the same response as a first-factor login rather than
 * becoming a separate, more forgeable artefact.
 */
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { asyncRoute, actorRef } from './helpers.ts';
import { authenticate, csrfGuard, authIpLimiter, sensitiveActionWindow } from '../../middleware/security.ts';
import {
 startEnrollment, confirmEnrollment, completeChallenge, resolveChallengeUser,
 disableMfa, regenerateRecoveryCodes, recoveryStatus,
} from '../../services/mfa.ts';
import { createSession } from '../../services/auth.ts';
import { initDriver } from '../../repositories/base.ts';
import { validationFailed } from '../../lib/errors.ts';
import type { Role } from '../../services/rbac.ts';
import { setSessionCookies } from './cookies.ts';

export const mfaRouter = Router();

const codeField = z.string().trim().min(6).max(20);
const tokenField = z.string().min(10).max(400);

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
 const parsed = schema.safeParse(body);
 if (!parsed.success) {
 const details: Record<string, string> = {};
 for (const issue of parsed.error.issues) {
 const key = issue.path.join('.') || '_';
 if (!(key in details)) details[key] = issue.message;
 }
 throw validationFailed(details);
 }
 // `safeParse` widens `data` to `any` on the generic branch. Re-running the
 // schema restores the caller's inferred type so no `any` escapes this helper.
 return schema.parse(parsed.data) as z.infer<T>;
}

//  authenticated: managing your own second factor 

mfaRouter.use(authenticate);

mfaRouter.get('/status', asyncRoute(async (req, res) => {
 const { userId } = actorRef(req);
 const db = await initDriver();
 const rows = await db.query<{ mfa_enabled: boolean; mfa_recovery_used_at: string | null }>(
 'SELECT mfa_enabled, mfa_recovery_used_at FROM users WHERE id = $1', [userId]);
 const user = rows.rows[0];
 const status = await recoveryStatus(userId);
 res.json({
 data: {
 enabled: Boolean(user?.mfa_enabled),
 recoveryCodesRemaining: status.remaining,
 recoveryCodeUsedAt: user?.mfa_recovery_used_at ?? null,
 requiredForPrivilegedRoles: env.security.requireMfaForPrivileged,
 },
 });
}));

mfaRouter.post('/enroll', csrfGuard, sensitiveActionWindow, asyncRoute(async (req, res) => {
 const start = await startEnrollment(actorRef(req).userId);
 res.status(201).json({
 data: {
 // The secret and the otpauth:// URI exist in cleartext exactly once, over
 // the authenticated session. At rest the column holds AES-GCM ciphertext.
 secret: start.secret,
 otpauthUri: start.otpauthUri,
 expiresAt: start.expiresAt,
 next: 'Add this to your authenticator app, then POST /auth/mfa/enroll/confirm with a 6-digit code.',
 },
 });
}));

mfaRouter.post('/enroll/confirm', csrfGuard, sensitiveActionWindow, asyncRoute(async (req, res) => {
 const body = parse(z.object({ challengeToken: tokenField, code: codeField }), req.body);
 const result = await confirmEnrollment(actorRef(req).userId, body.challengeToken, body.code);
 res.status(200).json({
 data: {
 enabled: true,
 // Shown once; only hashes are stored, so they cannot be re-displayed.
 recoveryCodes: result.recoveryCodes,
 warning: 'Store these now. They are the only way back in if you lose your device.',
 },
 });
}));

mfaRouter.post('/recovery-codes', csrfGuard, sensitiveActionWindow, asyncRoute(async (req, res) => {
 const body = parse(z.object({ code: codeField }), req.body);
 // Re-proves the current factor before replacing it, so regenerating is not a
 // takeover path for someone holding only a session cookie.
 const result = await regenerateRecoveryCodes(actorRef(req).userId, body.code);
 res.status(200).json({
 data: { recoveryCodes: result.recoveryCodes, previousCodesRevoked: true },
 });
}));

mfaRouter.post('/disable', csrfGuard, sensitiveActionWindow, asyncRoute(async (req, res) => {
 const body = parse(z.object({ code: codeField }), req.body);
 await disableMfa(actorRef(req).userId, body.code);
 res.status(200).json({ data: { enabled: false } });
}));

//  public: completing the login challenge 

export const publicMfaRouter = Router();

publicMfaRouter.post('/challenge', authIpLimiter, csrfGuard, asyncRoute(async (req, res) => {
 const body = parse(z.object({ challengeToken: tokenField, code: codeField }), req.body);

 // The token identifies the user; nothing else in this request does.
 const userId = await resolveChallengeUser(body.challengeToken);
 const result = await completeChallenge(userId, body.challengeToken, body.code);

 const db = await initDriver();
 const org = await db.query<{ organization_id: string; role: Role }>(
 `SELECT organization_id, role FROM organization_members
 WHERE user_id = $1 AND status = 'active' ORDER BY joined_at ASC LIMIT 1`,
 [userId],
 );
 const membership = org.rows[0];

 const client = {
 ip: req.clientIp,
 userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
 requestId: req.requestId,
 };
 const session = await createSession(db, {
 userId,
 organizationId: membership?.organization_id ?? null,
 role: membership?.role ?? null,
 client,
 });

 // Same cookie contract as a first-factor login: the refresh token is only ever
 // an HttpOnly cookie, never in a body.
 const csrfToken = setSessionCookies(res, session.accessToken, session.refreshToken);

 res.status(200).json({
 data: {
 verified: true,
 via: result.via,
 organizationId: membership?.organization_id ?? null,
 role: membership?.role ?? null,
 accessToken: session.accessToken,
 csrfToken,
 },
 });
}));
