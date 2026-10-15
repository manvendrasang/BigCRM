/**
 * Seeds a realistic dataset so the backup/restore drill measures something
 * worth measuring. An empty database restores instantly and tells you nothing
 * about whether your RTO is achievable.
 *
 * node --experimental-strip-types --no-warnings --env-file=.env seed/load.ts
 *
 * Writes directly through the services rather than raw SQL so the resulting data
 * is internally consistent: tenant-scoped, audited, and with the same invariants
 * a production write path would enforce.
 */
import { migrate } from '../src/db/migrate.ts';
await migrate();
import { getDb } from '../src/db/driver.ts';
import { newId } from '../src/lib/ids.ts';
import { hashPassword } from '../src/lib/password.ts';
import { nowIso } from '../src/lib/time.ts';

const ORGS = Number(process.env.SEED_ORGS ?? 3);
const CONTACTS_PER_ORG = Number(process.env.SEED_CONTACTS ?? 400);
const COMPANIES_PER_ORG = Number(process.env.SEED_COMPANIES ?? 120);
const DEALS_PER_ORG = Number(process.env.SEED_DEALS ?? 200);
const LEADS_PER_ORG = Number(process.env.SEED_LEADS ?? 150);
const TASKS_PER_ORG = Number(process.env.SEED_TASKS ?? 300);

const db = await getDb();
const now = nowIso();
const pw = await hashPassword('Seed-Password-Strong!42');

