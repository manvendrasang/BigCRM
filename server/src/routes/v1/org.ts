/**
 * `/api/v1/org` -- organization, members, invitations, teams.
 *
 * Every handler is tenant-bound through the actor's `organizationId`, which is
 * resolved from the session token on the server. No handler reads an
 * organization id from the request, so a client cannot name the tenant it wants.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, actorRef, intParam, strParam } from './helpers.ts';
import { authenticate, requirePermission, requireRole, csrfGuard, sensitiveActionWindow } from '../../middleware/security.ts';
import {
 getOrganization, updateOrganization, listMembers, changeMemberRole, removeMember,
 createMember,
 inviteMember, acceptInvite, previewInvite, revokeInvitation, listInvitations,
 listTeams, createTeam, transferOwnership, assignableRoles,
 requestPasswordReset, resetMemberPassword,
} from '../../services/org.ts';
import { sendInvitationEmail } from '../../integrations/email.ts';
import { validationFailed } from '../../lib/errors.ts';
import { ROLES } from '../../services/rbac.ts';
import { listAuditLogs } from '../../services/activity.ts';

export const orgRouter = Router();
orgRouter.use(authenticate);

const clientInfo = (req: { clientIp: string; get(n: string): string | undefined; requestId: string }) => ({
 ip: req.clientIp,
 userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
 requestId: req.requestId,
});

function fieldErrors(err: z.ZodError): Record<string, string> {
 const out: Record<string, string> = {};
 for (const issue of err.issues) {
 const key = issue.path.join('.') || '_';
 if (!(key in out)) out[key] = issue.message;
 }
 return out;
}

//  organization 

const orgPatch = z.object({
 name: z.string().trim().min(1).max(160).optional(),
 currency: z.string().trim().length(3).optional(),
 timezone: z.string().trim().min(1).max(64).optional(),
 locale: z.string().trim().min(2).max(16).optional(),
}).strict();

orgRouter.get('/', requirePermission('organization.read'), asyncRoute(async (req, res) => {
 res.json({ data: await getOrganization(actorRef(req)) });
}));

/**
 * The audit log lives here rather than in its own router mounted at `/`.
 *
 * A router mounted at the root is traversed by every request in the
 * application, so an `authenticate` on it -- at router level or per route --
 * costs a second full authentication on every record list. That is BIG-35.
 * Moving the route onto `orgRouter` gives it exactly one authentication, like
 * every other `/org` route, and leaves the root free of side effects.
 */
orgRouter.get(
 '/audit-logs',
 requirePermission('audit.read'),
 asyncRoute(async (req, res) => {
 res.json({
 data: await listAuditLogs(actorRef(req), {
 limit: intParam(req, 'limit', 25, 100),
 offset: intParam(req, 'offset', 0, 1_000_000),
 action: strParam(req, 'action'),
 entityType: strParam(req, 'entityType'),
 outcome: strParam(req, 'outcome'),
 }),
 });
 }),
);

orgRouter.patch('/', csrfGuard, requirePermission('organization.update'), asyncRoute(async (req, res) => {
 const parsed = orgPatch.safeParse(req.body);
 if (!parsed.success) throw validationFailed(fieldErrors(parsed.error));
 // `.strict()` above means an unknown field is a 422 rather than a silent no-op.
 res.json({ data: await updateOrganization(actorRef(req), parsed.data) });
}));

orgRouter.get('/roles', requirePermission('organization.read'), asyncRoute(async (req, res) => {
 const actor = actorRef(req);
 res.json({
 data: {
 assignable: assignableRoles(actor.role),
 hierarchy: ROLES,
 note: 'Owner cannot be granted by invitation or by role change; use POST /org/members/transfer-ownership.',
 },
 });
}));

//  members 

orgRouter.get('/members', requirePermission('users.read'), asyncRoute(async (req, res) => {
 res.json({ data: await listMembers(actorRef(req)) });
}));

