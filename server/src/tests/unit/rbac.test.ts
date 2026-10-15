import { migrate } from '../../db/migrate.ts';
await migrate();
import { assertOwnerOnlyInvariant, canAssignRole, can, ROLES, ROLE_PERMISSIONS, wouldOrphanOwners, assignableRoles } from '../../services/rbac.ts';
let _p=0; const _f:string[]=[];
const T=(l:string,c:boolean)=>{ if(c){_p++;console.log(`  [PASS] ${l}`);} else {_f.push(l);console.log(`  [FAIL] ${l}`);} };
try { assertOwnerOnlyInvariant(); console.log('  [PASS] owner-only invariant holds'); } catch(e:any){ console.log('  [FAIL]', e.message); }
const perms=(r:string)=>ROLE_PERMISSIONS[r as 'admin'].size;
console.log('  matrix sizes:', Object.fromEntries(ROLES.map(r=>[r,perms(r)])));
T('owner !== admin (legacy bug B29 fixed)', perms('owner') > perms('admin'));
T('owner can delete org', can('owner','organization.delete'));
T('admin CANNOT delete org', !can('admin','organization.delete'));
T('admin CANNOT transfer ownership', !can('admin','members.transfer_ownership'));
console.log('\n-- RULE 27 privilege escalation --');
T('viewer cannot assign anything', assignableRoles('viewer').length===0);
T('sales cannot assign anything', assignableRoles('sales').length===0);
T('viewer holds no users.invite -> no assignable roles', assignableRoles('viewer').length===0);
T('manager has no users.invite -> nothing assignable', assignableRoles('manager').length===0);
// Isolate the rank logic from the permission gate: canAssignRole is what decides order.
T('manager rank-wise could assign viewer+sales',
  ['viewer','sales'].every(r=>canAssignRole('manager',null,r as 'viewer'))
  && !canAssignRole('manager',null,'manager') && !canAssignRole('manager',null,'admin') && !canAssignRole('manager',null,'owner'));
T('admin may NOT assign owner', !assignableRoles('admin').includes('owner'));
T('admin may NOT assign admin (peer)', !assignableRoles('admin').includes('admin'));
T('owner may NOT assign owner (no peer)', !assignableRoles('owner').includes('owner'));
T('legacy bug B5: admin self-promote to owner DENIED', !canAssignRole('admin','admin','owner'));
T('legacy bug B5: admin demote the owner DENIED', !canAssignRole('admin','owner','viewer'));
T('owner can demote another owner to admin', canAssignRole('owner','owner','admin'));
T('owner CANNOT demote themselves', !canAssignRole('owner','owner','owner'));
T('manager cannot promote to admin', !canAssignRole('manager','sales','admin'));
T('admin can promote viewer->sales', canAssignRole('admin','viewer','sales'));
console.log('\n-- RULE 28 last owner --');
T('demote last owner blocked', wouldOrphanOwners({currentOwners:1,targetCurrentRole:'owner',action:'demote'})!==null);
T('demote 2nd owner allowed', wouldOrphanOwners({currentOwners:2,targetCurrentRole:'owner',action:'demote'})===null);
T('remove last owner blocked', wouldOrphanOwners({currentOwners:1,targetCurrentRole:'owner',action:'remove'})!==null);
T('demote non-owner never blocked', wouldOrphanOwners({currentOwners:1,targetCurrentRole:'viewer',action:'demote'})===null);
console.log('\n-- legacy phantom permissions (B38) --');
// Legacy B38 declared leads/deals/pipelines permissions for entities that did not
// exist. BigCRM implements those entities, so the permissions are legitimate; the
// route-coverage test asserts every declared permission maps to a real route.
T('viewer can read the now-real entities', ['leads.read','deals.read','pipelines.read'].every(p=>can('viewer',p)));
T('viewer still cannot write them', ['leads.create','deals.update','pipelines.delete'].every(p=>!can('viewer',p)));
T('contacts.archive exists', can('admin','contacts.archive'));
T('audit.read is owner+admin only', can('owner','audit.read')&&can('admin','audit.read')&&!can('manager','audit.read'));
console.log(`\n================ ${_p} passed, ${_f.length} failed ================`);
if (_f.length) console.log('FAILURES:\n - ' + _f.join('\n - '));
process.exit(_f.length ? 1 : 0);
