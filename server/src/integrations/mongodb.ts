/*
 * ============================================================================
 *  DISABLED — MongoDB Atlas integration. Not imported, not built, not tested.
 * ============================================================================
 *
 *  Decision (2026-10-11): PostgreSQL 17 is the system of record and the only
 *  database this service will use. MongoDB is commented out rather than deleted
 *  because RULE 6 forbids silently dropping a requirement — the reasoning is
 *  preserved here so the decision can be revisited deliberately rather than
 *  rediscovered.
 *
 *  Why it was never made the primary store: the schema depends on 89 foreign
 *  keys, 53 CHECK constraints, a composite foreign key ("a deal's stage must
 *  belong to its pipeline") and an append-only audit trigger. MongoDB provides
 *  none of them. Moving the CRM core there would have traded *enforced* tenant
 *  isolation for *asserted* isolation — precisely the defect class catalogued
 *  from both legacy repositories in docs/PROJECT_AUDIT.md.
 *
 *  State before it was disabled:
 *    - 24 assertions covered URI validation and secret redaction and passed
 *    - `npm run atlas:ping` was implemented but NEVER SUCCEEDED: no credentials
 *      were supplied and this host was never allowlisted in Atlas Network Access
 *    - no live connection has ever been made to a MongoDB cluster
 *
 *  The `mongodb` npm package has been REMOVED from package.json, so this file
 *  cannot even be un-commented without re-adding it:
 *      npm i mongodb@^6 --workspace @bigcrm/server
 *
 *  To restore: uncomment this file, the `mongodb` block in config/env.ts, the
 *  `atlas:ping` command in db/cli.ts, the health probe in index.ts, and
 *  src/tests/unit/mongodb.test.ts — then re-add the dependency above.
 * ============================================================================
 */

/**
 * MongoDB Atlas document-store provider (RULE 162 `StorageProvider` sibling).
 *
 * ── Why this exists, and why it is NOT the primary store ────────────────────
 *
 * BigCRM's system of record is PostgreSQL. That is a deliberate security
 * decision, not a default: the schema leans on guarantees MongoDB cannot
 * provide —
 *
 *   • 89 foreign keys        → MongoDB has no referential integrity; a dangling
 *                              company_id or stage_id becomes silently possible
 *   • 53 CHECK constraints   → domain invariants (valid enum, non-negative money,
 *                              completed ⟺ completed_at) would move to app code
 *   • composite FK           → "a deal's stage must belong to its pipeline" is
 *                              expressible in PostgreSQL and *not* in MongoDB
 *   • append-only trigger    → audit tamper-evidence is a database guarantee;
 *                              in MongoDB it would become an application promise
 *   • runtime tenant guard   → `assertTenantPredicate()` is SQL-aware
 *
 * Replacing the system of record with a document store would trade
 * *enforced* isolation for *asserted* isolation. `docs/PROJECT_STATUS.md` records
 * that trade as declined.
 *
 * MongoDB is therefore used where a document store is genuinely the right tool:
 * schemaless integration payloads and webhook delivery records, where documents
 * are heterogeneous by design and are never joined or constrained.
 *
 * ── Security properties ──────────────────────────────────────────────────────
 *
 *   RULE 56  the URI is a secret. It is never logged, never echoed, never
 *            included in an error message, and never returned by a health check.
 *   RULE 52  TLS is mandatory. `mongodb+srv` implies TLS; `mongodb://` is
 *            refused unless an explicit override is set, because Atlas without
 *            TLS transmits credentials in clear.
 *   RULE 88  the endpoint is validated before a connection is attempted, so a
 *            misconfigured URI cannot be pointed at an internal host.
 *   RULE 77  bounded server selection, connect timeout and socket timeout — a
 *            hung Atlas must not hang a request.
 *   RULE 8   one shared client with a bounded pool, not a client per request.
 */
import { MongoClient, type Collection, type Db, type Document } from 'mongodb';
import { env } from '../config/env.ts';
import { logger, securityLog } from '../lib/logger.ts';
import { newId } from '../lib/ids.ts';

let client: MongoClient | null = null;
let db: Db | null = null;

