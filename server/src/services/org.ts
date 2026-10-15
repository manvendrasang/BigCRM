/**
 * Organization, membership, teams and invitations.
 *
 * The invitation flow is the most important thing here. Legacy ticket-system had
 * three compounding defects in it, all verified:
 *   1. `accept_invite` added an *existing* user to the organization without ever
 *      checking their password — holding the token was sufficient.
 *   2. The raw invite token was returned in the API response body AND printed to
 *      stdout by the console email provider.
 *   3. `InviteIn.role` validated against all five roles including `owner`, so an
 *      admin could mint an owner-level invitation even though the HTML form only
 *      offered four.
 *
 * Each is fixed: tokens never leave the server, acceptance requires proof of
 * control of the mailbox or an authenticated identity, and the role offered is
 * bounded by the inviter's own authority.
 */
import { env } from '../config/env.ts';
import { initDriver, TenantScope } from '../repositories/base.ts';
import type { DbClient } from '../db/driver.ts';
import { badRequest, conflict, forbidden, notFound, validationFailed } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { isExpired, nowIso } from '../lib/time.ts';
import { hashToken, mintToken, TOKEN_TTL } from '../lib/tokens.ts';
import { checkPasswordStrength, hashPassword } from '../lib/password.ts';
import { logger, securityLog } from '../lib/logger.ts';
import { normaliseEmail } from './normalise.ts';
import { persistableIp } from '../lib/ip.ts';
import { revokeUserSessions } from './auth.ts';
import {
  assignableRoles, can, canAssignRole, canRemoveMember, isRole, wouldOrphanOwners,
  type Role,
} from './rbac.ts';

export type ActorRef = { userId: string; organizationId: string; role: Role; email: string };

// ── organization ─────────────────────────────────────────────────────────────
export type OrgRow = {
  id: string; name: string; slug: string; currency: string; timezone: string; locale: string;
  status: string; retention_days: number; created_at: string;
};

export async function getOrganization(actor: ActorRef): Promise<OrgRow> {
  const db = await initDriver();
  // Tenant predicate on every read (RULE 14).
  const r = await db.query<OrgRow>(
    'SELECT * FROM organizations WHERE id = $1 AND deleted_at IS NULL', [actor.organizationId]);
  if (!r.rows[0]) throw notFound('Organization not found.');
  return r.rows[0];
}

const ORG_UPDATABLE = ['name', 'currency', 'timezone', 'locale'] as const;

export async function updateOrganization(
  actor: ActorRef,
  patch: Partial<Record<(typeof ORG_UPDATABLE)[number], string>>,
): Promise<OrgRow> {
  const db = await initDriver();
  const before = await getOrganization(actor);
  // RULE 33: explicit allowlist. No client value ever reaches the SET clause
  // unless it appears here.
  const entries = ORG_UPDATABLE
    .filter((k) => patch[k] !== undefined && patch[k] !== null)
    .map((k) => [k, String(patch[k]).trim().slice(0, 160)] as const);
  if (entries.length === 0) return before;

  const sets = entries.map((_, i) => `$${i + 3}`).join(', ');
  const values = entries.map(([, v]) => v);
  await db.query(
    `UPDATE organizations SET ${sets}, updated_at = $1 WHERE id = $2 AND deleted_at IS NULL`,
    [nowIso(), actor.organizationId, ...values]);

  const after = await getOrganization(actor);
  await writeAudit(db, {
    organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
    action: 'organization.updated', entityType: 'organization', entityId: actor.organizationId,
    before, after,
  });
  return after;
}

// ── members ──────────────────────────────────────────────────────────────────
export type MemberRow = {
  user_id: string; email: string; name: string; role: Role; status: string;
  joined_at: string | null; created_at: string; mfa_enabled: boolean; email_verified_at: string | null;
  last_login_at: string | null; locked_until: string | null;
};

