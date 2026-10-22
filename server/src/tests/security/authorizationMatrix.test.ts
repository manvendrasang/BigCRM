/**
 * Route x role authorisation matrix.
 *
 * `rbac.ts` is the single source of truth for who may do what, and
 * `requirePermission(...)` is the only place a route declares which permission
 * it needs. The failure this suite exists for is a *mismatch* between the two:
 * a route gated on `contacts.update` when it writes tasks, a missing gate, or a
 * gate on a permission nobody holds (so the route is dead for everybody).
 *
 * Expectations are therefore derived from `ROLE_PERMISSIONS` rather than copied
 * into a second table -- a hardcoded copy would rot silently the day the matrix
 * changes, and it is the matrix, not the copy, that the product decided. The
 * second half of the file pins the decisions that matter in words, so the
 * derivation cannot hide a grossly wrong permission (an admin who can assign
 * tasks would satisfy "the route enforces tasks.assign" while being wrong).
 *
 * Deliberately excluded:
 * - `GET/POST/DELETE /views`: saved views carry no permission gate by design.
 *   Ownership and sharing are enforced in `savedViews.ts` (a member may keep
 *   personal views; only admin+ may share or delete another's). The declared
 *   `saved_views.read` / `saved_views.manage` permissions are currently unused
 *   by any route -- a known documentation mismatch, not a gate to assert here.
 * - `POST /attachments` and `POST /transfers/imports`: they write bytes/rows.
 *   Their gates are identical in shape to the other `requirePermission` calls,
 *   and the upload path is covered by the cross-tenant suite.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { createApp } from '../../app.ts';
import type { AddressInfo } from 'node:net';
import type { ActorRef } from '../../services/records.ts';
import { createRecord } from '../../services/records.ts';
import { registerUser, loginUser } from '../../services/auth.ts';
import { createMember } from '../../services/org.ts';
import { scheduleMeeting } from '../../services/calendar.ts';
import { ROLE_PERMISSIONS, type Role } from '../../services/rbac.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 120)}`;
  if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l}${detail}`); }
};

const C = { ip: '10.0.0.51', userAgent: 'authz-matrix-test/1.0', requestId: 'req-mx' };
const PASSWORD = 'Wander-Pasture-1842!';

//  boot 
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

const api = (path: string, token: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${BASE}/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

const tokenFor = async (email: string, password: string): Promise<string> => {
  const r = await loginUser({ email, password, client: C });
  if (r.kind !== 'ok') throw new Error(`login refused for ${email}: ${r.kind}`);
  return r.accessToken;
};

const ROLES: readonly Role[] = ['viewer', 'sales', 'manager', 'admin', 'owner'];
const can = (role: Role, permission: string): boolean => ROLE_PERMISSIONS[role].has(permission);

//  one workspace, one member per role 
const org = await registerUser({
  name: 'Dana Whitfield', email: 'matrix-owner@corp.io', password: PASSWORD,
  organizationName: 'Matrix Ltd', client: C,
});
const owner: ActorRef = {
  userId: org.user.id, organizationId: org.organizationId, role: 'owner', email: org.user.email,
};
const tokens: Record<Role, string> = { owner: await tokenFor('matrix-owner@corp.io', PASSWORD) } as Record<Role, string>;
for (const role of ['viewer', 'sales', 'manager', 'admin'] as const) {
  const created = await createMember(owner, {
    email: `matrix-${role}@corp.io`, role, name: `Matrix ${role}`,
  });
  tokens[role] = await tokenFor(`matrix-${role}@corp.io`, created.generatedPassword);
}

const fixtureContact = await createRecord(owner, 'contacts', {
  first_name: 'Matrix', last_name: 'Fixture', email: 'matrix-fixture@corp.io',
});
const fixtureContactId = String(fixtureContact.record.id);

let seq = 0;
const next = (): number => { seq += 1; return seq; };

//  the matrix 
type Case = {
  label: string;
  perms: readonly string[];
  run: (token: string) => Promise<Response>;
};

const cases: Case[] = [
  {
    label: 'GET /contacts',
    perms: ['contacts.read'],
    run: (t) => api('/contacts', t),
  },
  {
    label: 'POST /contacts',
    perms: ['contacts.create'],
    run: (t) => api('/contacts', t, {
      method: 'POST',
      body: JSON.stringify({ first_name: 'Created', last_name: `By${next()}`, email: `created-${seq}@corp.io` }),
    }),
  },
  {
    label: 'PATCH /contacts/:id',
    perms: ['contacts.update'],
    run: (t) => api(`/contacts/${fixtureContactId}`, t, {
      method: 'PATCH', body: JSON.stringify({ first_name: 'Renamed' }),
    }),
  },
  {
    label: 'DELETE /contacts/:id',
    perms: ['contacts.delete'],
    // A fresh row per attempt: a successful delete must not turn the next
    // attempt into a 404, which would pass for the wrong reason.
    run: async (t) => {
      const n = next();
      const made = await createRecord(owner, 'contacts', {
        first_name: 'Doomed', last_name: `Row${n}`, email: `doomed-${n}@corp.io`,
      });
      return api(`/contacts/${String(made.record.id)}`, t, { method: 'DELETE' });
    },
  },
  {
    label: 'GET /tasks/assignees',
    perms: ['tasks.assign'],
    run: (t) => api('/tasks/assignees', t),
  },
  {
    label: 'GET /reports/overview',
    perms: ['reports.read'],
    run: (t) => api('/reports/overview', t),
  },
  {
    label: 'GET /custom-fields/contact',
    perms: ['custom_fields.read'],
    run: (t) => api('/custom-fields/contact', t),
  },
  {
    label: 'POST /custom-fields',
    perms: ['custom_fields.manage'],
    run: (t) => api('/custom-fields', t, {
      method: 'POST',
      body: JSON.stringify({
        entityType: 'contact', key: `matrix_field_${next()}`, label: 'Matrix', fieldType: 'text',
      }),
    }),
  },
  {
    label: 'GET /org',
    perms: ['organization.read'],
    run: (t) => api('/org', t),
  },
  {
    label: 'GET /org/members',
    perms: ['users.read'],
    run: (t) => api('/org/members', t),
  },
  {
    label: 'POST /org/members',
    perms: ['users.create'],
    run: (t) => api('/org/members', t, {
      method: 'POST',
      body: JSON.stringify({ email: `matrix-hire-${next()}@corp.io`, role: 'sales', name: 'Matrix Hire' }),
    }),
  },
  {
    label: 'GET /org/audit-logs',
    perms: ['audit.read'],
    run: (t) => api('/org/audit-logs', t),
  },
  {
    label: 'GET /calendar',
    perms: ['activities.read', 'tasks.read'],
    run: (t) => api('/calendar', t),
  },
  {
    label: 'POST /calendar/meetings',
    perms: ['activities.create'],
    run: (t) => api('/calendar/meetings', t, {
      method: 'POST',
      body: JSON.stringify({
        entityType: 'contact', entityId: fixtureContactId,
        occurredAt: '2027-04-01T10:00:00.000Z', subject: `Matrix meeting ${next()}`,
      }),
    }),
  },
  {
    label: 'PATCH /calendar/meetings/:id',
    perms: ['activities.update'],
    run: async (t) => {
      const made = await scheduleMeeting(owner, {
        entityType: 'contact', entityId: fixtureContactId,
        occurredAt: '2027-04-02T10:00:00.000Z', subject: `Editable ${next()}`,
      });
      return api(`/calendar/meetings/${made.id}`, t, {
        method: 'PATCH', body: JSON.stringify({ subject: 'Renamed by the matrix' }),
      });
    },
  },
  {
    label: 'DELETE /calendar/meetings/:id',
    perms: ['activities.delete'],
    run: async (t) => {
      const made = await scheduleMeeting(owner, {
        entityType: 'contact', entityId: fixtureContactId,
        occurredAt: '2027-04-03T10:00:00.000Z', subject: `Cancellable ${next()}`,
      });
      return api(`/calendar/meetings/${made.id}`, t, { method: 'DELETE' });
    },
  },
  {
    label: 'POST /transfers/exports',
    perms: ['exports.manage'],
    run: (t) => api('/transfers/exports', t, {
      method: 'POST', body: JSON.stringify({ entityType: 'contacts' }),
    }),
  },
  {
    label: 'GET /attachments/contact/:id',
    perms: ['attachments.read'],
    run: (t) => api(`/attachments/contact/${fixtureContactId}`, t),
  },
];

for (const c of cases) {
  console.log(`\n=== ${c.label} -- ${c.perms.join(' + ')} ===`);
  for (const role of ROLES) {
    const res = await c.run(tokens[role]);
    const allowed = c.perms.every((p) => can(role, p));
    if (allowed) {
      // Not 403/401/404 and not a server error: an allowed caller must reach
      // the handler. Exact success codes are pinned in the next section.
      T(`${role} is allowed`,
        res.status !== 401 && res.status !== 403 && res.status !== 404 && res.status < 500,
        res.status);
    } else {
      T(`${role} is refused with 403`, res.status === 403, res.status);
    }
  }
}

console.log('\n=== pinned product decisions ===');
{
  const status = async (path: string, token: string, init: RequestInit = {}): Promise<number> =>
    (await api(path, token, init)).status;

  // A viewer reads and answers their own task, but creates nothing.
  T('a viewer reads contacts', await status('/contacts', tokens.viewer) === 200);
  T('a viewer cannot create a contact',
    await status('/contacts', tokens.viewer, {
      method: 'POST', body: JSON.stringify({ first_name: 'Nope', last_name: 'Viewer', email: 'nope@corp.io' }),
    }) === 403);

  // Assignment is not rank: an admin outranks a manager and still may not
  // assign work. `tasks.assign` is owner + manager only.
  T('an admin cannot list task assignees', await status('/tasks/assignees', tokens.admin) === 403);
  T('a manager can list task assignees', await status('/tasks/assignees', tokens.manager) === 200);

  // Security telemetry is not for managers, even though they manage people.
  T('a sales member cannot read the audit log', await status('/org/audit-logs', tokens.sales) === 403);
  T('a manager cannot read the audit log', await status('/org/audit-logs', tokens.manager) === 403);
  T('an admin can read the audit log', await status('/org/audit-logs', tokens.admin) === 200);

  // Meetings: sales schedules, managers amend, admins cancel.
  const salesMeeting = await api('/calendar/meetings', tokens.sales, {
    method: 'POST',
    body: JSON.stringify({
      entityType: 'contact', entityId: fixtureContactId,
      occurredAt: '2027-05-01T10:00:00.000Z', subject: 'Sales booked',
    }),
  });
  const salesMeetingBody = await salesMeeting.json() as any;
  T('a sales member can schedule a meeting', salesMeeting.status === 201, salesMeeting.status);
  const salesMeetingId = String(salesMeetingBody.data?.id ?? '');

  T('a sales member cannot edit a meeting',
    await status(`/calendar/meetings/${salesMeetingId}`, tokens.sales, {
      method: 'PATCH', body: JSON.stringify({ subject: 'Sales edit' }),
    }) === 403);
  T('a viewer cannot schedule a meeting',
    await status('/calendar/meetings', tokens.viewer, {
      method: 'POST',
      body: JSON.stringify({
        entityType: 'contact', entityId: fixtureContactId,
        occurredAt: '2027-05-02T10:00:00.000Z', subject: 'Viewer booked',
      }),
    }) === 403);

  const managerMeeting = await scheduleMeeting(owner, {
    entityType: 'contact', entityId: fixtureContactId,
    occurredAt: '2027-05-03T10:00:00.000Z', subject: 'Manager editable',
  });
  T('a manager can edit a meeting',
    await status(`/calendar/meetings/${managerMeeting.id}`, tokens.manager, {
      method: 'PATCH', body: JSON.stringify({ subject: 'Fixed by a manager' }),
    }) === 200);
  T('a manager cannot delete a meeting',
    await status(`/calendar/meetings/${managerMeeting.id}`, tokens.manager, { method: 'DELETE' }) === 403);

  const doomed = await scheduleMeeting(owner, {
    entityType: 'contact', entityId: fixtureContactId,
    occurredAt: '2027-05-04T10:00:00.000Z', subject: 'Admin cancellable',
  });
  T('an admin can delete a meeting',
    await status(`/calendar/meetings/${doomed.id}`, tokens.admin, { method: 'DELETE' }) === 204);

  // And the deleted meeting is gone for everybody -- including the owner.
  T('a deleted meeting 404s on the shared event window',
    await status(`/calendar/events/meeting/${doomed.id}`, tokens.owner) === 404);
}

await new Promise<void>((resolve) => server.close(() => resolve()));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('FAILURES:');
  for (const f of fails) console.log(` - ${f}`);
  process.exit(1);
}