/** Redacts any credential in a connection string so it can be logged safely. */
export function redactMongoUri(uri: string): string {
  return String(uri)
    .replace(/^(mongodb(?:\+srv)?:\/\/)[^@/]*@/i, '$1<redacted>@')
    .replace(/\?.*$/, (q) => (q.length > 1 ? '?<redacted-options>' : ''));
}

export type MongoVerdict = { ok: true; hosts: string[]; database: string } | { ok: false; reason: string };

/**
 * Validates a MongoDB URI before any network activity. `mongodb+srv` resolves
 * to a cluster through DNS; a `mongodb://` URI must name at least one host.
 */
export function validateMongoUri(uri: string): MongoVerdict {
  if (typeof uri !== 'string' || uri.trim() === '') return { ok: false, reason: 'MONGODB_URI is not set.' };
  const u = uri.trim();

  const isSrv = u.startsWith('mongodb+srv://');
  const isPlain = u.startsWith('mongodb://');
  if (!isSrv && !isPlain) {
    return { ok: false, reason: 'MONGODB_URI must use the mongodb:// or mongodb+srv:// scheme.' };
  }
  if (isPlain && !env.mongodb.allowInsecure) {
    return {
      ok: false,
      reason: 'mongodb:// (unencrypted) is refused. Use mongodb+srv:// or set MONGODB_ALLOW_INSECURE=true for a local replica only.',
    };
  }

  let parsed: URL;
  try {
    // `mongodb+srv` is not a WHATWG scheme; normalise so URL can parse it.
    parsed = new URL(u.replace(/^mongodb\+srv:\/\//i, 'mongodb://'));
  } catch {
    return { ok: false, reason: 'MONGODB_URI is malformed.' };
  }
  if (!parsed.hostname) return { ok: false, reason: 'MONGODB_URI names no host.' };
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'MONGODB_URI must not embed credentials; they belong in MONGODB_USERNAME / MONGODB_PASSWORD.' };
  }
  // Defence in depth: this must not be used to reach an internal host.
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'MONGODB_URI host is not permitted.' };
  }
  const ports = parsed.port ? [Number(parsed.port)] : [];
  for (const p of ports) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, reason: 'MONGODB_URI has an invalid port.' };
  }
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName) return { ok: false, reason: 'MONGODB_URI names no database.' };
  return { ok: true, hosts: [parsed.hostname], database: dbName };
}

/**
 * Builds the effective URI from parts. Credentials come from dedicated
 * variables so they are never part of the URI that gets logged or displayed.
 */