export async function listMembers(actor: ActorRef): Promise<MemberRow[]> {
  const db = await initDriver();
  const r = await db.query<MemberRow>(
    `SELECT m.user_id, u.email, u.name, m.role, m.status, m.joined_at, m.created_at,
            u.mfa_enabled, u.email_verified_at, u.last_login_at, u.locked_until
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND u.deleted_at IS NULL
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2
                          WHEN 'sales' THEN 3 ELSE 4 END, m.created_at`,
    [actor.organizationId]);
  return r.rows;
}

export async function ownerCount(db: DbClient, organizationId: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM organization_members
      WHERE organization_id = $1 AND role = 'owner'`, [organizationId]);
  return r.rows[0]!.n;
}

async function memberRole(db: DbClient, organizationId: string, userId: string): Promise<Role | null> {
  const r = await db.query<{ role: Role }>(
    'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
    [organizationId, userId]);
  return r.rows[0]?.role ?? null;
}

/**
 * Role change with full hierarchy enforcement (RULE 27, 28).
 * Rejects: unknown role, self-escalation, touching a peer or superior, minting
 * owner, and demoting the last owner.
 */
export async function changeMemberRole(
  actor: ActorRef,
  targetUserId: string,
  nextRole: string,
): Promise<{ role: Role; sessionsRevoked: number }> {
  const db = await initDriver();
  if (!isRole(nextRole)) throw validationFailed({ role: 'Unknown role.' });

  const current = await memberRole(db, actor.organizationId, targetUserId);
  if (current === null) throw notFound('That user is not a member of this organization.');

  if (targetUserId === actor.userId && current !== nextRole) {
    // Self-escalation is refused outright; self-demotion is allowed but pointless.
    securityLog('permission.denied', {
      userId: actor.userId, organizationId: actor.organizationId, reason: 'self_role_change',
      currentRole: current, attemptedRole: nextRole,
    });
    throw forbidden('You cannot change your own role.');
  }
  if (!canAssignRole(actor.role, current, nextRole)) {
    securityLog('permission.denied', {
      userId: actor.userId, organizationId: actor.organizationId,
      reason: 'role_hierarchy', currentRole: current, attemptedRole: nextRole, actorRole: actor.role,
    });
    throw forbidden(`You cannot set the role '${nextRole}' for this member.`);
  }

  const guard = wouldOrphanOwners({
    currentOwners: await ownerCount(db, actor.organizationId),
    targetCurrentRole: current,
    action: 'demote',
  });
  if (guard) throw conflict(guard);

  await db.query(
    'UPDATE organization_members SET role = $1, updated_at = $2 WHERE organization_id = $3 AND user_id = $4',
    [nextRole, nowIso(), actor.organizationId, targetUserId]);

  // Changing someone's role must not leave them holding a live session minted
  // under the old authority: revoke and force re-authentication.
  const revoked = await revokeUserSessions(targetUserId, 'role_changed');
  await writeAudit(db, {
    organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
    action: 'member.role_changed', entityType: 'user', entityId: targetUserId,
    before: { role: current }, after: { role: nextRole },
  });
  securityLog('member.role_changed', {
    userId: actor.userId, organizationId: actor.organizationId,
    target: targetUserId, from: current, to: nextRole, sessionsRevoked: revoked,
  });
  return { role: nextRole, sessionsRevoked: revoked };
}

/**
 * Transfers ownership to another member (RULE 27).
 *
 * This is the only path by which a second owner can ever exist — `owner` is
 * unassignable through an invitation and through `changeMemberRole`, because an
 * owner can outrank every other role and demote or remove anyone. Minting a
 * second owner by invitation would hand that power to whoever accepted the link.
 *
 * Guards, in order:
 *   1. Only a current owner may transfer (the route also enforces `requireRole`).
 *   2. Re-authentication is required. An attacker who steals an owner session
 *      cookie still cannot transfer ownership without the password.
 *   3. The successor must already be an active member of *this* organization.
 *   4. Transferring to yourself is a no-op and is refused as such.
 *   5. The demotion of the outgoing owner runs in the same transaction as the
 *      promotion, so the organization can never be left with zero owners.
 *
 * Both users' sessions are revoked: their authority has changed in both
 * directions, and a token minted under the old roles must not survive.
 */
export async function transferOwnership(args: {
  actor: ActorRef;
  newOwnerId: string;
  currentPassword: string;
  client: { ip: string; userAgent: string; requestId?: string };
}): Promise<{ newOwnerId: string; previousOwnerId: string; sessionsRevoked: number }> {
  const db = await initDriver();
  const { actor, newOwnerId } = args;

  if (actor.role !== 'owner') {
    securityLog('permission.denied', {
      userId: actor.userId, organizationId: actor.organizationId, reason: 'transfer_not_owner', actorRole: actor.role,
    });
    throw forbidden('Only an owner can transfer ownership.');
  }

  if (newOwnerId === actor.userId) {
    throw badRequest('You already own this organization.');
  }

  // Re-authenticate the actor against the stored hash.
  const me = await db.query<{ password_hash: string; deleted_at: string | null }>(
    'SELECT password_hash, deleted_at FROM users WHERE id = $1', [actor.userId]);
  const meRow = me.rows[0];
  if (!meRow || meRow.deleted_at) throw notFound('Account not found.');

  const { verifyPassword } = await import('../lib/password.ts');
  if (!await verifyPassword(args.currentPassword, meRow.password_hash)) {
    securityLog('permission.denied', {
      userId: actor.userId, organizationId: actor.organizationId, reason: 'transfer_wrong_password', ip: args.client.ip,
    });
    // Deliberately identical to a login failure, and no more informative.
    throw forbidden('Ownership transfer could not be verified.');
  }

  const successor = await memberRole(db, actor.organizationId, newOwnerId);
  if (successor === null) {
    throw notFound('That user is not a member of this organization.');
  }

  const now = nowIso();
  const ownerCountBefore = await ownerCount(db, actor.organizationId);
  if (ownerCountBefore < 1) {
    // Should be unreachable; treated as fatal rather than repaired silently.
    throw conflict('This organization has no owner. Contact support.');
  }

  await db.transaction(async (tx) => {
    const scope = new TenantScope(actor.organizationId, tx);
    // Promote first, then demote. The order matters: the intermediate state
    // always has at least two owners, never zero, even if the demote fails.
    await tx.query(
      `UPDATE organization_members SET role = 'owner', updated_at = $1
        WHERE organization_id = $2 AND user_id = $3 AND status = 'active'`,
      [now, actor.organizationId, newOwnerId]);
    await tx.query(
      `UPDATE organization_members SET role = 'admin', updated_at = $1
        WHERE organization_id = $2 AND user_id = $3`,
      [now, actor.organizationId, actor.userId]);

    const remaining = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM organization_members
        WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`,
      [actor.organizationId]);
    if ((remaining.rows[0]?.n ?? 0) < 1) {
      // Refuse to commit an organization with no owner.
      throw conflict('The transfer would leave the organization without an owner.');
    }

    // Inside a transaction a swallowed audit error poisons it: PostgreSQL aborts
    // the whole transaction on any statement error, and `COMMIT` on an aborted
    // transaction performs a ROLLBACK and returns the tag "ROLLBACK" *without
    // raising*. The promotion and demotion would vanish while this function
    // still returned a success shape and the route answered 200. `bestEffort`
    // wraps the write in a SAVEPOINT so a failed audit row costs only the audit
    // row. See repositories/base.ts for the full rationale.
    await scope.bestEffort('transfer_ownership_audit', async (auditScope) => {
      await writeAudit(auditScope.unsafe, {
        organizationId: actor.organizationId, actorId: actor.userId, actorRole: 'owner',
        action: 'members.transfer_ownership', entityType: 'organization', entityId: actor.organizationId,
        before: { owner: actor.userId }, after: { owner: newOwnerId },
        ip: args.client.ip, userAgent: args.client.userAgent, requestId: args.client.requestId,
      });
    });
  });

  const revoked = await revokeUserSessions(actor.userId, 'ownership_transferred')
    + await revokeUserSessions(newOwnerId, 'ownership_received');

  securityLog('member.role_changed', {
    userId: actor.userId, organizationId: actor.organizationId,
    reason: 'ownership_transferred', from: actor.userId, to: newOwnerId, sessionsRevoked: revoked,
  });

  return { newOwnerId, previousOwnerId: actor.userId, sessionsRevoked: revoked };
}

