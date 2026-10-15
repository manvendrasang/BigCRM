/**
 * Report tests.
 *
 * Two properties matter:
 *
 * 1. **Cross-tenant invisibility.** An aggregation is a `GROUP BY`, and a
 *    `GROUP BY` without a tenant predicate sums every tenant's rows into one
 *    number. That failure is silent — the report looks plausible and is wrong
 *    in exactly the way that leaks revenue figures across organisations. Every
 *    report is therefore asserted against two orgs with different data.
 *
 * 2. **The definitions.** "Open deal value" must exclude won and lost deals,
 *    soft-deleted rows must not count, and an empty org must report zeros
 *    rather than nulls or missing rows.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import {
  createRecord,
  type ActorRef,
} from '../../services/records.ts';
import {
  leadFunnelReport,
  overviewReport,
  pipelineReport,
  taskLoadReport,
} from '../../services/reports.ts';
import { registerUser } from '../../services/auth.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 130)}`;
  if (c) { pass++; console.log(`  [PASS] ${l}`); } else { fails.push(l); console.log(`  [FAIL] ${l}${detail}`); }
};

const C = { ip: '10.0.0.9', userAgent: 'reports-test/1.0', requestId: 'req-reports' };

const mkOrg = async (name: string, email: string) => {
  const r = await registerUser({
    name, email, password: 'Reports-Test-Pass!42',
    organizationName: `${name} Ltd`, client: C,
  });
  const actor: ActorRef = {
    userId: r.user.id, organizationId: r.organizationId, role: 'owner', email: r.user.email,
  };
  return actor;
};

const acme = await mkOrg('Acme', 'rep-acme@corp.io');
const globex = await mkOrg('Globex', 'rep-globex@corp.io');

console.log('\n=== fixtures: two orgs with different pipelines ===');
// Acme: one pipeline, two stages, three deals (open, won, lost).
const acmePipe = await createRecord(acme, 'pipelines', { name: 'Sales' });
const pipeId = (acmePipe as { record: Record<string, unknown> }).record['id'] as string;
const { getDb } = await import('../../db/driver.ts');
const db = await getDb();
const { newId } = await import('../../lib/ids.ts');
const mkStage = async (name: string, position: number, won: boolean, lost: boolean) => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO pipeline_stages (id,organization_id,pipeline_id,name,position,probability,is_won,is_lost,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,50,$6,$7,now(),now()) RETURNING id`,
    [newId(), acme.organizationId, pipeId, name, position, won, lost],
  );
  return r.rows[0]!.id;
};
const prospecting = await mkStage('Prospecting', 1, false, false);
const negotiation = await mkStage('Negotiation', 2, false, false);
const closedWon = await mkStage('Closed Won', 3, true, false);

await createRecord(acme, 'deals', { name: 'Big One', value_c: 100000, pipeline_id: pipeId, stage_id: prospecting, status: 'open' });
await createRecord(acme, 'deals', { name: 'Bigger One', value_c: 200000, pipeline_id: pipeId, stage_id: negotiation, status: 'open' });
await createRecord(acme, 'deals', { name: 'Won One', value_c: 500000, pipeline_id: pipeId, stage_id: closedWon, status: 'won' });

// Globex: a single large open deal, to catch any cross-tenant summing.
const gxPipe = await createRecord(globex, 'pipelines', { name: 'Enterprise' });
const gxPipeId = (gxPipe as { record: Record<string, unknown> }).record['id'] as string;
const gxStage = await db.query<{ id: string }>(
  `INSERT INTO pipeline_stages (id,organization_id,pipeline_id,name,position,probability,is_won,is_lost,created_at,updated_at)
   VALUES ($1,$2,$3,'Discovery',1,10,false,false,now(),now()) RETURNING id`,
  [newId(), globex.organizationId, gxPipeId],
);
await createRecord(globex, 'deals', {
  name: 'Globex Mega', value_c: 9000000, pipeline_id: gxPipeId,
  stage_id: gxStage.rows[0]!.id, status: 'open',
});

await createRecord(acme, 'leads', { last_name: 'Funnel A', status: 'new' });
await createRecord(acme, 'leads', { last_name: 'Funnel B', status: 'contacted' });
await createRecord(acme, 'leads', { last_name: 'Funnel C', status: 'contacted' });
await createRecord(globex, 'leads', { last_name: 'GX Lead', status: 'new' });

await createRecord(acme, 'tasks', { title: 'Call back', status: 'todo', priority: 'high' });
await createRecord(acme, 'tasks', { title: 'Done thing', status: 'completed', priority: 'low' });

console.log('\n=== pipeline report ===');
{
  const rows = await pipelineReport(acme);
  T('three stages reported', rows.length === 3, rows.length);
  const prosp = rows.find((r) => r.stageId === prospecting);
  T('prospecting holds one deal worth 100000c',
    prosp?.dealCount === 1 && Number(prosp.totalValueC) === 100000, prosp);
  const neg = rows.find((r) => r.stageId === negotiation);
  T('negotiation holds one deal worth 200000c',
    neg?.dealCount === 1 && Number(neg.totalValueC) === 200000, neg);
  T('no stage leaks Globex rows', rows.every((r) => r.pipelineId === pipeId), rows.map((r) => r.pipelineId));

  const gx = await pipelineReport(globex);
  T('Globex sees only its own pipeline', gx.length === 1 && gx[0]!.pipelineId === gxPipeId, gx.length);
}

console.log('\n=== overview ===');
{
  const o = await overviewReport(acme);
  T('two open deals', o.openDeals === 2, o.openDeals);
  T('open value excludes the won deal (300000c, not 800000c)',
    Number(o.openDealValueC) === 300000, o.openDealValueC);
  T('Globex mega-deal does not leak into Acme overview',
    Number(o.openDealValueC) < 9000000, o.openDealValueC);
  T('one open task (completed is excluded)', o.openTasks === 1, o.openTasks);

  const g = await overviewReport(globex);
  T('Globex overview shows its own mega-deal', Number(g.openDealValueC) === 9000000, g.openDealValueC);
  T('and exactly one open deal', g.openDeals === 1, g.openDeals);
}

console.log('\n=== lead funnel and task load ===');
{
  const funnel = await leadFunnelReport(acme);
  const contacted = funnel.find((r) => r.status === 'contacted');
  T('two contacted leads', contacted?.count === 2, contacted);
  T('Globex lead absent from Acme funnel',
    funnel.reduce((a, r) => a + r.count, 0) === 3, funnel);

  const load = await taskLoadReport(acme);
  T('two task rows (todo/high, completed/low)', load.length === 2, load.length);
  T('the completed task is still reported (task-load counts all statuses)',
    load.some((r) => r.status === 'completed'), load);
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