const rnd = (n: number): number => Math.floor(Math.random() * n);
const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)]!;
const FIRST = ['Ada', 'Grace', 'Alan', 'Linus', 'Barbara', 'Ken', 'Margaret', 'Dennis', 'Radia', 'Tim'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Liskov', 'Thompson', 'Hamilton', 'Ritchie', 'Perlman', 'Berners-Lee'];
const INDUSTRY = ['Software', 'Manufacturing', 'Healthcare', 'Logistics', 'Finance', 'Retail'];
const STAGES = ['New', 'Qualification', 'Proposal', 'Negotiation', 'Won'];

const started = Date.now();
const summary: Record<string, number> = {};

// Make the loader genuinely re-runnable. Every generated address is scoped by
// the `seed.test` domain and every generated slug by the `seed-org-` prefix, so
// clearing prior output can never touch real data.
if (process.env.SEED_RESET !== '0') {
 const wipe = await db.query(
 `DELETE FROM organizations WHERE slug LIKE 'seed-org-%'`, []);
 if (wipe.rowCount) console.log(` cleared ${wipe.rowCount} previous seed organization(s)`);
 await db.query(`DELETE FROM users WHERE email_normalized LIKE '%@seed.test'`, []);
}

for (let o = 0; o < ORGS; o++) {
 const orgId = newId();
 const orgName = `Seed Org ${o + 1}`;
 const slug = `seed-org-${o + 1}`;
 // Idempotent: re-running the loader must not collide with its own output.
 // A unique-slug violation on a supposedly fresh database was the symptom of a
 // partially-applied previous run, which is easy to get when the loader is used
 // to top up an existing dataset for a restore drill.
 const clash = await db.query('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
 if (clash.rows.length > 0) {
 console.error(` slug "${slug}" already exists -- dropping and reloading`);
 await db.query('DELETE FROM organizations WHERE slug = $1', [slug]);
 }
 await db.query(
 `INSERT INTO organizations (id,name,slug,currency,timezone,locale,status,retention_days,created_at,updated_at)
 VALUES ($1,$2,$3,'USD','UTC','en','active',730,$4,$4)`,
 [orgId, orgName, slug, now]);

 const ownerId = newId();
 await db.query(
 `INSERT INTO users (id,email,email_normalized,name,password_hash,email_verified_at,mfa_enabled,created_at,updated_at)
 VALUES ($1,$2,$2,$3,$4,$5,false,$5,$5)`,
 [ownerId, `owner${o}@seed.test`, `Seed Owner ${o + 1}`, pw, now]);
 await db.query(
 `INSERT INTO organization_members (id,organization_id,user_id,role,status,joined_at,created_at,updated_at)
 VALUES ($1,$2,$3,'owner','active',$4,$4,$4)`,
 [newId(), orgId, ownerId, now]);

 // Pipeline + stages (a deal is meaningless without them).
 const pipelineId = newId();
 await db.query(
 `INSERT INTO pipelines (id,organization_id,name,is_default,created_at,updated_at)
 VALUES ($1,$2,'Sales Pipeline',true,$3,$3)`, [pipelineId, orgId, now]);
 const stageIds: string[] = [];
 for (const [i, name] of STAGES.entries()) {
 const id = newId();
 stageIds.push(id);
 await db.query(
 `INSERT INTO pipeline_stages (id,organization_id,pipeline_id,name,position,probability,is_won,is_lost,created_at,updated_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$8)`,
 [id, orgId, pipelineId, name, i, Math.round((i / (STAGES.length - 1)) * 100), i === STAGES.length - 1, now]);
 }

 //  companies 
 const companyIds: string[] = [];
 for (let i = 0; i < COMPANIES_PER_ORG; i++) {
 const id = newId();
 companyIds.push(id);
 await db.query(
 `INSERT INTO companies (id,organization_id,name,name_normalized,domain,industry,status,owner_id,
 created_at,updated_at,created_by,updated_by)
 VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$8,$7,$7)`,
 [id, orgId, `${pick(FIRST)} ${pick(LAST)} Industries ${i}`,
 `${pick(FIRST)} ${pick(LAST)} industries ${i}`.toLowerCase(),
 `corp${i}.example`, pick(INDUSTRY), ownerId, now]);
 }

 //  contacts 
 for (let i = 0; i < CONTACTS_PER_ORG; i++) {
 await db.query(
 `INSERT INTO contacts (id,organization_id,first_name,last_name,email,email_normalized,phone,
 job_title,company_id,owner_id,status,lifecycle_stage,source,
 created_at,updated_at,created_by,updated_by)
 VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,'active',$10,$11,$12,$12,$9,$9)`,
 [newId(), orgId, pick(FIRST), pick(LAST), `c${i}.${o}@customer.example`,
 `+1555${String(1000000 + i).slice(0, 7)}`,
 pick(['VP Sales', 'CTO', 'Head of Ops', 'Director', 'Analyst']),
 pick(companyIds), ownerId,
 pick(['lead', 'prospect', 'customer', 'churned']), pick(['webinar', 'referral', 'outbound', 'organic']), now]);
 }

 //  deals 
 for (let i = 0; i < DEALS_PER_ORG; i++) {
 const stageIdx = rnd(STAGES.length);
 await db.query(
 `INSERT INTO deals (id,organization_id,name,value_c,currency,pipeline_id,stage_id,probability,
 company_id,owner_id,status,source,created_at,updated_at,created_by,updated_by)
 VALUES ($1,$2,$3,$4,'USD',$5,$6,$7,$8,$9,$10,$11,$12,$12,$9,$9)`,
 [newId(), orgId, `Deal ${i} -- ${pick(FIRST)} ${pick(LAST)}`,
 rnd(50_000_00), pipelineId, stageIds[stageIdx], Math.round((stageIdx / (STAGES.length - 1)) * 100),
 pick(companyIds), ownerId, stageIdx === STAGES.length - 1 ? 'won' : 'open',
 pick(['webinar', 'referral', 'outbound']), now]);
 }

 //  leads 
 for (let i = 0; i < LEADS_PER_ORG; i++) {
 await db.query(
 `INSERT INTO leads (id,organization_id,first_name,last_name,company_name,email,email_normalized,
 phone,title,source,status,score,rating,owner_id,created_at,updated_at,created_by,updated_by)
 VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$13,$13)`,
 [newId(), orgId, pick(FIRST), pick(LAST), `${pick(LAST)} Corp ${i}`,
 `l${i}.${o}@lead.example`, `+1555${String(2000000 + i).slice(0, 7)}`,
 pick(['Buyer', 'Champion', 'Decision Maker']), pick(['webinar', 'referral', 'outbound']),
 pick(['new', 'contacted', 'qualified', 'nurturing']), rnd(101),
 pick(['hot', 'warm', 'cold']), ownerId, now]);
 }

 //  tasks 
 for (let i = 0; i < TASKS_PER_ORG; i++) {
 const done = Math.random() < 0.4;
 await db.query(
 `INSERT INTO tasks (id,organization_id,title,description,status,priority,creator_id,assignee_id,
 due_date,completed_at,created_at,updated_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$10)`,
 [newId(), orgId, `Follow up #${i}`, 'Seeded task for the restore drill',
 done ? 'completed' : pick(['todo', 'in_progress', 'blocked']),
 pick(['low', 'medium', 'high', 'urgent']), ownerId,
 new Date(Date.now() + rnd(14) * 86_400_000).toISOString(),
 done ? now : null, now]);
 }

 //  notes + activities 
 // The drill checks that a restored database is *functional*, and an empty
 // table cannot demonstrate that. Notes and activities also exercise the
 // activities_entity_type CHECK widened by migration 0002.
 const someContacts = await db.query<{ id: string; company_id: string | null }>(
 'SELECT id, company_id FROM contacts WHERE organization_id = $1 LIMIT 50', [orgId]);
 for (const c of someContacts.rows) {
 await db.query(
 `INSERT INTO notes (id,organization_id,entity_type,entity_id,body_html,body_text,author_id,created_at,updated_at)
 VALUES ($1,$2,'contact',$3,'<p>Seeded note</p>','Seeded note',$4,$5,$5)`,
 [newId(), orgId, c.id, ownerId, now]);
 await db.query(
 `INSERT INTO activities (id,organization_id,type,actor_id,entity_type,entity_id,subject,description,metadata,occurred_at,created_at)
 VALUES ($1,$2,'created',$3,'contact',$4,'Seeded activity','Seeded activity','{}'::jsonb,$5,$5)`,
 [newId(), orgId, ownerId, c.id, now]);
 if (c.company_id) {
 await db.query(
 `INSERT INTO activities (id,organization_id,type,actor_id,entity_type,entity_id,subject,metadata,occurred_at,created_at)
 VALUES ($1,$2,'created',$3,'company',$4,'Seeded company activity','{}'::jsonb,$5,$5)`,
 [newId(), orgId, ownerId, c.company_id, now]);
 }
 }

 //  audit rows 
 // Seeding via raw SQL bypasses the audit layer, so audit_logs would otherwise
 // be empty -- and an empty table cannot demonstrate that the append-only
 // trigger survived a restore. These rows exist precisely so the drill has
 // something to try to tamper with.
 for (let i = 0; i < 60; i++) {
 await db.query(
 `INSERT INTO audit_logs (id,organization_id,actor_id,actor_role,action,entity_type,entity_id,
 outcome,before_json,after_json,changed_fields,ip,user_agent,request_id,metadata,created_at)
 VALUES ($1,$2,$3,$4,'seed.create','organization',$2,'success','{}'::jsonb,'{}'::jsonb,
 ARRAY['name'],'10.0.0.1','seed-drill',$5::text,'{"seeded":true}',$6)`,
 // $5 and $6 must be separate parameters: one placeholder cannot be typed
 // as both text (request_id) and timestamptz (created_at).
 [newId(), orgId, ownerId, 'owner', 'seed-drill', now]);
 }

 summary[`org_${o + 1}_contacts`] = CONTACTS_PER_ORG;
 summary[`org_${o + 1}_deals`] = DEALS_PER_ORG;
}

const counts = async (label: string): Promise<void> => {
 const tables = ['organizations', 'users', 'organization_members', 'pipelines', 'pipeline_stages',
 'companies', 'contacts', 'deals', 'leads', 'tasks', 'notes', 'activities', 'audit_logs'];
 const out: Record<string, number> = {};
 for (const t of tables) {
 const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
 out[t] = r.rows[0]?.n ?? 0;
 }
 console.log(label, JSON.stringify(out));
};
await counts('row counts:');
console.log(`seeded in ${Date.now() - started}ms`);
void summary;
process.exit(0);