export async function removeMember(actor: ActorRef, targetUserId: string): Promise<{ removed: boolean; sessionsRevoked: number }> {
  const db = await initDriver();
  const current = await memberRole(db, actor.organizationId, targetUserId);
  if (current === null) throw notFound('That user is not a member of this organization.');

  if (!canRemoveMember(actor.role, current)) {
    securityLog('permission.denied', {
      userId: actor.userId, organizationId: actor.organizationId, reason: 'remove_not_permitted', targetRole: current,
    });
    throw forbidden('Only an owner can remove a member.');
  }
  const guard = wouldOrphanOwners({
    currentOwners: await ownerCount(db, actor.organizationId),
    targetCurrentRole: current,
    action: 'remove',
  });
  if (guard) throw conflict(guard);

  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [actor.organizationId, targetUserId]);
    // Unassign their work so nothing dangles (the TaskFlow lesson, done
    // transactionally rather than as two independent writes).
    for (const [table, col] of [['contacts', 'owner_id'], ['companies', 'owner_id'],
      ['leads', 'owner_id'], ['deals', 'owner_id'], ['tasks', 'assignee_id']] as const) {
      await tx.query(
        `UPDATE ${table} SET ${col} = NULL WHERE organization_id = $1 AND ${col} = $2`,
        [actor.organizationId, targetUserId]);
    }
  });

  const revoked = await revokeUserSessions(targetUserId, 'membership_removed');
  await writeAudit(db, {
    organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
    action: 'member.removed', entityType: 'user', entityId: targetUserId, before: { role: current },
  });
  securityLog('member.removed', { userId: actor.userId, organizationId: actor.organizationId, target: targetUserId, sessionsRevoked: revoked });
  return { removed: true, sessionsRevoked: revoked };
}

