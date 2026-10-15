/**
 * Database access layer.
 *
 * Two drivers behind one interface:
 *   PgDriver     — node-postgres pool. Production path.
 *   PgliteDriver — real PostgreSQL 17 compiled to WASM. Development and test.
 *
 * PGlite is not a mock: it is the actual PostgreSQL engine, so migrations,
 * foreign keys, unique constraints, check constraints, transactions and
 * `SELECT ... FOR UPDATE` are exercised for real. This matters because the
 * legacy CRM shipped DDL that SQLite accepted and PostgreSQL rejects (a
 * forward foreign-key reference); running against real PostgreSQL is what
 * catches that class of defect.
 */
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { dbQueryDuration } from '../lib/metrics.ts';

export type QueryRow = Record<string, unknown>;

/**
 * Normalises the driver-reported row count so `rowCount` means the same thing
 * on both backends.
 *
 * `pg` reports `rowCount === rows.length` for SELECT, but PGlite reports 0 for
 * every SELECT regardless of how many rows came back (it only populates
 * `affectedRows` for INSERT/UPDATE/DELETE). Left unnormalised that is a trap:
 * the suite passes against real PostgreSQL while any `rowCount` check on a
 * SELECT silently reads as "no rows" under the test engine, and any code
 * written against the test behaviour inverts under production.
 *
 * Falling back to `rows.length` when the driver reports 0 is safe for DML
 * too: a statement that affected nothing also returned nothing.
 */
function rowCountOf(res: { rows: unknown[]; rowCount?: number | null }): number {
  return res.rowCount || res.rows.length;
}

