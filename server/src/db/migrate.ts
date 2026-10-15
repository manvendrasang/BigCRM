/**
 * Migration runner (RULE 130, 131).
 *
 * Design decisions:
 *  * A dedicated `schema_migrations` table records applied versions.
 *  * Each migration runs inside a transaction together with its version row, so
 *    a failure leaves neither partial DDL nor a phantom version.
 *  * A checksum of the applied SQL is stored. If a landed migration is edited,
 *    startup fails loudly instead of silently diverging (RULE 130).
 *  * Destructive migrations must declare `destructive = true`; the runner then
 *    refuses to apply them without an explicit acknowledgement flag.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbClient } from './driver.ts';
import { getDb } from './driver.ts';
import { logger } from '../lib/logger.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, 'migrations');

export type Migration = {
  version: string;
  sql: string;
  checksum: string;
  destructive: boolean;
};

const DESTRUCTIVE = /^\s*--\s*@destructive\b/im;

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out: Migration[] = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    out.push({
      version: file.replace(/\.sql$/, ''),
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      destructive: DESTRUCTIVE.test(sql),
    });
  }
  return out;
}

const ENSURE_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  checksum    char(64) NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer  NOT NULL DEFAULT 0
);`;

export type MigrateResult = { applied: string[]; skipped: string[] };

export async function migrate(opts: { allowDestructive?: boolean } = {}): Promise<MigrateResult> {
  const db: DbClient = await getDb();
  await db.exec(ENSURE_BOOTSTRAP);

  const applied = new Set(
    (await db.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
  );
  const appliedChecksums = new Map(
    (await db.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations'))
      .rows.map((r) => [r.version, r.checksum]),
  );

  const migrations = await loadMigrations();
  const result: MigrateResult = { applied: [], skipped: [] };

  for (const m of migrations) {
    if (applied.has(m.version)) {
      const recorded = appliedChecksums.get(m.version);
      if (recorded && recorded !== m.checksum) {
        throw new Error(
          `Migration ${m.version} has been modified since it was applied ` +
          `(recorded ${recorded.slice(0, 12)}…, file ${m.checksum.slice(0, 12)}…). ` +
          'Add a new migration instead of editing a landed one.',
        );
      }
      result.skipped.push(m.version);
      continue;
    }
    if (m.destructive && !opts.allowDestructive) {
      throw new Error(
        `Migration ${m.version} is marked @destructive. Re-run with --allow-destructive ` +
        'after taking and verifying a backup (RULE 131).',
      );
    }
    const t = Date.now();
    // One transaction covers the DDL and its bookkeeping row: no partial state.
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query(
        'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
        [m.version, m.checksum, Date.now() - t],
      );
    });
    result.applied.push(m.version);
    logger.info({ version: m.version, ms: Date.now() - t }, 'migration applied');
  }

  return result;
}

export async function migrationStatus(): Promise<{ version: string; checksum: string; appliedAt: string }[]> {
  const db = await getDb();
  await db.exec(ENSURE_BOOTSTRAP);
  return db.query<{ version: string; checksum: string; applied_at: string }>(
    'SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version',
  ).then((r) => r.rows.map((x) => ({ version: x.version, checksum: x.checksum, appliedAt: x.applied_at })));
}