/**
 * In-house member creation. The caller supplies an email and a role; the
 * service generates a password and returns it ONCE. There is no self-service
 * registration on this deployment (accounts are created by the office, not
 * claimed from the internet), so this endpoint and the invitation flow are
 * the only ways in.
 *
 * Ownership is deliberately absent from the schema: it is never minted, only
 * moved by members.transfer_ownership. The service applies the same rank rule
 * again, so a manager cannot ask for a role they could not grant.
 */
const CREATABLE_ROLES = ['admin', 'manager', 'sales', 'viewer'] as const;

const createMemberSchema = z.object({
 email: z.string().trim().min(3).max(320).email(),
 role: z.enum(CREATABLE_ROLES),
 name: z.string().trim().min(1).max(120).optional(),
});

orgRouter.post('/members', csrfGuard, requirePermission('users.create'),
 sensitiveActionWindow, asyncRoute(async (req, res) => {
 const parsed = createMemberSchema.safeParse(req.body);
 if (!parsed.success) throw validationFailed(fieldErrors(parsed.error));
 const result = await createMember(actorRef(req), {
   email: parsed.data.email,
   role: parsed.data.role,
   name: parsed.data.name,
 });
 res.status(201).json({ data: result });
}));

const rolePatch = z.object({ role: z.enum(ROLES) });

orgRouter.patch('/members/:id/role', csrfGuard, requirePermission('users.update'),
 sensitiveActionWindow, asyncRoute(async (req, res) => {
 const parsed = rolePatch.safeParse(req.body);
 if (!parsed.success) throw validationFailed(fieldErrors(parsed.error));
 res.json({ data: await changeMemberRole(actorRef(req), String(req.params.id ?? ''), parsed.data.role) });
 }));

orgRouter.delete('/members/:id', csrfGuard, requirePermission('users.remove'),
 sensitiveActionWindow, asyncRoute(async (req, res) => {
 res.json({ data: await removeMember(actorRef(req), String(req.params.id ?? '')) });
 }));

//  password reset (member requests; owner/admin completes) 

/**
 * The member asks. No permission gate beyond being an authenticated member of
 * the organization: the request is the member acting on their own account, and
 * the service refuses an owner (an owner can only be reset by an owner). While
 * a request is open, repeating it is idempotent.
 */
orgRouter.post('/members/password-reset-request', csrfGuard, asyncRoute(async (req, res) => {
 res.status(201).json({ data: await requestPasswordReset(actorRef(req)) });
}));

const memberPasswordSchema = z.object({
 password: z.string().min(1).max(1024),
});

/**
 * The owner/admin completes it. The password is supplied by the caller (the
 * "repeat password" field is a client concern; the server validates one value
 * against the strength policy), never generated and echoed, and never written
 * to a log. Authority is `users.reset_password` PLUS the owner rule enforced in
 * the service: an admin cannot reset an owner.
 */
orgRouter.post('/members/:id/password', csrfGuard, requirePermission('users.reset_password'),
 sensitiveActionWindow, asyncRoute(async (req, res) => {
 const parsed = memberPasswordSchema.safeParse(req.body);
 if (!parsed.success) throw validationFailed(fieldErrors(parsed.error));
 res.json({ data: await resetMemberPassword(actorRef(req), String(req.params.id ?? ''), parsed.data.password) });
}));

//  invitations 

const inviteSchema = z.object({
 email: z.string().trim().min(3).max(320).email(),
 role: z.enum(ROLES),
 teamId: z.string().uuid().optional(),
});

orgRouter.get('/invitations', requirePermission('users.invite'), asyncRoute(async (req, res) => {
 res.json({ data: await listInvitations(actorRef(req)) });
}));

