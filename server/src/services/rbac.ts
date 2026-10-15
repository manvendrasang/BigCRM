/**
 * RBAC with an explicit role hierarchy (RULE 26, 27, 28).
 *
 * Three properties the legacy implementations got wrong are enforced here:
 *
 * 1. owner ≠ admin. In the legacy CRM their permission sets were byte-identical,
 * which made "last owner" protection guard a distinction that did not exist.
 * Here owner holds `organization.delete` and `members.transfer_ownership`,
 * which admin does not.
 *
 * 2. Rank is data, not inference. `ROLE_RANK` makes "can A act on B" a single
 * comparison. The legacy `change_role` had no ordering check at all, so an
 * admin could promote itself to owner and demote the owner.
 *
 * 3. Self-escalation is denied outright, and a target can never be moved above
 * or below the actor's reachable band.
 *
 * Permissions are namespaced `resource.verb` and checked server-side on every
 * route. Client-supplied roles are ignored entirely.
 */

export const ROLES = ['owner', 'admin', 'manager', 'sales', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Higher rank == more authority. This is the single source of ordering truth. */
export const ROLE_RANK: Record<Role, number> = {
 viewer: 10,
 sales: 20,
 manager: 30,
 admin: 40,
 owner: 50,
};

export const isRole = (v: unknown): v is Role =>
 typeof v === 'string' && (ROLES as readonly string[]).includes(v);

/**
 * Permissions held by `owner` and by nobody else. Admin may *read* security
 * posture (active sessions, MFA state) but may not change it, destroy the
 * organization, or transfer ownership.
 */
const OWNER_EXCLUSIVE = new Set([
 'organization.delete',
 'members.transfer_ownership',
 'security.manage',
 'retention.manage',
]);

const P = {
 orgRead: 'organization.read',
 orgUpdate: 'organization.update',
 orgDelete: 'organization.delete',
 usersRead: 'users.read',
 usersInvite: 'users.invite',
 usersUpdate: 'users.update',
 usersRemove: 'users.remove',
 transfer: 'members.transfer_ownership',
 teamsRead: 'teams.read',
 teamsManage: 'teams.manage',
 reportsRead: 'reports.read',
 reportsExport: 'reports.export',
 settingsRead: 'settings.read',
 settingsUpdate: 'settings.update',
 auditRead: 'audit.read',
 securityRead: 'security.read',
 securityManage: 'security.manage',
 tokensManage: 'api_tokens.manage',
 retentionManage: 'retention.manage',
 customFieldsRead: 'custom_fields.read',
 customFieldsManage: 'custom_fields.manage',
 savedViewsRead: 'saved_views.read',
 savedViewsManage: 'saved_views.manage',
 importsManage: 'imports.manage',
 exportsManage: 'exports.manage',
} as const;

const crud = (resource: string, verbs: readonly string[] = ['read', 'create', 'update', 'delete']): string[] =>
 verbs.map((v) => `${resource}.${v}`);
// NOTE: an earlier revision declared CONTACT_EXTRA / COMPANY_EXTRA / DEAL_EXTRA /
// LEAD_EXTRA here and never referenced them -- the matrix below spells each
// permission out explicitly instead. The permissions are genuinely granted
// (`contacts.merge`, `deals.won`, `leads.convert`, ... were verified held by
// manager/admin/owner), so this was dead code rather than a missing grant. It is
// removed because a declared-but-unused permission list is exactly the kind of
// artefact that later gets "wired up" a second time and silently disagrees with
// the matrix.

const READERS = [
 ...crud('contacts', ['read']), ...crud('companies', ['read']),
 ...crud('leads', ['read']), ...crud('deals', ['read']),
 ...crud('pipelines', ['read']), ...crud('pipeline_stages', ['read']),
 ...crud('tasks', ['read']), ...crud('notes', ['read']),
 ...crud('activities', ['read']), ...crud('tags', ['read']),
 ...crud('attachments', ['read']), ...crud('comments', ['read']),
 P.reportsRead, P.customFieldsRead, P.savedViewsRead,
];

/**
 * The authoritative matrix. `owner` and `admin` intentionally differ.
 */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<string>> = {
 viewer: new Set([...READERS]),

 sales: new Set([
 ...READERS,
 ...crud('contacts', ['create', 'update', 'assign', 'archive']),
 ...crud('companies', ['create', 'update']),
 ...crud('leads', ['create', 'update', 'assign', 'convert']),
 ...crud('deals', ['create', 'update', 'assign', 'advance']),
 ...crud('tasks', ['create', 'update', 'delete']),
 ...crud('notes', ['create', 'update']),
 ...crud('activities', ['create']),
 ...crud('comments', ['create']),
 ...crud('attachments', ['create']),
 ]),

 manager: new Set([
 ...READERS,
 ...crud('contacts', ['create', 'update', 'delete', 'assign', 'archive', 'restore', 'merge', 'bulk']),
 ...crud('companies', ['create', 'update', 'delete', 'assign', 'archive', 'merge', 'bulk']),
 ...crud('leads', ['create', 'update', 'delete', 'assign', 'convert', 'bulk']),
 ...crud('deals', ['create', 'update', 'delete', 'assign', 'advance', 'won', 'lost', 'bulk']),
 ...crud('pipelines', ['create', 'update']),
 ...crud('pipeline_stages', ['create', 'update', 'reorder']),
 ...crud('tasks', ['create', 'update', 'delete', 'bulk']),
 ...crud('notes', ['create', 'update', 'delete']),
 ...crud('activities', ['create', 'update']),
 ...crud('tags', ['create', 'update', 'delete']),
 ...crud('comments', ['create', 'update', 'delete']),
 ...crud('attachments', ['create', 'delete']),
 ...crud('custom_fields', ['create', 'update']),
 ...crud('saved_views', ['create', 'update', 'delete']),
 P.teamsRead,
 ]),

 admin: new Set([
 ...READERS,
 ...crud('contacts', ['create', 'update', 'delete', 'assign', 'archive', 'restore', 'merge', 'bulk']),
 ...crud('companies', ['create', 'update', 'delete', 'assign', 'archive', 'merge', 'bulk']),
 ...crud('leads', ['create', 'update', 'delete', 'assign', 'convert', 'bulk']),
 ...crud('deals', ['create', 'update', 'delete', 'assign', 'advance', 'won', 'lost', 'bulk']),
 ...crud('pipelines', ['create', 'update', 'delete']),
 ...crud('pipeline_stages', ['create', 'update', 'delete', 'reorder']),
 ...crud('tasks', ['create', 'update', 'delete', 'bulk']),
 ...crud('notes', ['create', 'update', 'delete']),
 ...crud('activities', ['create', 'update', 'delete']),
 ...crud('tags', ['create', 'update', 'delete']),
 ...crud('comments', ['create', 'update', 'delete']),
 ...crud('attachments', ['create', 'update', 'delete']),
 ...crud('custom_fields', ['create', 'update', 'delete']),
 ...crud('saved_views', ['create', 'update', 'delete']),
 ...crud('imports'), ...crud('exports'),
 P.orgRead, P.orgUpdate,
 P.usersRead, P.usersInvite, P.usersUpdate, P.usersRemove,
 P.teamsRead, P.teamsManage,
 P.reportsRead, P.reportsExport,
 P.settingsRead, P.settingsUpdate,
 P.auditRead,
 P.securityRead,
 P.customFieldsManage, P.savedViewsManage, P.importsManage, P.exportsManage,
 P.tokensManage,
 ]),

 owner: new Set([
 ...READERS,
 ...crud('contacts', ['create', 'update', 'delete', 'assign', 'archive', 'restore', 'merge', 'bulk']),
 ...crud('companies', ['create', 'update', 'delete', 'assign', 'archive', 'merge', 'bulk']),
 ...crud('leads', ['create', 'update', 'delete', 'assign', 'convert', 'bulk']),
 ...crud('deals', ['create', 'update', 'delete', 'assign', 'advance', 'won', 'lost', 'bulk']),
 ...crud('pipelines', ['create', 'update', 'delete']),
 ...crud('pipeline_stages', ['create', 'update', 'delete', 'reorder']),
 ...crud('tasks', ['create', 'update', 'delete', 'bulk']),
 ...crud('notes', ['create', 'update', 'delete']),
 ...crud('activities', ['create', 'update', 'delete']),
 ...crud('tags', ['create', 'update', 'delete']),
 ...crud('comments', ['create', 'update', 'delete']),
 ...crud('attachments', ['create', 'update', 'delete']),
 ...crud('custom_fields', ['create', 'update', 'delete']),
 ...crud('saved_views', ['create', 'update', 'delete']),
 ...crud('imports'), ...crud('exports'),
 P.orgRead, P.orgUpdate, P.orgDelete,
 P.usersRead, P.usersInvite, P.usersUpdate, P.usersRemove, P.transfer,
 P.teamsRead, P.teamsManage,
 P.reportsRead, P.reportsExport,
 P.settingsRead, P.settingsUpdate,
 P.auditRead,
 P.securityRead, P.securityManage,
 P.customFieldsManage, P.savedViewsManage, P.importsManage, P.exportsManage,
 P.tokensManage, P.retentionManage,
 ]),
};

/** Asserted by `assertOwnerOnlyInvariant` so the sets cannot silently drift together. */
export const OWNER_ONLY: readonly string[] = [...OWNER_EXCLUSIVE];

export const can = (role: Role, permission: string): boolean =>
 ROLE_PERMISSIONS[role].has(permission);

/**
 * Roles a given actor may offer in an invitation.
 *
 * Returns [] unless the actor also holds `users.invite`. Without that gate a
 * sales rep could rank-wise "assign" a viewer, which is wrong: they hold no
 * user-management authority at all. The permission is the authority; the rank
 * comparison only narrows within it.
 */
export const assignableRoles = (actorRole: Role): Role[] =>
 can(actorRole, 'users.invite') ? ROLES.filter((r) => canAssignRole(actorRole, null, r)) : [];

/**
 * Owner-only permissions must not leak to any other role. If this invariant ever
 * breaks, `OWNER_ONLY` becomes meaningless and the last-owner guard is theatre.
 */
export function assertOwnerOnlyInvariant(): void {
 for (const p of OWNER_ONLY) {
 for (const r of ROLES) {
 if (r === 'owner') continue;
 if (ROLE_PERMISSIONS[r].has(p)) {
 throw new Error(`RBAC invariant violated: ${p} must be owner-only but ${r} has it`);
 }
 }
 }
 // owner must be a strict superset of admin.
 for (const p of ROLE_PERMISSIONS.admin) {
 if (!ROLE_PERMISSIONS.owner.has(p)) {
 throw new Error(`RBAC invariant violated: owner is missing admin permission ${p}`);
 }
 }
}

/**
 * Can `actorRole` assign `targetRole` to a member?
 *
 * Rules:
 * * Cannot assign a role at or above your own rank (no self-promotion path).
 * * Cannot modify a member whose rank is at or above your own rank.
 * * owner is assignable only by owner.
 * * Nobody may assign `owner` except an owner.
 */
export function canAssignRole(actorRole: Role, targetCurrentRole: Role | null, nextRole: Role): boolean {
 if (!isRole(actorRole) || !isRole(nextRole)) return false;
 if (OWNER_EXCLUSIVE.has(nextRole) && actorRole !== 'owner') return false;

 const actorRank = ROLE_RANK[actorRole];
 const isTopRank = actorRole === 'owner';

 // Never mint a peer or a superior. `owner` cannot be granted by anyone, so the
 // role is held by the registering user and moved only via
 // `members.transfer_ownership`.
 if (ROLE_RANK[nextRole] >= actorRank) return false;

 if (targetCurrentRole !== null) {
 // Owners may manage other owners; otherwise a lone owner is permanently stuck.
 // Everyone below owner may not touch a peer or a superior.
 if (!isTopRank && ROLE_RANK[targetCurrentRole] >= actorRank) return false;
 // Only an owner may move somebody into the admin band.
 if (ROLE_RANK[nextRole] >= ROLE_RANK.admin && !isTopRank) return false;
 }
 return true;
}

/** Only an owner may delete/suspend/transfer. */
export const canRemoveMember = (actorRole: Role, targetCurrentRole: Role): boolean =>
 actorRole === 'owner' && ROLE_RANK[targetCurrentRole] < ROLE_RANK.owner;

/**
 * Last-owner protection (RULE 28). Returns a reason string when the change would
 * orphan the organization, otherwise null.
 */
export function wouldOrphanOwners(args: {
 currentOwners: number;
 targetCurrentRole: Role | null;
 action: 'demote' | 'remove' | 'delete_org';
}): string | null {
 if (args.action === 'delete_org') return null; // deleting the org is a different decision
 const targetIsOwner = args.targetCurrentRole === 'owner';
 if (targetIsOwner && args.currentOwners <= 1) {
 return 'An organization must always have at least one owner.';
 }
 return null;
}

/** Exposed for the settings UI so the matrix is visible rather than implicit. */
export const describeMatrix = (): Record<string, string[]> =>
 Object.fromEntries(ROLES.map((r) => [r, [...ROLE_PERMISSIONS[r]].sort()]));