// ── invitations (RULE 29) ────────────────────────────────────────────────────
export type InviteResult = { invitationId: string; expiresAt: string; email: string; role: Role };

/**
 * The raw token is handed to `deliver` and is NOT returned. Returning it would
 * reproduce the legacy defect where the invite token appeared in the API
 * response body and in stdout logs, which made the invitation a bearer
 * credential that any API client could redeem.
 */
export async function inviteMember(
  actor: ActorRef,
  args: {
    email: string; role: string; teamId?: string | null;
    client: { ip: string; userAgent: string; requestId?: string };
    deliver: (input: { email: string; token: string; organizationName: string; inviterName: string; role: Role }) => Promise<void>;
  },
): Promise<InviteResult> {
  const db = await initDriver();
  const email = normaliseEmail(args.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw validationFailed({ email: 'Enter a valid email address.' });
  if (!isRole(args.role)) throw validationFailed({ role: 'Unknown role.' });
  if (!can(actor.role, 'users.invite')) throw forbidden('You cannot invite members.');

  // RULE 27: the inviter may only offer a role they could themselves assign.
  if (!canAssignRole(actor.role, null, args.role)) {
    securityLog('permission.denied', {
      userId: actor.userId, organizationId: actor.organizationId,
      reason: 'invite_role_above_authority', attemptedRole: args.role, actorRole: actor.role,
    });
    throw forbidden(`You are not permitted to invite a member with the '${args.role}' role.`);
  }

  // Already a member here?
  const existingMember = await db.query(
    `SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND u.email_normalized = $2`, [actor.organizationId, email]);
  if (existingMember.rows.length > 0) throw conflict('That person is already a member of this organization.');

  // Supersede any outstanding invitation for the same address.
  await db.query(
    `UPDATE invitations SET revoked_at = $1
      WHERE organization_id = $2 AND email_normalized = $3 AND accepted_at IS NULL`,
    [nowIso(), actor.organizationId, email]);

  const token = mintToken(TOKEN_TTL.inviteSec);
  const id = newId();
  await db.query(
    `INSERT INTO invitations (id, organization_id, email_normalized, role, team_id, token_hash, invited_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, actor.organizationId, email, args.role, args.teamId ?? null, token.tokenHash, actor.userId, token.expiresAt]);

  await writeAudit(db, {
    organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
    action: 'member.invited', entityType: 'invitation', entityId: id, after: { email, role: args.role },
  });
  securityLog('member.invited', { userId: actor.userId, organizationId: actor.organizationId, invitedEmail: email, role: args.role });

  const orgName = (await db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [actor.organizationId]))
    .rows[0]?.name ?? 'an organization';
  await args.deliver({
    email, token: token.token, organizationName: orgName, inviterName: actor.email, role: args.role,
  });
  return { invitationId: id, expiresAt: token.expiresAt, email, role: args.role };
}

export type AcceptInviteResult =
  | { kind: 'needs_account'; token: string; email: string; organizationName: string }
  | { kind: 'joined'; userId: string; organizationId: string; role: Role; requiresLogin: boolean };

/**
 * Preview an invitation. Returns only non-sensitive facts. A caller learns the
 * organization name and whether an account already exists, which is required to
 * render the right form.
 */
export async function previewInvite(rawToken: string): Promise<{ organizationId: string; organizationName: string; email: string; role: Role; accountExists: boolean }> {
  const db = await initDriver();
  const row = await lookupInvite(db, rawToken);
  const org = await db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [row.organization_id]);
  const acct = await db.query('SELECT 1 FROM users WHERE email_normalized = $1 AND deleted_at IS NULL', [row.email_normalized]);
  return {
    organizationId: row.organization_id,
    organizationName: org.rows[0]?.name ?? 'this organization',
    email: row.email_normalized,
    role: row.role,
    accountExists: acct.rows.length > 0,
  };
}

type InviteRow = {
  id: string; organization_id: string; email_normalized: string; role: Role;
  token_hash: string; expires_at: string; accepted_at: string | null; revoked_at: string | null;
};

async function lookupInvite(db: DbClient, rawToken: string): Promise<InviteRow> {
  const r = await db.query<InviteRow>(
    `SELECT id, organization_id, email_normalized, role, token_hash, expires_at, accepted_at, revoked_at
       FROM invitations WHERE token_hash = $1`, [hashToken(rawToken)]);
  const row = r.rows[0];
  if (!row) throw badRequest('This invitation link is not valid.');
  if (row.accepted_at) throw badRequest('This invitation has already been used.');
  if (row.revoked_at) throw badRequest('This invitation has been revoked.');
  if (isExpired(row.expires_at)) throw badRequest('This invitation has expired. Ask for a new one.');
  return row;
}

export async function acceptInvite(args: {
  token: string; name?: string; password?: string;
  /** Set when the acceptor already has a session. Required to add an EXISTING user. */
  authenticatedUserId?: string | null;
  client: { ip: string; userAgent: string; requestId?: string };
}): Promise<AcceptInviteResult> {
  const db = await initDriver();
  const row = await lookupInvite(db, args.token);

  const existing = await db.query<{ id: string; email: string; name: string }>(
    'SELECT id, email, name FROM users WHERE email_normalized = $1 AND deleted_at IS NULL',
    [row.email_normalized]);

  // RULE 29: an existing account may only be joined by proving identity. Either
  // they are signed in, or they re-confirm their password. Possession of the
  // invitation token is NOT sufficient — that was the legacy takeover vector.
  if (existing.rows[0]) {
    const selfId = existing.rows[0].id;
    let proven = false;
    if (args.authenticatedUserId && args.authenticatedUserId === selfId) {
      proven = true;
    } else if (args.password) {
      const full = await db.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1', [selfId]);
      const { verifyPassword } = await import('../lib/password.ts');
      proven = await verifyPassword(args.password ?? '', full.rows[0]?.password_hash ?? null);
      if (!proven) {
        securityLog('member.invite_accepted', { outcome: 'failure', reason: 'password_mismatch', email: row.email_normalized });
        // Deliberately identical to "unknown account" elsewhere.
        throw badRequest('We could not verify your account. Sign in first, or enter your current password.');
      }
    } else {
      securityLog('member.invite_accepted', { outcome: 'failure', reason: 'identity_not_proven', email: row.email_normalized });
      throw badRequest('You already have an account with this address. Sign in to accept this invitation, or confirm your password.');
    }

    // Single-use: burn the token inside the same transaction as the membership.
    await db.transaction(async (tx) => {
      const claimed = await tx.query(
        'UPDATE invitations SET accepted_at = $1 WHERE id = $2 AND accepted_at IS NULL RETURNING id',
        [nowIso(), row.id]);
      if (claimed.rowCount === 0) throw badRequest('This invitation has already been used.');
      const already = await tx.query(
        'SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2',
        [row.organization_id, selfId]);
      if (already.rows.length === 0) {
        await tx.query(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status, joined_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`,
          [newId(), row.organization_id, selfId, row.role, nowIso()]);
      }
      await tx.query(
        `INSERT INTO audit_logs (id, organization_id, actor_id, actor_role, action, entity_type, entity_id, ip, user_agent)
         VALUES ($1,$2,$3,$4,'member.invite_accepted','user',$3,$5,$6)`,
        [newId(), row.organization_id, selfId, row.role, args.client.ip, args.client.userAgent.slice(0, 300)]);
    });
    securityLog('member.invite_accepted', {
      userId: selfId, organizationId: row.organization_id, role: row.role, method: 'existing_account',
    });
    // Existing accounts must sign in again: we do not mint a session here.
    return { kind: 'joined', userId: selfId, organizationId: row.organization_id, role: row.role, requiresLogin: true };
  }

  // No account yet: create one and join, atomically.
  const name = String(args.name ?? '').trim();
  const password = String(args.password ?? '');
  if (name.length < 1 || name.length > 120) throw validationFailed({ name: 'Enter your name.' });
  const issues = checkPasswordStrength(password, { email: row.email_normalized, name });
  if (issues.length) throw validationFailed({ password: issues.map((i) => i.message).join(' ') });

  const userId = newId();
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const claimed = await tx.query(
      'UPDATE invitations SET accepted_at = $1 WHERE id = $2 AND accepted_at IS NULL RETURNING id',
      [nowIso(), row.id]);
    if (claimed.rowCount === 0) throw badRequest('This invitation has already been used.');
    await tx.query(
      `INSERT INTO users (id, email, email_normalized, name, password_hash, created_at, updated_at, password_changed_at)
       VALUES ($1,$2,$2,$3,$4,$5,$5,$5)`,
      [userId, row.email_normalized, name, hash, nowIso()]);
    await tx.query(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status, joined_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`,
      [newId(), row.organization_id, userId, row.role, nowIso()]);
    await tx.query(
      `INSERT INTO audit_logs (id, organization_id, actor_id, actor_role, action, entity_type, entity_id, ip, user_agent)
       VALUES ($1,$2,$3,$4,'member.invite_accepted','user',$3,$5,$6)`,
      [newId(), row.organization_id, userId, row.role, args.client.ip, args.client.userAgent.slice(0, 300)]);
  });
  securityLog('member.invite_accepted', {
    userId, organizationId: row.organization_id, role: row.role, method: 'new_account',
  });
  return { kind: 'joined', userId, organizationId: row.organization_id, role: row.role, requiresLogin: true };
}

export async function revokeInvitation(actor: ActorRef, invitationId: string): Promise<boolean> {
  const db = await initDriver();
  const r = await db.query(
    `UPDATE invitations SET revoked_at = $1
      WHERE id = $2 AND organization_id = $3 AND accepted_at IS NULL`,
    [nowIso(), invitationId, actor.organizationId]);
  if (r.rowCount === 0) throw notFound('No pending invitation with that id.');
  securityLog('member.invited', { userId: actor.userId, organizationId: actor.organizationId, action: 'revoke_invite', invitationId });
  return true;
}

export type InvitationRow = {
  id: string; email_normalized: string; role: Role; expires_at: string;
  created_at: string; accepted_at: string | null; revoked_at: string | null;
};

export async function listInvitations(actor: ActorRef): Promise<InvitationRow[]> {
  const db = await initDriver();
  const r = await db.query<InvitationRow>(
    `SELECT id, email_normalized, role, expires_at, created_at, accepted_at, revoked_at
       FROM invitations WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [actor.organizationId]);
  return r.rows;
}