orgRouter.post('/invitations', csrfGuard, requirePermission('users.invite'),
 sensitiveActionWindow, asyncRoute(async (req, res) => {
 const parsed = inviteSchema.safeParse(req.body);
 if (!parsed.success) throw validationFailed(fieldErrors(parsed.error));
 const actor = actorRef(req);

 // The invitation token goes only to the mail sink. It is never in this
 // response body and never logged: a caller holding `users.invite` must not
 // also be able to mint a membership for an arbitrary address and read it
 // back. That combination was the legacy takeover vector.
 const result = await inviteMember(actor, {
 email: parsed.data.email,
 role: parsed.data.role,
 teamId: parsed.data.teamId ?? null,
 client: clientInfo(req),
 deliver: async ({ email, token, organizationName, inviterName, role }) => {
 await sendInvitationEmail({ email, token, organizationName, inviterName, role });
 },
 });
 res.status(201).json({ data: result });
 }));

orgRouter.delete('/invitations/:id', csrfGuard, requirePermission('users.invite'), asyncRoute(async (req, res) => {
 await revokeInvitation(actorRef(req), String(req.params.id ?? ''));
 res.status(204).end();
}));

// The preview and accept endpoints are NOT behind `authenticate`: the recipient
// has no account yet. The invitation token is the credential, it is single-use,
// it is stored hashed, and these two are rate-limited at the router level.
export const publicOrgRouter = Router();

publicOrgRouter.get('/invitations/preview', asyncRoute(async (req, res) => {
 const token = String(req.query.token ?? '');
 const preview = await previewInvite(token);
 // Deliberately does not disclose who issued it, or when -- only what the
 // recipient needs to render the right form.
 res.json({
 data: {
 organizationName: preview.organizationName,
 email: preview.email,
 role: preview.role,
 accountExists: preview.accountExists,
 },
 });
}));

const acceptSchema = z.object({
 token: z.string().min(10).max(400),
 name: z.string().trim().min(1).max(120).optional(),
 password: z.string().min(1).max(1024).optional(),
});

publicOrgRouter.post('/invitations/accept', asyncRoute(async (req, res) => {
 const parsed = acceptSchema.safeParse(req.body);
 if (!parsed.success) throw validationFailed(fieldErrors(parsed.error));

 // If the caller already has a session, that identity is offered as proof.
 // Otherwise `acceptInvite` requires the account password for an EXISTING user;
 // holding the token alone never suffices (RULE 29).
 const result = await acceptInvite({
 token: parsed.data.token,
 name: parsed.data.name,
 password: parsed.data.password,
 authenticatedUserId: null,
 client: clientInfo(req),
 });

 if (result.kind === 'needs_account') {
 res.status(200).json({ data: { status: 'needs_account', email: result.email, organizationName: result.organizationName } });
 return;
 }
 res.status(200).json({
 data: {
 status: 'joined',
 organizationId: result.organizationId,
 role: result.role,
 requiresLogin: result.requiresLogin,
 },
 });
}));

//  teams 

orgRouter.get('/teams', requirePermission('teams.read'), asyncRoute(async (req, res) => {
 res.json({ data: await listTeams(actorRef(req)) });
}));

const teamSchema = z.object({
 name: z.string().trim().min(1).max(120),
 description: z.string().trim().max(1000).optional(),
});

orgRouter.post('/teams', csrfGuard, requirePermission('teams.manage'), asyncRoute(async (req, res) => {
 const parsed = teamSchema.safeParse(req.body);
 if (!parsed.success) throw validationFailed(fieldErrors(parsed.error));
 res.status(201).json({ data: await createTeam(actorRef(req), parsed.data.name, parsed.data.description) });
}));

//  ownership transfer (owner-only, RULE 27) 

const transferSchema = z.object({
 userId: z.string().uuid(),
 currentPassword: z.string().min(1).max(1024),
});

orgRouter.post('/members/transfer-ownership', csrfGuard, requireRole('owner'),
 sensitiveActionWindow, asyncRoute(async (req, res) => {
 const parsed = transferSchema.safeParse(req.body);
 if (!parsed.success) throw validationFailed(fieldErrors(parsed.error));
 res.json({
 data: await transferOwnership({
 actor: actorRef(req),
 newOwnerId: parsed.data.userId,
 currentPassword: parsed.data.currentPassword,
 client: clientInfo(req),
 }),
 });
 }));

export { fieldErrors };
