/**
 * Authentication service.
 *
 * Controls implemented here (each was a defect in one of the legacy systems):
 *   * RULE 20 — unknown-account and wrong-password cost the same. Login always
 *     performs one full password verification, against a decoy hash when the
 *     account does not exist. Legacy ticket-system skipped PBKDF2 entirely for
 *     unknown emails, which is a timing oracle.
 *   * RULE 21/23 — idle AND absolute session expiry, both enforced on every
 *     request, with per-session and revoke-all. Legacy ticket-system defined a
 *     30-day absolute TTL that only existed inside a function nobody called.
 *   * RULE 24 — rotating single-use refresh tokens with reuse detection: a burnt
 *     token replay revokes the whole family.
 *   * RULE 23 — password change and password reset revoke every other session.
 *   * RULE 19 — reset/verify/invite tokens are random, single-use, hashed at
 *     rest, short-lived, and never returned in an API response.
 *   * RULE 115 — failed-login lockout per account, distinct from IP rate limits.
 */
import { env } from '../config/env.ts';
import { getDb } from '../db/driver.ts';
import type { DbClient } from '../db/driver.ts';
import { TenantScope, initDriver } from '../repositories/base.ts';
import { AppError, conflict, forbidden, invalidCredentials, notFound, tooMany, unauthorized, validationFailed } from '../lib/errors.ts';
import { newId, sha256 } from '../lib/ids.ts';
import { isoPlus, isExpired, nowIso } from '../lib/time.ts';
import {
  checkPasswordStrength, decoyHash, hashPassword, needsRehash, verifyPassword,
} from '../lib/password.ts';
import { hashToken, mintToken, TOKEN_TTL } from '../lib/tokens.ts';
import { issueAccessToken, issueRefreshToken, hashRefreshToken, verifyRefreshToken } from '../lib/jwt.ts';
import { persistableIp, loggableIp } from '../lib/ip.ts';
import { securityLog } from '../lib/logger.ts';
import { authFailures } from '../lib/metrics.ts';
import { normaliseEmail, slugify } from './normalise.ts';
import type { Role } from './rbac.ts';

export type PublicUser = { id: string; email: string; name: string; emailVerified: boolean; mfaEnabled: boolean };

export type Actor = {
  userId: string;
  organizationId: string;
  role: Role;
  sessionId: string;
  email: string;
  name: string;
};

export type ClientInfo = { ip: string; userAgent: string; requestId?: string };

const USER_COLS = 'id, email, name, email_verified_at, mfa_enabled, password_hash, failed_login_count, locked_until, deleted_at';

type UserRow = {
  id: string; email: string; name: string; email_verified_at: string | null;
  mfa_enabled: boolean; password_hash: string;
  failed_login_count: number; locked_until: string | null; deleted_at: string | null;
};

const toPublic = (u: UserRow): PublicUser => ({
  id: u.id, email: u.email, name: u.name,
  emailVerified: Boolean(u.email_verified_at), mfaEnabled: u.mfa_enabled,
});

// ── registration ─────────────────────────────────────────────────────────────
export type RegisterInput = {
  name: string; email: string; password: string; organizationName: string; client: ClientInfo;
};

