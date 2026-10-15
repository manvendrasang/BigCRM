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
 * MongoDB provider tests.
 *
 * These exercise URI validation and secret redaction — the security-relevant
 * behaviour — without needing a live Atlas cluster. A live end-to-end check is
 * `npm run atlas:ping`, which requires credentials and network allowlisting.
 */
import {
  validateMongoUri, redactMongoUri, redactMongoError, buildMongoUri,
} from '../../integrations/mongodb.ts';

let pass = 0;
const failures: string[] = [];
const T = (label: string, ok_: boolean, extra?: unknown): void => {
  if (ok_) { pass++; console.log(`  [PASS] ${label}`); }
  else { failures.push(label); console.log(`  [FAIL] ${label}${extra !== undefined ? ` -> ${String(extra).slice(0, 140)}` : ''}`); }
};

const SRV = 'mongodb+srv://cluster0.hsaqc.mongodb.net/bigcrm?appName=Cluster0&compressors=zlib';

/** Narrowing helper: returns the ok-branch or fails the assertion outright. */
function accepted(uri: string): { hosts: string[]; database: string } {
  const v = validateMongoUri(uri);
  if (!v.ok) throw new Error(`expected URI to be accepted: ${uri} (${v.reason})`);
  return v;
}

console.log('\n=== URI validation (fail closed) ===');
T('a well-formed SRV URI is accepted', validateMongoUri(SRV).ok === true);
T('the SRV hostname is extracted', accepted(SRV).hosts[0] === 'cluster0.hsaqc.mongodb.net');
T('the database name is extracted', accepted(SRV).database === 'bigcrm');
T('an empty URI is rejected', validateMongoUri('').ok === false);
T('a non-mongodb scheme is rejected', validateMongoUri('postgres://x/y').ok === false);
T('http:// is rejected', validateMongoUri('http://host/db').ok === false);
T('a malformed URI is rejected', validateMongoUri('mongodb+srv://').ok === false);
T('a URI with no database is rejected', validateMongoUri('mongodb+srv://host.example').ok === false);
T('localhost is refused (RULE 88)', validateMongoUri('mongodb://localhost:27017/db').ok === false);
T('a .local host is refused', validateMongoUri('mongodb+srv://db.internal.local/x').ok === false);
T('embedded credentials are refused — they belong in separate variables',
  validateMongoUri('mongodb+srv://user:pass@cluster0.hsaqc.mongodb.net/db').ok === false);
T('mongodb:// without TLS is refused by default',
  validateMongoUri('mongodb://db.example.io:27017/bigcrm').ok === false);

console.log('\n=== Secret redaction (RULE 56 / RULE 118) ===');
const withCreds = 'mongodb+srv://myuser:sup3rs3cret@cluster0.hsaqc.mongodb.net/bigcrm?appName=Cluster0&compressors=zlib';
const redacted = redactMongoUri(withCreds);
T('credentials are stripped from the URI', !redacted.includes('myuser') && !redacted.includes('sup3rs3cret'));
T('the scheme is preserved', redacted.startsWith('mongodb+srv://'));
T('the host is preserved for diagnostics', redacted.includes('cluster0.hsaqc.mongodb.net'));
T('query options are stripped', !redacted.includes('compressors'));
T('a credential-free URI is unchanged apart from options',
  redactMongoUri(SRV).startsWith('mongodb+srv://cluster0.hsaqc.mongodb.net/'));

const driverError = new Error(
  'MongoServerSelectionError: connection <monitor> to mongodb+srv://myuser:sup3rs3cret@cluster0.hsaqc.mongodb.net/ timed out',
);
const safeError = redactMongoError(driverError);
T('the password never survives a driver error', !safeError.includes('sup3rs3cret'));
T('the username never survives a driver error', !safeError.includes('myuser'));
T('the error is still useful', safeError.includes('MongoServerSelectionError') && safeError.includes('timed out'));
T('a plain-string error is handled', redactMongoError('boom').length > 0);

console.log('\n=== Credential assembly ===');
// buildMongoUri reads from validated config; with the test env the Mongo block is
// disabled, so assert only that it never emits a bare `undefined` credential.
const built = buildMongoUri();
T('the assembled URI has a mongodb scheme', /^mongodb(\+srv)?:\/\//.test(built), built.slice(0, 60));
T('no `undefined` leaks into the URI', !built.includes('undefined'));
T('no `null` leaks into the URI', !built.includes('null'));

console.log(`\n================ ${pass} passed, ${failures.length} failed ================`);
if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);