// ── teams ────────────────────────────────────────────────────────────────────
export async function listTeams(actor: ActorRef): Promise<{
  id: string; name: string; description: string | null; memberCount: number;
}[]> {
  const db = await initDriver();
  const r = await db.query<{ id: string; name: string; description: string | null; member_count: number }>(
    `SELECT t.id, t.name, t.description, count(tm.user_id)::int AS member_count
       FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id
      WHERE t.organization_id = $1 AND t.deleted_at IS NULL
      GROUP BY t.id, t.name, t.description ORDER BY t.name`, [actor.organizationId]);
  return r.rows.map((x) => ({ id: x.id, name: x.name, description: x.description, memberCount: x.member_count }));
}

export async function createTeam(actor: ActorRef, name: string, description?: string): Promise<{ id: string; name: string }> {
  const db = await initDriver();
  const clean = String(name ?? '').trim();
  if (clean.length < 1 || clean.length > 120) throw validationFailed({ name: 'Team name must be 1-120 characters.' });
  const id = newId();
  try {
    await db.query(
      'INSERT INTO teams (id, organization_id, name, description, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)',
      [id, actor.organizationId, clean, description ? String(description).slice(0, 500) : null, nowIso()]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('A team with that name already exists.');
    throw err;
  }
  await writeAudit(db, {
    organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
    action: 'team.created', entityType: 'team', entityId: id, after: { name: clean },
  });
  return { id, name: clean };
}

// ── shared audit writer (RULE 80, 81) ────────────────────────────────────────
/**
 * Writes an audit row. `actorId`, `organizationId`, timestamps and IP are all
 * server-derived — a client can never supply them (RULE 2, RULE 80).
 * before/after pass through `auditDiff`, which strips secrets and PII and keeps
 * only an allowlist of business fields, so audit rows cannot become a second,
 * unbounded copy of the CRM's personal data (legacy defect B15).
 */
export async function writeAudit(db: DbClient, args: {
  organizationId: string; actorId: string | null; actorRole: string | null;
  action: string; entityType: string; entityId: string | null;
  before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
  outcome?: 'success' | 'failure' | 'denied';
  ip?: string | null; userAgent?: string | null; requestId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { auditDiff } = await import('../lib/redact.ts');
  const before = auditDiff(args.before);
  const after = auditDiff(args.after);
  const changed = before && after
    ? [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    : [];
  try {
    await db.query(
      `INSERT INTO audit_logs (id, organization_id, actor_id, actor_role, action, entity_type, entity_id,
                               outcome, before_json, after_json, changed_fields, ip, user_agent, request_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [newId(), args.organizationId, args.actorId, args.actorRole, args.action, args.entityType,
        args.entityId, args.outcome ?? 'success',
        before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
        changed.length ? changed : null,
        // `inet` columns reject anything that is not a valid address. A bad
        // value must become NULL, not a constraint error that discards the
        // transaction this audit row is supposed to describe.
        persistableIp(args.ip), args.userAgent ? args.userAgent.slice(0, 300) : null, args.requestId ?? null,
        JSON.stringify(args.metadata ?? {})]);
  } catch (err) {
    // An audit failure must not be silent, but it must also not mask the
    // business operation's own error.
    logger.error({ err, action: args.action, organizationId: args.organizationId }, 'audit write failed');
  }
}

/** Convenience wrapper used by record services. */
export const auditFor = (actor: ActorRef, request: Request) => ({
  ip: request.clientIp ?? null,
  userAgent: String(request.get('user-agent') ?? '').slice(0, 300),
  requestId: request.requestId ?? null,
});

type Request = { clientIp?: string; get(name: string): string | undefined; requestId?: string };

export { assignableRoles, can, isRole, canAssignRole };
export type { Role };
export const _internal = { TenantScope, env };