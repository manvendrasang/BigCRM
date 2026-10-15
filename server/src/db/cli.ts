/**
 * Operational CLI.
 *
 *   migrate up       apply pending migrations
 *   migrate status   applied versions and checksums
 *   migrate reset    refuse; documented in docs/OPERATIONS.md (forward-fix only)
 *   seed             create a demo organization for local development
 *   rekey            reseal MFA secrets from one key provider to another
 *
 * Commands report what actually happened and exit non-zero on failure (RULE 5).
 */
import { getDb, closeDb } from './driver.ts';
import { migrate, migrationStatus } from './migrate.ts';
import { initDriver } from '../repositories/base.ts';
import { env } from '../config/env.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { hashPassword } from '../lib/password.ts';
import { slugify } from '../services/normalise.ts';
import { createEnvProvider, createKmsProvider } from '../lib/kms.ts';
import type { KeyProvider } from '../lib/kms.ts';
import { rekeyMfaSecrets } from '../services/rekey.ts';

const [, , command, ...rest] = process.argv;
const args = new Set(rest);

const argValue = (name: string): string | undefined => {
  const prefix = `${name}=`;
  for (const a of rest) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return undefined;
};

const ok = (m: string): void => console.log(`  ok    ${m}`);
const info = (m: string): void => console.log(`  info  ${m}`);
const fail = (m: string): never => { console.error(`  FAIL  ${m}`); process.exit(1); };

async function cmdMigrate(sub: string): Promise<void> {
  await initDriver();
  if (sub === 'status') {
    const rows = await migrationStatus();
    if (rows.length === 0) { info('no migrations applied'); return; }
    console.log('  version                 applied_at                     checksum');
    for (const r of rows) console.log(`  ${r.version.padEnd(24)} ${r.appliedAt.padEnd(30)} ${r.checksum.slice(0, 16)}`);
    return;
  }
  if (sub === 'reset') {
    fail('`migrate reset` is intentionally not implemented. Restore from backup or write a compensating migration — see docs/OPERATIONS.md.');
  }
  const result = await migrate({ allowDestructive: args.has('--allow-destructive') });
  if (result.applied.length === 0) { ok(`schema up to date (${result.skipped.length} already applied)`); return; }
  for (const v of result.applied) ok(`applied ${v}`);
}

async function cmdSeed(): Promise<void> {
  await initDriver();
  await migrate();
  const db = await getDb();
  // The check and the insert must use the same slug: this used to check for
  // 'acme' while inserting slugify('Acme Corporation') = 'acme-corporation',
  // so every re-run missed, re-inserted the owner, and died on the email
  // unique constraint instead of skipping.
  const slug = slugify('Acme Corporation');
  const existing = await db.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
  if (existing.rows.length > 0) { info(`demo organization already exists (slug "${slug}") — nothing to do`); return; }

  const orgId = newId();
  const userId = newId();
  const now = nowIso();
  const supplied: string | undefined = process.env.SEED_OWNER_PASSWORD;
  if (supplied === undefined || supplied.length < 12) {
    throw new Error('Set SEED_OWNER_PASSWORD (>= 12 characters) before seeding. A seeded account must never use a default password.');
  }
  const ownerPassword: string = supplied;

  await db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO users (id, email, email_normalized, name, password_hash, email_verified_at, created_at, updated_at) VALUES ($1,$2,$2,$3,$4,$5,$5,$5)',
      [userId, 'owner@acme.test', 'Owner', await hashPassword(ownerPassword), now]);
    await tx.query(
      'INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)',
      [orgId, 'Acme Corporation', slug, now]);
    await tx.query(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status, joined_at, created_at, updated_at)
       VALUES ($1,$2,$3,'owner','active',$4,$4,$4)`,
      [newId(), orgId, userId, now]);
    await tx.query(
      `INSERT INTO pipelines (id, organization_id, name, is_default, created_at, updated_at) VALUES ($1,$2,'Sales Pipeline',true,$3,$3)`,
      [newId(), orgId, now]);
  });
  ok('seeded organization "Acme Corporation"');
  ok('owner account owner@acme.test (email verified)');
  info('password was taken from SEED_OWNER_PASSWORD and is not printed');
}

async function cmdRekey(): Promise<void> {
  // Parsing narrows through `throw`, not through `fail()`: `fail` exits the
  // process but its `never` return does not participate in narrowing here, so
  // every refusal ends in an explicit throw. Belt and suspenders — the throw
  // is unreachable, and the usage line stays the single source of syntax.
  const parseProvider = (label: string, v: string | undefined): 'env' | 'kms' => {
    if (v === 'env' || v === 'kms') return v;
    fail(`${label} must be env or kms (usage: rekey --from=env|kms --to=env|kms [--dry-run])`);
    throw new Error('unreachable');
  };
  const from = parseProvider('--from', argValue('--from'));
  const to = parseProvider('--to', argValue('--to'));
  const dryRun = args.has('--dry-run');
  if (from === to) fail('source and target providers are the same — nothing to do');

  // The ambient provider is irrelevant here: both ends are built explicitly,
  // so this command works no matter what MFA_KEY_PROVIDER says (including
  // rekeying back from kms to env during a rollback).
  const build = async (id: 'env' | 'kms'): Promise<KeyProvider> => {
    if (id === 'env') return createEnvProvider();
    const ciphertext = env.kmsMfaKeyCiphertext;
    if (ciphertext === null) {
      fail('the kms side needs KMS_MFA_KEY_CIPHERTEXT in the environment');
      throw new Error('unreachable');
    }
    return createKmsProvider(ciphertext);
  };
  await initDriver();
  const result = await rekeyMfaSecrets(await build(from), await build(to), { dryRun });
  for (const f of result.failed) console.error(`  FAIL  ${f.userId}: ${f.error}`);
  if (result.failed.length > 0) {
    fail(`${result.failed.length} secret(s) would not decrypt — nothing was written`);
  }
  ok(`${dryRun ? 'would reseal' : 'resealed'} ${result.sealed} MFA secret(s) ${from} -> ${to}`);
}

const COMMANDS: Record<string, () => Promise<void>> = {
  'migrate:up': () => cmdMigrate('up'),
  'migrate:status': () => cmdMigrate('status'),
  'migrate:reset': () => cmdMigrate('reset'),
  'seed': cmdSeed,
  'rekey': cmdRekey,
};

const run = COMMANDS[command ?? ''];
if (!run) {
  console.error(`usage: node --experimental-strip-types src/db/cli.ts <command>

  migrate:up [--allow-destructive]   apply pending migrations
  migrate:status                     show applied versions and checksums
  seed                               create a demo organization (needs SEED_OWNER_PASSWORD)
  rekey --from=env|kms --to=env|kms [--dry-run]
                                     reseal MFA secrets between key providers`);
  process.exit(1);
}

try {
  await run();
  await closeDb();
  process.exit(0);
} catch (err) {
  console.error(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
  await closeDb().catch(() => undefined);
  process.exit(1);
}