export function buildMongoUri(): string {
  const base = env.mongodb.uri.trim();
  const user = encodeURIComponent(env.mongodb.username);
  const pass = encodeURIComponent(env.mongodb.password);
  const scheme = base.startsWith('mongodb+srv://') ? 'mongodb+srv://' : 'mongodb://';
  const rest = base.replace(/^mongodb(\+srv)?:\/\//i, '');
  const creds = env.mongodb.username || env.mongodb.password ? `${user}:${pass}@` : '';
  return `${scheme}${creds}${rest}`;
}

export type MongoHealth = { ok: boolean; detail: string; latencyMs: number };

/** Connects once and caches the client. Idempotent. */
export async function getMongo(): Promise<{ client: MongoClient; db: Db }> {
  if (client && db) return { client, db };

  const verdict = validateMongoUri(env.mongodb.uri);
  if (!verdict.ok) throw new Error(`[mongodb] ${verdict.reason}`);
  if (!env.mongodb.enabled) throw new Error('[mongodb] integration is disabled (MONGODB_ENABLED=false).');

  const uri = buildMongoUri();
  logger.info({ uri: redactMongoUri(uri), database: verdict.database }, 'connecting to mongodb');

  client = new MongoClient(uri, {
    // RULE 8: one bounded pool, not a client per request.
    maxPoolSize: env.mongodb.maxPoolSize,
    minPoolSize: env.mongodb.minPoolSize,
    maxIdleTimeMS: env.mongodb.maxIdleTimeMs,
    waitQueueTimeoutMS: env.mongodb.waitQueueTimeoutMs,
    serverSelectionTimeoutMS: env.mongodb.serverSelectionTimeoutMs,
    connectTimeoutMS: env.mongodb.connectTimeoutMs,
    socketTimeoutMS: env.mongodb.socketTimeoutMs,
    // RULE 52: never silently accept a bad certificate.
    tls: env.mongodb.tlsAllowInvalidCertificates ? undefined : env.mongodb.uri.startsWith('mongodb+srv'),
    appName: `bigcrm-${env.envName}`,
    retryWrites: true,
    retryReads: true,
    compressors: ['zlib'],
  });

  await client.connect();
  db = client.db(verdict.database);

  await ensureIndexes(db);
  securityLog('integration.mongodb_connected', { database: verdict.database, env: env.envName });
  logger.info({ database: verdict.database }, 'mongodb connected');
  return { client, db };
}

/**
 * Indexes are declared, never created ad hoc. Every collection that holds tenant
 * data starts with `organization_id` so the same leading-column convention as
 * PostgreSQL applies here too.
 */
async function ensureIndexes(db: Db): Promise<void> {
  const spec: [string, Document][] = [
    ['integration_payloads', { key: { organization_id: 1, created_at: -1 }, name: 'org_created' }],
    ['integration_payloads', { key: { organization_id: 1, idempotency_key: 1 }, name: 'org_idempotency', unique: true }],
    ['webhook_records', { key: { organization_id: 1, created_at: -1 }, name: 'org_created' }],
    ['webhook_records', { key: { organization_id: 1, endpoint_id: 1, created_at: -1 }, name: 'org_endpoint' }],
  ];
  for (const [name, opts] of spec) {
    try {
      await db.collection(name).createIndex(opts.key as Record<string, 1 | -1>, { name: String(opts.name), unique: opts.unique === true });
    } catch (err) {
      logger.error({ err, collection: name }, 'mongodb index creation failed');
    }
  }
}

/** Namespaced, tenant-scoped collection accessor. `organizationId` is required. */
export function scopedCollection<T extends Document = Document>(
  db: Db,
  name: string,
  organizationId: string,
): Collection<T> {
  if (!organizationId) throw new Error('[mongodb] organizationId is required for a scoped collection');
  return db.collection<T>(name);
}

/**
 * Readiness probe. Reports state and latency only — never the URI, credentials,
 * host list, or topology (RULE 118).
 */
export async function mongoHealth(): Promise<MongoHealth> {
  if (!env.mongodb.enabled) return { ok: true, detail: 'disabled', latencyMs: 0 };
  const t = Date.now();
  try {
    const { db } = await getMongo();
    await db.command({ ping: 1 });
    return { ok: true, detail: 'connected', latencyMs: Date.now() - t };
  } catch (err) {
    logger.error({ err }, 'mongodb health check failed');
    return { ok: false, detail: 'unreachable', latencyMs: Date.now() - t };
  }
}

/** Diagnostics for `atlas:ping`. Still redacted. */
export async function mongoDiagnostics(): Promise<{
  ok: boolean; detail: string; version?: string; database?: string; collections?: string[]; error?: string;
}> {
  if (!env.mongodb.enabled) return { ok: false, detail: 'MONGODB_ENABLED is false' };
  const verdict = validateMongoUri(env.mongodb.uri);
  if (!verdict.ok) return { ok: false, detail: verdict.reason };
  try {
    const { db } = await getMongo();
    const info = await db.command({ buildInfo: 1 });
    const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    return {
      ok: true,
      detail: 'connected',
      version: String((info as { version?: string }).version ?? 'unknown'),
      database: db.databaseName,
      collections,
    };
  } catch (err) {
    return { ok: false, detail: 'connection failed', error: redactMongoError(err) };
  }
}

/**
 * MongoDB driver errors embed the full connection string, including the
 * password, in `error.message`. Nothing from the driver is ever surfaced
 * verbatim.
 */
export function redactMongoError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/mongodb(\+srv)?:\/\/[^@\s"']+@/gi, 'mongodb://<redacted>@')
    .replace(/\/\/[^:@\s/]+:[^@\s/]+@/g, '//<redacted>@')
    .split('\n')[0]!
    .slice(0, 240);
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close().catch(() => undefined);
    client = null;
    db = null;
    logger.info('mongodb connection closed');
  }
}

export const __testOnly = { newId };