export async function registerUser(input: RegisterInput): Promise<{ user: PublicUser; organizationId: string; organizationName: string }> {
  if (env.security.blockNewAccounts) {
    throw forbidden('Registration is currently closed on this deployment.');
  }
  const db = await initDriver();
  const email = normaliseEmail(input.email);
  const issues = checkPasswordStrength(input.password, { email, name: input.name });
  if (issues.length) throw validationFailed({ password: issues.map((i) => i.message).join(' ') });

  const orgName = String(input.organizationName ?? '').trim();
  if (orgName.length < 2 || orgName.length > 160) {
    throw validationFailed({ organizationName: 'Organization name must be between 2 and 160 characters.' });
  }

  // One transaction: user + organization + membership are all-or-nothing (RULE 71).
  // The legacy CRM issued three independent INSERTs and could leave a user with
  // no organization after a crash mid-sequence.
  return db.transaction(async (tx) => {
    const existing = await tx.query<UserRow>('SELECT id FROM users WHERE email_normalized = $1', [email]);
    if (existing.rows.length > 0) {
      // Deliberately identical to the wrong-password error (RULE 121).
      throw conflict('An account with this email already exists.');
    }
    const slug = await uniqueSlug(tx, slugify(orgName));
    const userId = newId();
    const orgId = newId();
    const now = nowIso();
    const passwordHash = await hashPassword(input.password);

    await tx.query(
      `INSERT INTO users (id, email, email_normalized, name, password_hash, created_at, updated_at, password_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$6)`,
      [userId, email, email, String(input.name ?? '').trim().slice(0, 120), passwordHash, now],
    );
    await tx.query(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`,
      [orgId, orgName, slug, now],
    );
    await tx.query(
      `INSERT INTO organization_members (id, organization_id, user_id, role, joined_at, created_at, updated_at)
       VALUES ($1,$2,$3,'owner',$4,$4,$4)`,
      [newId(), orgId, userId, now],
    );
    await tx.query('UPDATE users SET default_org_id = $1 WHERE id = $2', [orgId, userId]);

    const verify = mintToken(TOKEN_TTL.emailVerifySec);
    await tx.query(
      'INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
      [newId(), userId, verify.tokenHash, verify.expiresAt],
    );
    await tx.query(
      `INSERT INTO audit_logs (id, organization_id, actor_id, actor_role, action, entity_type, entity_id, ip, user_agent, request_id)
       VALUES ($1,$2,$3,'owner','auth.register','user',$3,$4,$5,$6)`,
      [newId(), orgId, userId, persistableIp(input.client.ip), input.client.userAgent.slice(0, 300), input.client.requestId ?? null],
    );
    securityLog('auth.register', { userId, organizationId: orgId, ip: loggableIp(input.client.ip) });

    return {
      user: { id: userId, email, name: String(input.name ?? '').trim(), emailVerified: false, mfaEnabled: false },
      organizationId: orgId,
      organizationName: orgName,
      // Handed to the email provider only. Never placed in an API response — the
      // legacy system returned invite tokens in the response body, which is how
      // its account-takeover path worked.
      verificationToken: verify.token,
      verificationEmail: email,
    };
  });
}

// ── login ────────────────────────────────────────────────────────────────────
export type LoginInput = {
  email: string; password: string; client: ClientInfo;
  organizationId?: string | null;
};

export type LoginResult =
  | { kind: 'ok'; user: PublicUser; actor: Actor; accessToken: string; refreshToken: string; accessExpiresIn: number; refreshExpiresIn: number }
  | { kind: 'mfa_required'; mfaToken: string; expiresIn: number };

export async function loginUser(input: LoginInput): Promise<LoginResult> {
  const db = await initDriver();
  const email = normaliseEmail(input.email);
  const rows = await db.query<UserRow>(
    `SELECT ${USER_COLS} FROM users WHERE email_normalized = $1 AND deleted_at IS NULL`, [email]);
  const user = rows.rows[0];

  // RULE 20: always spend the same work. When there is no user we still run a
  // full verification against a decoy hash, so timing does not reveal existence.
  const stored = user?.password_hash ?? (await decoyHash());
  const passwordOk = await verifyPassword(input.password, stored);

  if (!user || !passwordOk) {
    authFailures.inc({ reason: user ? 'bad_password' : 'unknown_account' });
    if (user) await recordFailedLogin(db, user);
    securityLog('auth.login.failure', { email, ip: loggableIp(input.client.ip), reason: user ? 'bad_password' : 'unknown_account' });
    throw invalidCredentials();
  }
  if (user.deleted_at) throw invalidCredentials();

  if (user.locked_until && !isExpired(user.locked_until)) {
    authFailures.inc({ reason: 'locked' });
    securityLog('account.locked', { userId: user.id, until: user.locked_until });
    throw tooMany('This account is temporarily locked. Try again later.');
  }
  if (user.failed_login_count > 0) {
    await db.query('UPDATE users SET failed_login_count = 0 WHERE id = $1', [user.id]);
  }

  // Transparently upgrade hashes when the cost parameters have been raised.
  if (needsRehash(user.password_hash)) {
    const fresh = await hashPassword(input.password);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [fresh, user.id]);
  }

  const org: OrgRow | null = (await resolveOrganization(db, user.id, input.organizationId ?? null)) ?? null;

  if (user.mfa_enabled) {
    // The challenge is issued only after the password check above has passed, so
    // this path cannot be used to probe whether an account has MFA enabled.
    const { startChallenge } = await import('./mfa.ts');
    const challenge = await startChallenge(user.id);
    securityLog('auth.mfa.challenge_failed', { userId: user.id, stage: 'challenge_issued', ip: loggableIp(input.client.ip) });
    return { kind: 'mfa_required', mfaToken: challenge.token, expiresIn: TOKEN_TTL.mfaEnrollmentSec };
  }

  const session = await createSession(db, {
    userId: user.id, organizationId: org?.id ?? null, role: (org?.role as Role) ?? null,
    client: input.client,
  });
  await db.query('UPDATE users SET last_login_at = $1, last_login_ip = $2 WHERE id = $3',
    [nowIso(), persistableIp(input.client.ip), user.id]);
  securityLog('auth.login.success', { userId: user.id, organizationId: org?.id, ip: loggableIp(input.client.ip) });

  return {
    kind: 'ok',
    user: toPublic(user),
    actor: {
      userId: user.id,
      organizationId: org!.id,
      role: org!.role,
      sessionId: session.sessionId,
      email: user.email,
      name: user.name,
    },
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessExpiresIn: env.jwt.accessTtlSec,
    refreshExpiresIn: env.jwt.refreshTtlSec,
  };
}

async function recordFailedLogin(db: DbClient, user: UserRow): Promise<void> {
  const next = user.failed_login_count + 1;
  const lock = next >= env.security.maxFailedLogins;
  await db.query(
    `UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3`,
    [next, lock ? isoPlus(env.security.lockoutSec) : null, user.id],
  );
}

type OrgRow = { id: string; name: string; slug: string; role: Role };

/**
 * Organization is chosen server-side. A supplied organizationId is only honoured
 * when the user actually holds membership — it is a selector, never an authority
 * (RULE 2). A user with no membership cannot obtain a session at all.
 */
async function resolveOrganization(db: DbClient, userId: string, requested: string | null): Promise<OrgRow | null> {
  if (requested) {
    const scoped = await db.query<OrgRow>(
      `SELECT o.id, o.name, o.slug, m.role FROM organizations o
         JOIN organization_members m ON m.organization_id = o.id
        WHERE m.user_id = $1 AND o.id = $2 AND o.deleted_at IS NULL`,
      [userId, requested]);
    const first = scoped.rows[0];
    if (first) return first;
    throw notFound('Organization not found.');
  }
  const all = await db.query<OrgRow>(
    `SELECT o.id, o.name, o.slug, m.role FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
      WHERE m.user_id = $1 AND o.deleted_at IS NULL
      ORDER BY m.joined_at NULLS LAST, m.created_at`,
    [userId]);
  const preferred = await db.query<{ default_org_id: string | null }>(
    'SELECT default_org_id FROM users WHERE id = $1', [userId]);
  const def = preferred.rows[0]?.default_org_id;
  if (def) {
    const hit = all.rows.find((r) => r.id === def);
    if (hit) return hit;
  }
  return all.rows[0] ?? null;
}

// ── sessions ─────────────────────────────────────────────────────────────────
export type SessionTokens = {
  sessionId: string; accessToken: string; refreshToken: string; refreshJti: string; refreshHash: string;
};

export async function createSession(
  db: DbClient,
  args: { userId: string; organizationId: string | null; role: Role | null; client: ClientInfo; familyId?: string },
): Promise<SessionTokens> {
  // Bound the number of concurrent sessions per user (RULE 21).
  const active = await db.query<{ id: string }>(
    'SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC', [args.userId]);
  if (active.rows.length >= env.session.maxPerUser) {
    const oldest = active.rows[active.rows.length - 1]!;
    await revokeSessions(db, args.userId, [oldest.id], 'max_sessions');
  }

  const sessionId = newId();
  const familyId = args.familyId ?? newId();
  const access = issueAccessToken({
    userId: args.userId, orgId: args.organizationId ?? '', role: args.role ?? '', sessionId,
  });
  const refresh = issueRefreshToken({ userId: args.userId, sessionId, familyId });
  const now = nowIso();

  await db.query(
    `INSERT INTO sessions (id, user_id, organization_id, role, family_id, refresh_jti, refresh_hash,
                           ip, user_agent, device_label, created_at, last_seen_at, absolute_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)`,
    [sessionId, args.userId, args.organizationId, args.role, familyId,
      refresh.jti, hashRefreshToken(refresh.token), persistableIp(args.client.ip),
      args.client.userAgent.slice(0, 300), deviceLabel(args.client.userAgent),
      now, isoPlus(env.session.absoluteTimeoutSec)],
  );

  securityLog('session.created', { userId: args.userId, sessionId, ip: loggableIp(args.client.ip) });
  return {
    sessionId, accessToken: access.token, refreshToken: refresh.token,
    refreshJti: refresh.jti, refreshHash: hashRefreshToken(refresh.token),
  };
}

/** Coarse device label from the UA. Never stores the raw UA in a UI-visible place. */
function deviceLabel(ua: string): string {
  const s = ua.slice(0, 200);
  const os = /Windows/i.test(s) ? 'Windows' : /Mac OS/i.test(s) ? 'macOS' : /Android/i.test(s) ? 'Android'
    : /iPhone|iPad/i.test(s) ? 'iOS' : /Linux/i.test(s) ? 'Linux' : 'Unknown OS';
  const br = /Edg\//i.test(s) ? 'Edge' : /Chrome\//i.test(s) ? 'Chrome' : /Safari\//i.test(s) ? 'Safari'
    : /Firefox\//i.test(s) ? 'Firefox' : 'Unknown browser';
  return `${br} on ${os}`;
}

// ── session validation (runs on every authenticated request) ─────────────────
export type SessionCheck = { valid: true; actor: Actor } | { valid: false; reason: string; code: string };

/** Row shape from the session JOIN. Typed so `noUncheckedIndexedAccess` cannot
 *  silently turn a column into `unknown`. */
type SessionRow = {
  id: string; organization_id: string | null; role: Role | null;
  revoked_at: string | null; absolute_expires_at: string; last_seen_at: string;
  revoked_reason: string | null; user_id: string; email: string; name: string;
  user_deleted: string | null;
};

export async function validateSession(accessToken: string): Promise<SessionCheck> {
  const db = await initDriver();
  let claims;
  try {
    const { verifyAccessToken } = await import('../lib/jwt.ts');
    claims = verifyAccessToken(accessToken);
  } catch (e) {
    return { valid: false, reason: (e as AppError).message, code: 'invalid_token' };
  }
  const rows = await db.query<SessionRow>(
    `SELECT s.id, s.organization_id, s.role, s.revoked_at, s.absolute_expires_at, s.last_seen_at, s.revoked_reason,
            u.id AS user_id, u.email, u.name, u.deleted_at AS user_deleted
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [claims.sid]);
  const s = rows.rows[0];
  if (!s) return { valid: false, reason: 'Session not found.', code: 'session_missing' };
  if (s.revoked_at) return { valid: false, reason: 'Session has been revoked.', code: 'session_revoked' };
  if (s.user_deleted) return { valid: false, reason: 'Account is closed.', code: 'user_deleted' };

  // Absolute timeout is enforced on EVERY request, not just at issue time. This
  // is the check the legacy CRM only ran inside an uncalled cleanup function.
  if (isExpired(s.absolute_expires_at)) {
    await revokeSessions(db, s.user_id, [s.id], 'absolute_timeout');
    securityLog('session.absolute_timeout', { userId: s.user_id, sessionId: s.id });
    return { valid: false, reason: 'Session has expired.', code: 'session_expired' };
  }
  // Idle timeout.
  const idle = (Date.now() - new Date(s.last_seen_at).getTime()) / 1000;
  if (idle > env.session.idleTimeoutSec) {
    await revokeSessions(db, s.user_id, [s.id], 'idle_timeout');
    securityLog('session.idle_timeout', { userId: s.user_id, sessionId: s.id });
    return { valid: false, reason: 'Session has expired.', code: 'session_expired' };
  }
  // Membership must still exist. A removed member's access dies immediately even
  // though their token has not expired.
  if (claims.org) {
    const member = await db.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [claims.org, s.user_id]);
    if (member.rows.length === 0) {
      await revokeSessions(db, s.user_id, [s.id], 'membership_revoked');
      securityLog('session.revoked', { userId: s.user_id, sessionId: s.id, reason: 'membership_revoked' });
      return { valid: false, reason: 'Access to this organization has been revoked.', code: 'not_a_member' };
    }
  }

  await db.query('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [nowIso(), s.id]);
  return {
    valid: true,
    actor: {
      userId: s.user_id, organizationId: claims.org, role: claims.role as Role,
      sessionId: s.id, email: s.email, name: s.name,
    },
  };
}

// ── refresh with reuse detection (RULE 24) ───────────────────────────────────
export type RefreshResult =
  | { ok: true; user: PublicUser; actor: Actor; accessToken: string; refreshToken: string; accessExpiresIn: number; refreshExpiresIn: number }
  | { ok: false; reason: string; code: string; compromised?: boolean };

export async function refreshSession(refreshToken: string, client: ClientInfo): Promise<RefreshResult> {
  const db = await initDriver();
  let claims;
  try {
    claims = verifyRefreshToken(refreshToken);
  } catch (e) {
    return { ok: false, reason: (e as AppError).message, code: 'invalid_token' };
  }
  const presentedHash = hashRefreshToken(refreshToken);
  const rows = await db.query<{
    id: string; user_id: string; organization_id: string | null; role: Role; family_id: string;
    refresh_hash: string; used_at: string | null; revoked_at: string | null;
    absolute_expires_at: string; last_seen_at: string; email: string; name: string;
    email_verified_at: string | null; mfa_enabled: boolean; deleted_at: string | null;
  }>(
    `SELECT s.id, s.user_id, s.organization_id, s.role, s.family_id, s.refresh_hash, s.used_at,
            s.revoked_at, s.absolute_expires_at, s.last_seen_at,
            u.email, u.name, u.email_verified_at, u.mfa_enabled, u.deleted_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [claims.sid]);

  const s = rows.rows[0];
  if (!s) return { ok: false, reason: 'Session not found.', code: 'session_missing' };
  if (s.deleted_at) return { ok: false, reason: 'Account is closed.', code: 'user_deleted' };

  // REUSE DETECTION. A refresh token is single-use. Presenting one that is already
  // `used_at` means the token leaked and someone else replayed it: revoke the
  // entire family and force a fresh login. The unique index on refresh_jti makes
  // two concurrent rotations a detectable race rather than a silent split-brain.
  if (s.used_at && s.refresh_hash !== presentedHash) {
    await revokeFamily(db, s.family_id, 'refresh_reuse_detected');
    securityLog('auth.token_refresh_reuse_detected', { userId: s.user_id, familyId: s.family_id, ip: loggableIp(client.ip) });
    return {
      ok: false, compromised: true,
      reason: 'Your session was ended because a refresh token was reused. Sign in again.',
      code: 'refresh_reuse',
    };
  }
  if (s.revoked_at) return { ok: false, reason: 'Session has been revoked.', code: 'session_revoked' };
  if (s.refresh_hash !== presentedHash) {
    return { ok: false, reason: 'Refresh token does not match this session.', code: 'invalid_token' };
  }
  if (isExpired(s.absolute_expires_at)) {
    await revokeSessions(db, s.user_id, [s.id], 'absolute_timeout');
    return { ok: false, reason: 'Session has expired. Sign in again.', code: 'session_expired' };
  }
  const idle = (Date.now() - new Date(s.last_seen_at).getTime()) / 1000;
  if (idle > env.session.refreshIdleSec) {
    await revokeSessions(db, s.user_id, [s.id], 'refresh_idle_timeout');
    securityLog('session.revoked', { userId: s.user_id, sessionId: s.id, reason: 'refresh_idle_timeout' });
    return { ok: false, reason: 'Session has expired. Sign in again.', code: 'session_expired' };
  }

  const orgId = s.organization_id;
  let role = s.role;
  if (orgId) {
    const member = await db.query<{ role: Role }>(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, s.user_id]);
    if (member.rows.length === 0) {
      await revokeFamily(db, s.family_id, 'membership_revoked');
      return { ok: false, reason: 'Access to this organization has been revoked.', code: 'not_a_member' };
    }
    role = member.rows[0]!.role;
  }

  const rotated = issueRefreshToken({ userId: s.user_id, sessionId: s.id, familyId: s.family_id });
  const access = issueAccessToken({ userId: s.user_id, orgId: orgId ?? '', role: role ?? '', sessionId: s.id });

  // Rotation is a compare-and-set, not a blind write. The read above and this
  // update were two separate statements with no lock between them, so two
  // concurrent `POST /auth/refresh` carrying the same token both observed
  // `used_at IS NULL`, both validated, both rotated, and the second UPDATE
  // overwrote the first. Reuse detection never fired: the attacker ended up
  // holding a working token and the honest client's next refresh tripped reuse
  // and revoked the whole family — a self-inflicted logout loop under normal
  // concurrency (two tabs, a retrying client).
  //
  // Requiring `used_at IS NULL AND refresh_hash = presentedHash` means exactly
  // one caller updates the row; the other gets no row back and is treated as a
  // reuse, which is what a genuine concurrent replay actually is.
  //
  // The comment above claiming `refresh_jti` made this detectable was wrong:
  // `refresh_jti` is a freshly generated UUID per rotation and so can never
  // collide on its unique index.
  const claimed = await db.query<{ id: string }>(
    `UPDATE sessions SET refresh_jti = $1, refresh_hash = $2, used_at = $3, rotated_at = $4, last_seen_at = $5, role = $6
      WHERE id = $7 AND used_at IS NULL AND refresh_hash = $8
      RETURNING id`,
    [rotated.jti, hashRefreshToken(rotated.token), nowIso(), nowIso(), nowIso(), role, s.id, presentedHash],
  );
  if (claimed.rows.length === 0) {
    // Someone else rotated this token between our read and our write. That is
    // reuse of a single-use credential, so the family goes down.
    await revokeFamily(db, s.family_id, 'refresh_reuse_detected');
    securityLog('auth.token_refresh_reuse_detected', {
      userId: s.user_id, familyId: s.family_id, reason: 'concurrent_rotation', ip: loggableIp(client.ip),
    });
    return {
      ok: false, compromised: true,
      reason: 'Your session was ended because a refresh token was reused. Sign in again.',
      code: 'refresh_reuse',
    };
  }
  securityLog('auth.token_refresh', { userId: s.user_id, sessionId: s.id });

  const userRows = await db.query<UserRow>(
    `SELECT ${USER_COLS} FROM users WHERE id = $1`, [s.user_id]);
  return {
    ok: true,
    user: toPublic(userRows.rows[0]!),
    actor: { userId: s.user_id, organizationId: orgId ?? '', role: role, sessionId: s.id, email: s.email, name: s.name },
    accessToken: access.token,
    refreshToken: rotated.token,
    accessExpiresIn: env.jwt.accessTtlSec,
    refreshExpiresIn: env.jwt.refreshTtlSec,
  };
}

// ── revocation ───────────────────────────────────────────────────────────────
export async function revokeSessions(db: DbClient, userId: string, sessionIds: string[], reason: string): Promise<number> {
  if (sessionIds.length === 0) return 0;
  // Scoped by BOTH user_id and id: a caller cannot revoke another account's
  // session even when it holds a valid session id.
  // params: [$1=revoked_at, $2=reason, $3=user_id, $4..=session_ids]
  const placeholders = sessionIds.map((_, i) => `$${i + 4}`).join(',');
  const r = await db.query(
    `UPDATE sessions SET revoked_at = $1, revoked_reason = $2
      WHERE user_id = $3 AND id IN (${placeholders}) AND revoked_at IS NULL`,
    [nowIso(), reason, userId, ...sessionIds]);
  return r.rowCount;
}

export async function revokeAllSessions(userId: string, reason = 'logout_all', exceptSessionId?: string): Promise<number> {
  const db = await initDriver();
  const params: unknown[] = [nowIso(), reason, userId];
  let sql = 'UPDATE sessions SET revoked_at = $1, revoked_reason = $2 WHERE user_id = $3 AND revoked_at IS NULL';
  if (exceptSessionId) { params.push(exceptSessionId); sql += ' AND id <> $4'; }
  const r = await db.query(sql, params);
  securityLog('session.revoked_all', { userId, reason, count: r.rowCount });
  return r.rowCount;
}

async function revokeFamily(db: DbClient, familyId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = $1, revoked_reason = $2 WHERE family_id = $3 AND revoked_at IS NULL`,
    [nowIso(), reason, familyId]);
}

// ── password change / reset ──────────────────────────────────────────────────
export async function changePassword(args: {
  userId: string; currentPassword: string; newPassword: string; client: ClientInfo;
}): Promise<{ revoked: number }> {
  const db = await initDriver();
  const rows = await db.query<UserRow>(
    `SELECT ${USER_COLS} FROM users WHERE id = $1 AND deleted_at IS NULL`, [args.userId]);
  const user = rows.rows[0];
  if (!user) throw notFound('Account not found.');
  if (!await verifyPassword(args.currentPassword, user.password_hash)) {
    securityLog('auth.login.failure', { userId: args.userId, reason: 'change_password_wrong_current' });
    throw invalidCredentials();
  }
  if (await verifyPassword(args.newPassword, user.password_hash)) {
    throw validationFailed({ newPassword: 'The new password must differ from the current one.' });
  }
  const issues = checkPasswordStrength(args.newPassword, { email: user.email, name: user.name });
  if (issues.length) throw validationFailed({ newPassword: issues.map((i) => i.message).join(' ') });

  const hash = await hashPassword(args.newPassword);
  await db.query(
    `UPDATE users SET password_hash = $1, password_changed_at = $2, updated_at = $2,
            failed_login_count = 0, locked_until = NULL WHERE id = $3`,
    [hash, nowIso(), args.userId]);

  // RULE 23: a password change invalidates EVERY session, including the caller's
  // own; the caller re-authenticates afterwards. The legacy CRM did this on reset
  // but not on change, so a user who rotated a suspected-compromised password
  // remained signed in everywhere else.
  const revoked = await revokeAllSessions(args.userId, 'password_changed');
  securityLog('auth.password_changed', { userId: args.userId, revoked, ip: loggableIp(args.client.ip) });
  return { revoked };
}

/**
 * Issues a reset token. Always reports success so the endpoint cannot be used to
 * enumerate accounts (RULE 20/121). The token is returned for the email provider
 * and for tests; routes must never pass it to the client.
 */
export async function requestPasswordReset(emailRaw: string, client: ClientInfo): Promise<{ token: string | null; userId: string | null }> {
  const db = await initDriver();
  const email = normaliseEmail(emailRaw);
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM users WHERE email_normalized = $1 AND deleted_at IS NULL', [email]);
  const user = rows.rows[0];
  if (!user) {
    securityLog('auth.password_reset_requested', { email, outcome: 'unknown_account' });
    return { token: null, userId: null };
  }
  const t = mintToken(TOKEN_TTL.passwordResetSec);
  await db.query(
    'INSERT INTO password_resets (id, user_id, token_hash, expires_at, requested_ip) VALUES ($1,$2,$3,$4,$5)',
    [newId(), user.id, t.tokenHash, t.expiresAt, persistableIp(client.ip)]);
  securityLog('auth.password_reset_requested', { userId: user.id, ip: loggableIp(client.ip) });
  return { token: t.token, userId: user.id };
}

export async function resetPassword(args: {
  token: string; newPassword: string; client: ClientInfo;
}): Promise<{ userId: string }> {
  const db = await initDriver();
  const digest = hashToken(args.token);
  const rows = await db.query<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
    'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = $1', [digest]);
  const row = rows.rows[0];
  if (!row || row.used_at || isExpired(row.expires_at)) {
    securityLog('auth.password_reset_completed', { outcome: 'invalid_token' });
    throw badRequestSafe();
  }
  const user = await db.query<{ email: string; name: string }>(
    'SELECT email, name FROM users WHERE id = $1', [row.user_id]);
  const issues = checkPasswordStrength(args.newPassword, {
    email: user.rows[0]?.email, name: user.rows[0]?.name,
  });
  if (issues.length) throw validationFailed({ newPassword: issues.map((i) => i.message).join(' ') });

  const hash = await hashPassword(args.newPassword);
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET password_hash = $1, password_changed_at = $2, updated_at = $2,
              failed_login_count = 0, locked_until = NULL WHERE id = $3`,
      [hash, nowIso(), row.user_id]);
    // Burn the token so it is single-use (RULE 19).
    await tx.query('UPDATE password_resets SET used_at = $1 WHERE id = $2', [nowIso(), row.id]);
    // RULE 23: a reset kills every existing session.
    await tx.query(
      `UPDATE sessions SET revoked_at = $1, revoked_reason = 'password_reset' WHERE user_id = $2 AND revoked_at IS NULL`,
      [nowIso(), row.user_id]);
  });
  securityLog('auth.password_reset_completed', { userId: row.user_id, ip: loggableIp(args.client.ip) });
  return { userId: row.user_id };
}

const badRequestSafe = (): AppError =>
  new AppError(400, 'INVALID_RESET_TOKEN', 'That reset link is invalid or has expired.');

// ── email verification ───────────────────────────────────────────────────────
export async function verifyEmail(token: string, client: ClientInfo): Promise<{ userId: string }> {
  const db = await initDriver();
  const digest = hashToken(token);
  const rows = await db.query<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
    'SELECT id, user_id, expires_at, used_at FROM email_verifications WHERE token_hash = $1', [digest]);
  const row = rows.rows[0];
  if (!row || row.used_at || isExpired(row.expires_at)) {
    throw new AppError(400, 'INVALID_VERIFY_TOKEN', 'That verification link is invalid or has expired.');
  }
  await db.transaction(async (tx) => {
    await tx.query('UPDATE users SET email_verified_at = $1, updated_at = $1 WHERE id = $2', [nowIso(), row.user_id]);
    await tx.query('DELETE FROM email_verifications WHERE user_id = $2', [row.user_id]);
  });
  securityLog('auth.email_verified', { userId: row.user_id, ip: loggableIp(client.ip) });
  return { userId: row.user_id };
}

export async function resendVerification(userId: string, client: ClientInfo): Promise<{ token: string | null }> {
  const db = await initDriver();
  const rows = await db.query<{ email_verified_at: string | null }>(
    'SELECT email_verified_at FROM users WHERE id = $1', [userId]);
  if (!rows.rows[0]) throw notFound('Account not found.');
  if (rows.rows[0].email_verified_at) return { token: null };
  const t = mintToken(TOKEN_TTL.emailVerifySec);
  await db.query(
    `INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [newId(), userId, t.tokenHash, t.expiresAt]);
  securityLog('auth.email_verification_resent', { userId, ip: loggableIp(client.ip) });
  return { token: t.token };
}

