/**
 * Saved views tests.
 *
 * Properties under test:
 * 1. Owner can create/delete their own views
 * 2. Shared views are visible org-wide; private views only to the owner
 * 3. Only admin/owner can create shared views
 * 4. Deleting another's view is forbidden unless admin
 * 5. Unknown entity types rejected
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import type { ActorRef } from '../../services/records.ts';
import { createSavedView, deleteSavedView, listSavedViews } from '../../services/savedViews.ts';
import { registerUser } from '../../services/auth.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 130)}`;
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l}${detail}`); }
};

const C = { ip: '10.0.0.9', userAgent: 'views-test/1.0', requestId: 'req-views' };
const mkUser = async (name: string, email: string, role: 'owner' | 'admin' | 'sales', orgId?: string) => {
 const r = await registerUser({
 name, email, password: 'Views-Test-Pass!42',
 organizationName: `${name} Ltd`, client: C,
 });
 // If orgId is provided, move the user into that org (for shared-view tests).
 if (orgId && orgId !== r.organizationId) {
 const { getDb } = await import('../../db/driver.ts');
 const db = await getDb();
 await db.query('DELETE FROM organization_members WHERE user_id = $1', [r.user.id]);
 await db.query(
 `INSERT INTO organization_members (id,organization_id,user_id,role,status,joined_at,created_at,updated_at)
 VALUES ($1,$2,$3,$4,'active',now(),now(),now())`,
 [r.user.id, orgId, r.user.id, role],
 );
 // The throwaway org registerUser() created is left in place: audit_logs
 // has an append-only trigger and organizations cascade into it, so it
 // cannot be deleted. It is orphaned and harmless in the test database.
 }
 const actor: ActorRef = {
 userId: r.user.id, organizationId: orgId ?? r.organizationId,
 role, email: r.user.email,
 };
 return actor;
};

const owner = await mkUser('Owner', 'views-owner@corp.io', 'owner');
const member = await mkUser('Member', 'views-member@corp.io', 'sales', owner.organizationId);
const other = await mkUser('Other', 'views-other@corp.io', 'sales', owner.organizationId);

console.log('\n=== create and list ===');
{
 const v = await createSavedView(owner, {
 name: 'Hot leads', entityType: 'leads',
 filters: { status: 'new' }, sort: { field: 'created_at', dir: 'desc' },
 columns: ['first_name', 'last_name'],
 });
 T('view created with id', typeof v.id === 'string' && v.id.length > 0);
 T('is private by default', v.isShared === false);

 const mine = await listSavedViews(owner, 'leads');
 T('owner sees their own view', mine.length === 1 && mine[0]!.id === v.id);

 const others = await listSavedViews(other, 'leads');
 T('another member does not see a private view', others.length === 0, others.length);

 let badType = false;
 try { await createSavedView(owner, { name: 'Bad', entityType: 'nope' }); }
 catch { badType = true; }
 T('unknown entity type rejected', badType);

 let badName = false;
 try { await createSavedView(owner, { name: '', entityType: 'leads' }); }
 catch { badName = true; }
 T('empty name rejected', badName);

 await deleteSavedView(owner, v.id);
 const after = await listSavedViews(owner, 'leads');
 T('deleted view leaves the list', after.length === 0);
}

console.log('\n=== shared visibility and admin rules ===');
{
 const shared = await createSavedView(owner, {
 name: 'Team pipeline', entityType: 'deals', isShared: true,
 });
 T('owner can create a shared view', shared.isShared === true);

 const memberSees = await listSavedViews(member, 'deals');
 T('shared view visible to another member of the same org', memberSees.length === 1 && memberSees[0]!.id === shared.id);

 let memberShared = false;
 try {
 await createSavedView(member, { name: 'Sneaky', entityType: 'deals', isShared: true });
 } catch { memberShared = true; }
 T('non-admin (sales) cannot create a shared view', memberShared);

 let memberDelete = false;
 try { await deleteSavedView(member, shared.id); }
 catch { memberDelete = true; }
 T('non-admin cannot delete the owner\'s shared view', memberDelete);

 let ownerDelete = false;
 try { await deleteSavedView(other, shared.id); }
 catch { ownerDelete = true; }
 T('a second non-admin also cannot delete it', ownerDelete);

 await deleteSavedView(owner, shared.id);
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