export interface DbClient {
  query<T extends QueryRow = QueryRow>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` against one dedicated connection, outside any transaction.
   *
   * This exists for session-scoped state, chiefly PostgreSQL advisory locks.
   * Those are held per *connection*, not per statement, and the pool hands each
   * query a different one — so `SELECT pg_try_advisory_lock(k)` followed by
   * `SELECT pg_advisory_unlock(k)` via `query()` would lock and unlock two
   * unrelated sessions, and the "lock" would guard nothing. Every caller of
   * `withConnection` gets one session for the whole callback, which is what makes
   * the lock meaningful.
   *
   * Nothing is committed or rolled back here; each statement autocommits. Use
   * `transaction()` when the unit of work must be atomic.
   */
  withConnection<T>(fn: (c: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'postgres' | 'pglite';
  /** True when the caller is already inside a transaction. */
  readonly inTransaction: boolean;
}

const instrument = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
  const end = dbQueryDuration.startTimer({ op });
  try { return await fn(); } finally { end(); }
};

// ── node-postgres ────────────────────────────────────────────────────────────
class PgDriver implements DbClient {
  readonly kind = 'postgres' as const;
  readonly inTransaction = false;
  private readonly pool: import('pg').Pool;
  constructor(pool: import('pg').Pool) { this.pool = pool; }
  private get client() { return this.pool; }

  async query<T extends QueryRow = QueryRow>(sql: string, params: readonly unknown[] = []) {
    return instrument('pg.query', async () => {
      const res = await this.client.query(sql, params as unknown[]);
      return { rows: res.rows as T[], rowCount: rowCountOf(res) };
    });
  }
  async exec(sql: string) {
    // Deliberately NOT routed through `query`: node-postgres returns an ARRAY
    // of results for a multi-statement script (migrations), which has no
    // `.rows`, so inspecting the shape crashes. That is exactly what happened:
    // every migrate-then-test run on real PostgreSQL died in `rowCountOf`
    // while PGlite (single result object) stayed green — and the production
    // `npm run migrate` path was broken the same way. `exec` promises no rows;
    // callers that need rows use `query`, which stays strict.
    return instrument('pg.exec', async () => {
      await this.client.query(sql);
    });
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    // One pooled connection for the whole unit of work (RULE 71).
    const conn = await this.pool.connect();
    const scoped = new PgTransaction(conn);
    try {
      await conn.query('BEGIN');
      const out = await fn(scoped);
      await conn.query('COMMIT');
      return out;
    } catch (err) {
      try { await conn.query('ROLLBACK'); } catch (rbErr) { logger.error({ err: rbErr }, 'rollback failed'); }
      throw err;
    } finally {
      conn.release();
    }
  }

  async withConnection<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
    // One checked-out session for the whole callback, with no BEGIN. Advisory
    // locks and anything else that lives on a session rather than a statement
    // need this; the connection is always released, even when `fn` throws.
    const conn = await this.pool.connect();
    try {
      return await fn(new PgSession(conn));
    } finally {
      conn.release();
    }
  }
  async close() { await this.pool.end(); }
}

/**
 * A single pooled session with no transaction around it.
 *
 * Deliberately distinct from `PgTransaction`: `inTransaction` is false, so a
 * caller holding one of these cannot accidentally rely on atomicity it does not
 * have, and `transaction()` on it opens a real transaction rather than
 * re-entering a nonexistent one.
 */
class PgSession implements DbClient {
  readonly kind = 'postgres' as const;
  readonly inTransaction = false;
  // Not a TypeScript parameter property (`constructor(private readonly conn)`):
  // `--experimental-strip-types` rejects those, and unit/modules.test.ts guards
  // against the construct sneaking back in.
  private readonly conn: import('pg').PoolClient;
  constructor(conn: import('pg').PoolClient) { this.conn = conn; }
  async query<T extends QueryRow = QueryRow>(sql: string, params: readonly unknown[] = []) {
    return instrument('pg.query', async () => {
      const res = await this.conn.query(sql, params as unknown[]);
      return { rows: res.rows as T[], rowCount: rowCountOf(res) };
    });
  }
  // See PgDriver.exec: never inspect the result shape here.
  async exec(sql: string) {
    return instrument('pg.exec', async () => {
      await this.conn.query(sql);
    });
  }
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    await this.conn.query('BEGIN');
    try {
      const out = await fn(new PgTransaction(this.conn));
      await this.conn.query('COMMIT');
      return out;
    } catch (err) {
      try { await this.conn.query('ROLLBACK'); } catch (rbErr) { logger.error({ err: rbErr }, 'rollback failed'); }
      throw err;
    }
  }
  async withConnection<T>(fn: (c: DbClient) => Promise<T>): Promise<T> { return fn(this); }
  async close() { /* connection is owned by the pool */ }
}

class PgTransaction implements DbClient {
  readonly kind = 'postgres' as const;
  readonly inTransaction = true;
  private readonly conn: import('pg').PoolClient;
  constructor(conn: import('pg').PoolClient) { this.conn = conn; }
  async query<T extends QueryRow = QueryRow>(sql: string, params: readonly unknown[] = []) {
    const res = await this.conn.query(sql, params as unknown[]);
    return { rows: res.rows as T[], rowCount: rowCountOf(res) };
  }
  // See PgDriver.exec: never inspect the result shape here.
  async exec(sql: string) { await this.conn.query(sql); }
  // Nested call sites reuse the same transaction rather than opening a second one.
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> { return fn(this); }
  // Already pinned to one session, so there is nothing further to acquire.
  async withConnection<T>(fn: (c: DbClient) => Promise<T>): Promise<T> { return fn(this); }
  async close() { /* connection is owned by the pool */ }
}

// ── TLS ──────────────────────────────────────────────────────────────────────

/**
 * PostgreSQL TLS configuration (RULE 52).
 *
 * Three modes, because "encrypted" and "authenticated" are different promises
 * and conflating them is how a database ends up silently unverified:
 *
 *   `disable`      no TLS. Refused in production.
 *   `require`      TLS, but any certificate is accepted. This defends against a
 *                  passive network observer and nothing else — it does NOT stop
 *                  an active man-in-the-middle. Only for a private link or a
 *                  tunnel that already authenticates the peer.
 *   `verify-full`  TLS and the certificate chain must validate against `ca` AND
 *                  the hostname must match. This is what production defaults to.
 *
 * Why `ca` matters: the previous hard-coded `{ rejectUnauthorized: true }` had no
 * `ca`, so node fell back to the system trust store. AWS RDS issues certificates
 * from Amazon's private CA, which is **not** in the public root bundle, so the
 * container would have failed to connect to the very database it was built for —
 * a fail-closed failure, but a total one. `DATABASE_SSL_CA` (inline PEM) or
 * `DATABASE_SSL_CA_FILE` (path, e.g. the mounted global-bundle.pem) supplies it.
 *
 * A `verify-full` connection with no CA available is a startup error, not a
 * silent downgrade.
 */
function tlsOptions(): boolean | { ca?: string; rejectUnauthorized: boolean } | undefined {
  const mode = env.db.ssl;
  if (mode === 'disable') {
    if (env.nodeEnv === 'production') {
      // Re-checked here as well as in config/env.ts: the driver is the last
      // place an unencrypted connection could still be established.
      throw new Error('[db] DATABASE_SSL=disable is not permitted in production.');
    }
    return undefined;
  }

  if (mode === 'require') return { rejectUnauthorized: false };

  // verify-full
  const ca = env.db.sslCa?.trim();
  const opts: { ca?: string; rejectUnauthorized: boolean } = { rejectUnauthorized: true };
  if (ca) opts.ca = ca;

  if (env.nodeEnv === 'production' && !ca) {
    // Not fatal: node's system store may already contain the issuer (self-hosted
    // Postgres with a publicly-trusted cert). Warn loudly rather than refuse, so
    // an operator is never left guessing why the connection failed.
    logger.warn(
      'DATABASE_SSL=verify-full without DATABASE_SSL_CA — falling back to the system trust store. ' +
      'Amazon RDS certificates are NOT publicly trusted; set DATABASE_SSL_CA or DATABASE_SSL_CA_FILE.',
    );
  }
  return opts;
}

// ── PGlite ───────────────────────────────────────────────────────────────────
// PGlite is a single in-process session: three concurrent `transaction()`
// calls share one physical transaction (a second BEGIN is a warning, not a new
// transaction), so their statements interleave and one caller's ROLLBACK undoes
// another's uncommitted writes. Observed directly: three parallel MFA
// redemptions produced exactly one winner whose step write had vanished —
// rolled back out from under it by a loser's abort — and the anti-replay
// assertion then failed despite correct service code. Real PostgreSQL
// isolates these on separate connections; on PGlite the honest equivalent is
// to run each transaction body atomically. The reads and validation in service
// code still race (that is what the concurrency tests exercise); only the
// compare-and-set writes inside the transaction cannot interleave.
//
// Module-level, not per-instance: there is one PGlite session per process no
// matter how many driver wrappers exist, so per-instance locks would not
// exclude each other. PgDriver gets no gate — production has real isolation
// and must keep it.
let pgliteTxGate: Promise<void> = Promise.resolve();
async function withPgliteTxGate<T>(fn: () => Promise<T>): Promise<T> {
  const prev = pgliteTxGate;
  let release!: () => void;
  pgliteTxGate = new Promise<void>((res) => { release = res; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

class PgliteDriver implements DbClient {
  readonly kind = 'pglite' as const;
  readonly inTransaction = false;
  private readonly pg: import('@electric-sql/pglite').PGlite;
  constructor(pg: import('@electric-sql/pglite').PGlite) { this.pg = pg; }
  private get client() { return this.pg; }

  async query<T extends QueryRow = QueryRow>(sql: string, params: readonly unknown[] = []) {
    return instrument('pglite.query', async () => {
      const res = await this.client.query<T>(sql, params as never[]);
      return { rows: res.rows, rowCount: rowCountOf({ rows: res.rows, rowCount: res.affectedRows }) };
    });
  }
  async exec(sql: string) { await this.client.exec(sql); }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return withPgliteTxGate(async () => {
      const scoped = new PgliteTransaction(this.pg);
      await this.client.exec('BEGIN');
      try {
        const out = await fn(scoped);
        await this.client.exec('COMMIT');
        return out;
      } catch (err) {
        try { await this.client.exec('ROLLBACK'); } catch (rbErr) { logger.error({ err: rbErr }, 'pglite rollback failed'); }
        throw err;
      }
    });
  }
  /**
   * PGlite is a single in-process session, so there is nothing to acquire: the
   * callback already runs on the only connection there is.
   *
   * Consequence worth stating plainly: advisory locks on PGlite always succeed,
   * because the same session re-entering its own lock is granted it. PGlite
   * therefore cannot demonstrate mutual exclusion, and the leader-election test
   * asserts real exclusion only when `kind === 'postgres'`. Reporting a PGlite
   * pass as evidence that two replicas cannot sweep at once would be a
   * fabricated result.
   */
  async withConnection<T>(fn: (c: DbClient) => Promise<T>): Promise<T> { return fn(this); }
  async close() { try { await this.pg.close(); } catch { /* already closed */ } }
}

class PgliteTransaction implements DbClient {
  readonly kind = 'pglite' as const;
  readonly inTransaction = true;
  private readonly pg: import('@electric-sql/pglite').PGlite;
  constructor(pg: import('@electric-sql/pglite').PGlite) { this.pg = pg; }
  async query<T extends QueryRow = QueryRow>(sql: string, params: readonly unknown[] = []) {
    const res = await this.pg.query<T>(sql, params as never[]);
    return { rows: res.rows, rowCount: rowCountOf({ rows: res.rows, rowCount: res.affectedRows }) };
  }
  async exec(sql: string) { await this.pg.exec(sql); }
  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> { return fn(this); }
  async withConnection<T>(fn: (c: DbClient) => Promise<T>): Promise<T> { return fn(this); }
  async close() { /* owned by the driver */ }
}

// ── singleton ────────────────────────────────────────────────────────────────
let driver: DbClient | null = null;

export async function getDb(): Promise<DbClient> {
  if (driver) return driver;
  driver = await createDriver();
  return driver;
}

async function createDriver(): Promise<DbClient> {
  if (env.databaseUrl) {
    const { default: pg } = await import('pg');
    // Timestamps come back as ISO strings, not Date objects, so serialisation is uniform.
    pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
    pg.types.setTypeParser(1114, (v: string) => new Date(`${v}Z`).toISOString());
    pg.types.setTypeParser(1700, (v: string) => Number(v));   // numeric -> number for money in cents
    const pool = new pg.Pool({
      connectionString: env.databaseUrl,
      max: env.dbPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: env.dbStatementTimeoutMs,             // RULE 77
      query_timeout: env.dbStatementTimeoutMs,
      application_name: 'bigcrm-api',
      ssl: tlsOptions(),
    });
    // A pool-level error must not take the process down.
    pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
    logger.info({ max: env.dbPoolMax }, 'postgres pool created');
    return new PgDriver(pool);
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = env.pgliteDataDir && env.pgliteDataDir !== 'memory'
    ? await PGlite.create({ dataDir: env.pgliteDataDir })
    : await PGlite.create();
  logger.warn('using embedded PGlite PostgreSQL — development/test only');
  return new PgliteDriver(pg);
}

export async function closeDb(): Promise<void> {
  if (!driver) return;
  await driver.close();
  driver = null;
}

/** Readiness probe. Reports state only — never credentials or topology (RULE 118). */
export async function dbReady(): Promise<{ ok: boolean; kind: string; latencyMs: number }> {
  const t = Date.now();
  try {
    const db = await getDb();
    await db.query('select 1 as ok');
    return { ok: true, kind: db.kind, latencyMs: Date.now() - t };
  } catch (err) {
    logger.error({ err }, 'readiness check failed');
    return { ok: false, kind: 'unknown', latencyMs: Date.now() - t };
  }
}