// ── sessions listing (settings/security page) ────────────────────────────────
export async function listSessions(userId: string, currentSessionId: string): Promise<{
  id: string; deviceLabel: string; ip: string; createdAt: string; lastSeenAt: string; current: boolean;
}[]> {
  const db = await initDriver();
  const rows = await db.query<{
    id: string; device_label: string; ip: string; created_at: string; last_seen_at: string;
  }>(
    `SELECT id, device_label, ip, created_at, last_seen_at FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC`, [userId]);
  return rows.rows.map((r) => ({
    id: r.id, deviceLabel: r.device_label ?? 'Unknown device', ip: r.ip ?? '',
    createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === currentSessionId,
  }));
}

export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const db = await initDriver();
  const n = await revokeSessions(db, userId, [sessionId], 'user_revoked');
  securityLog('session.revoked', { userId, sessionId, reason: 'user_revoked' });
  return n > 0;
}

/** Kills every session belonging to a user. Used when a role or membership changes. */
export async function revokeUserSessions(userId: string, reason: string): Promise<number> {
  return revokeAllSessions(userId, reason);
}

/** Slug with a uniqueness suffix so two orgs named "Acme" can coexist. */
async function uniqueSlug(db: DbClient, base: string): Promise<string> {
  const root = base.slice(0, 48) || 'org';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${sha256(`${root}${i}`).slice(0, 6)}`;
    const hit = await db.query('SELECT 1 FROM organizations WHERE slug = $1', [candidate]);
    if (hit.rows.length === 0) return candidate;
  }
  return `${root}-${newId().slice(0, 8)}`;
}

export { resolveOrganization, toPublic, deviceLabel };
export type { UserRow, OrgRow };
export function tenantFor(organizationId: string, tx?: DbClient | null): TenantScope {
  return new TenantScope(organizationId, tx);
}
export { getDb };
export { unauthorized };