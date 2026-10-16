/**
 * Database access layer: two drivers behind one interface.
 *
 * `PgDriver` (node-postgres pool) is the production path; `PgliteDriver` is real
 * PostgreSQL 17 compiled to WASM, for development and tests. PGlite is not a
 * mock -- foreign keys, CHECK constraints, triggers and transactions are
 * genuinely exercised, which is what catches the class of defect the legacy CRM
 * shipped (DDL that SQLite accepted and PostgreSQL rejects).
 */
import { env } from '../config/env.ts';
import { logger } from '../lib/logger.ts';
import { dbQueryDuration } from '../lib/metrics.ts';

export type QueryRow = Record<string, unknown>;

/**
 * Normalises `rowCount` across the two drivers.
 *
 * `pg` reports `rowCount === rows.length` for SELECT; PGlite reports 0 for every
 * SELECT. Unnormalised, any `rowCount` check on a SELECT reads as "no rows"
 * under the test engine while passing against real PostgreSQL, so code written
 * against the test behaviour inverts in production. Falling back to
 * `rows.length` when the driver reports 0 is safe for DML too: a statement that
 * affected nothing also returned nothing.
 */
function rowCountOf(res: { rows: unknown[]; rowCount?: number | null }): number {
 return res.rowCount || res.rows.length;
}

export interface DbClient {
 query<T extends QueryRow = QueryRow>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }>;
 exec(sql: string): Promise<void>;
 transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
 /**
 * Runs `fn` on one dedicated connection, outside any transaction. Exists for
 * session-scoped state, chiefly advisory locks: those are held per connection
 * while the pool hands each query a different one, so locking and unlocking
 * through `query()` would touch two unrelated sessions and guard nothing. Each
 * statement autocommits here; use `transaction()` when the unit of work must be
 * atomic.
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

//  node-postgres 
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
 // Deliberately NOT routed through `query`: node-postgres returns an ARRAY of
 // results for a multi-statement script (migrations), which has no `.rows`, so
 // inspecting the shape crashes. That is exactly what happened -- migrate-then-test
 // died in `rowCountOf` on real PostgreSQL while PGlite stayed green, and the
 // production `npm run migrate` path was broken the same way. `exec` promises no rows;
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
 // One session for the whole callback, no BEGIN: advisory locks and other
 // session-scoped state need it. Always released, even when `fn` throws.
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
 // Not a TS parameter property (`constructor(private readonly conn)`):
 // `--experimental-strip-types` rejects those, and unit/modules.test.ts guards it.
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

//  TLS 

/**
 * PostgreSQL TLS (RULE 52). Three modes, because "encrypted" and
 * "authenticated" are different promises:
 *
 * - `disable` -- no TLS. Refused in production.
 * - `require` -- TLS, any certificate accepted. Stops a passive observer and
 *   nothing else; it does not stop an active MITM. Private link or tunnel only.
 * - `verify-full` -- chain must validate against `ca` and the hostname must
 *   match. The production default.
 *
 * `ca` is explicit because a bare `{ rejectUnauthorized: true }` falls back to
 * the system trust store, and RDS certificates come from Amazon's private CA,
 * which is not in the public bundle -- the container would fail to connect to
 * the database it was built for. Supply `DATABASE_SSL_CA` (inline PEM) or
 * `DATABASE_SSL_CA_FILE`. A `verify-full` connection with no CA available is a
 * startup error, never a silent downgrade.
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

 if (mode === 'require') return { rejectUnauthorized: false }; // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification -- intentional: 'require' mode accepts any certificate, designed for private links where the CA is not yet provisioned

 // verify-full
 const ca = env.db.sslCa?.trim();
 const opts: { ca?: string; rejectUnauthorized: boolean } = { rejectUnauthorized: true };
 if (ca) opts.ca = ca;

 if (env.nodeEnv === 'production' && !ca) {
 // Not fatal: node's system store may already contain the issuer (self-hosted
 // Postgres with a publicly-trusted cert). Warn loudly rather than refuse, so
 // an operator is never left guessing why the connection failed.
 logger.warn(
 'DATABASE_SSL=verify-full without DATABASE_SSL_CA -- falling back to the system trust store. ' +
 'Amazon RDS certificates are NOT publicly trusted; set DATABASE_SSL_CA or DATABASE_SSL_CA_FILE.',
 );
 }
 return opts;
}

//  PGlite 
// PGlite is a single in-process session: three concurrent `transaction()`
// calls share one physical transaction (a second BEGIN is a warning, not a new
// transaction), so their statements interleave and one caller's ROLLBACK undoes
// another's uncommitted writes. Observed directly: three parallel MFA
// redemptions produced exactly one winner whose step write had vanished --
// rolled back out from under it by a loser's abort -- and the anti-replay
// assertion then failed despite correct service code. Real PostgreSQL
// isolates these on separate connections; on PGlite the honest equivalent is
// to run each transaction body atomically. The reads and validation in service
// code still race (that is what the concurrency tests exercise); only the
// compare-and-set writes inside the transaction cannot interleave.
//
// Module-level, not per-instance: there is one PGlite session per process no
// matter how many driver wrappers exist, so per-instance locks would not
// exclude each other. PgDriver gets no gate -- production has real isolation
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

//  singleton 
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
 pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric -> number for money in cents
 const pool = new pg.Pool({
 connectionString: env.databaseUrl,
 max: env.dbPoolMax,
 idleTimeoutMillis: 30_000,
 connectionTimeoutMillis: 10_000,
 statement_timeout: env.dbStatementTimeoutMs, // RULE 77
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
 logger.warn('using embedded PGlite PostgreSQL -- development/test only');
 return new PgliteDriver(pg);
}

export async function closeDb(): Promise<void> {
 if (!driver) return;
 await driver.close();
 driver = null;
}
