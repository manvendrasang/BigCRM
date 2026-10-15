#!/usr/bin/env node
/**
 * Load / performance harness (item 5).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Every latency figure in docs/ was either inherited from a frozen repo or
 * absent. Nothing in this codebase had ever been measured under concurrency, so
 * "production-grade" was an assertion with no number behind it. This produces
 * the numbers, and does it against the real production image talking to real
 * PostgreSQL over `verify-full` -- not PGlite, where an in-process WASM database
 * would report latencies that describe nothing about deployment.
 *
 * ── What it measures, and what it deliberately does not ──────────────────────
//
 * Measured: throughput (req/s), and latency percentiles p50/p90/p95/p99/max,
 * per endpoint and overall. Percentiles rather than a mean, because a mean
 * hides exactly the tail that users complain about: 99 fast responses and one
 * at 2 s average to 30 ms.
 *
 * Not measured: anything on the write path at volume. This harness is read-only
 * by design. A load test that creates rows makes the *next* run slower, so the
 * second run is not comparable to the first, and a benchmark that quietly
 * degrades its own fixture is worse than no benchmark. Writes are covered by
 * the correctness suite; sustained write throughput needs a dedicated seeded
 * environment and is recorded as unmeasured rather than guessed.
 *
 * ── Honest limits of this tool ───────────────────────────────────────────────
 *
 * It runs on the same host as the target, so it measures the application and
 * database, not a network. Real client latency adds RTT and TLS on top. The
 * numbers here are therefore a *floor* on production latency, and the report
 * says so rather than presenting them as what a user will see.
 *
 * Usage:
 * node --env-file=/tmp/load.env infra/scripts/load-test.mjs
 *
 * Env:
 * LOAD_BASE_URL e.g. https://localhost:3200 (default http://127.0.0.1:3200)
 * LOAD_EMAIL owner account email
 * LOAD_PASSWORD its password
 * LOAD_DURATION seconds per scenario (default 10)
 * LOAD_CONCURRENCY parallel workers (default 20)
 * LOAD_WARMUP seconds of unrecorded traffic (default 3)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', '..', 'docs', 'evidence');

const BASE = (process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3200').replace(/\/$/, '');
const EMAIL = process.env.LOAD_EMAIL ?? 'owner1@seed.test';
const PASSWORD = process.env.LOAD_PASSWORD ?? 'Seed-Password-Strong!42';
const DURATION_MS = Number(process.env.LOAD_DURATION ?? 10) * 1000;
const WARMUP_MS = Number(process.env.LOAD_WARMUP ?? 3) * 1000;
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);

// The CSRF guard (`middleware/security.ts`) treats a state-changing request
// with no Origin as hostile, and rejects one whose Origin is not in
// APP_ORIGINS. Node's fetch sends no Origin by default, so every POST would
// 403 -- including login. Sending the harness's own configured origin is what a
// real browser client does; the value defaults to the origin `load-test.sh`
// configures the target with, and can be overridden when they differ.
const ORIGIN = process.env.LOAD_ORIGIN ?? 'https://app.load.example';

// ── reporting primitives ─────────────────────────────────────────────────────

/**
 * Percentile by nearest-rank on a sorted array.
 *
 * Nearest-rank rather than interpolation: with a few thousand samples the two
 * agree closely, and nearest-rank never invents a latency that was not
 * observed. An interpolated p99 can report a value between two real requests.
 */
function percentile(sorted, p) {
 if (sorted.length === 0) return NaN;
 const rank = Math.ceil((p / 100) * sorted.length);
 return sorted[Math.min(rank, sorted.length) - 1];
}

const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} ms` : 'n/a');

class Recorder {
 constructor() { this.latencies = []; this.errors = new Map(); this.ok = 0; }
 record(msTaken, status) {
 this.latencies.push(msTaken);
 if (status >= 200 && status < 400) { this.ok++; return; }
 const key = String(status);
 this.errors.set(key, (this.errors.get(key) ?? 0) + 1);
 }
 get total() { return this.latencies.length; }
 summary(seconds) {
 const s = [...this.latencies].sort((a, b) => a - b);
 const totalErr = [...this.errors.values()].reduce((a, b) => a + b, 0);
 return {
 requests: this.total,
 ok: this.ok,
 errors: Object.fromEntries(this.errors),
 errorRate: this.total ? totalErr / this.total : 0,
 rps: seconds > 0 ? this.total / seconds : 0,
 p50: percentile(s, 50),
 p90: percentile(s, 90),
 p95: percentile(s, 95),
 p99: percentile(s, 99),
 max: s.length ? s[s.length - 1] : NaN,
 min: s.length ? s[0] : NaN,
 };
 }
}

// ── auth ─────────────────────────────────────────────────────────────────────

async function login() {
 const res = await fetch(`${BASE}/api/v1/auth/login`, {
 method: 'POST',
 headers: { 'content-type': 'application/json', origin: ORIGIN },
 body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
 });
 if (!res.ok) {
 throw new Error(
 `login failed: ${res.status} ${await res.text().catch(() => '')}\n` +
 ` target: ${BASE}\n` +
 ` user: ${EMAIL}\n` +
 ' Is the load container running against a seeded database?',
 );
 }
 const body = await res.json();
 const token = body?.data?.accessToken ?? body?.accessToken ?? body?.data?.token;
 if (!token) throw new Error(`login response carried no access token: ${JSON.stringify(body).slice(0, 300)}`);
 return token;
}

// ── scenarios ────────────────────────────────────────────────────────────────
//
// Each scenario is a description plus a request builder. They are the queries a
// CRM actually serves: list a record type with pagination and a tenant scope,
// fetch one record, and the two probes every orchestrator hits. Read-only, per
// the note at the top of this file.

const scenarios = (token) => [
 {
 name: 'health (no auth, no db)',
 note: 'Baseline for framework overhead alone. Any latency here is Express, not PostgreSQL.',
 request: () => ({ url: `${BASE}/health`, init: {} }),
 },
 {
 name: 'list contacts (first page)',
 note: 'The workhorse query: paginated, tenant-scoped, sorted.',
 request: () => ({
 url: `${BASE}/api/v1/contacts?limit=50&offset=0`,
 init: { headers: { authorization: `Bearer ${token}` } },
 }),
 },
 {
 name: 'list contacts (deep page)',
 note: 'Offset pagination degrades with depth. This is where a missing index shows up first.',
 request: () => ({
 url: `${BASE}/api/v1/contacts?limit=50&offset=1000`,
 init: { headers: { authorization: `Bearer ${token}` } },
 }),
 },
 {
 name: 'list deals (first page)',
 note: 'Second tenant-scoped list, to check the behaviour is not specific to one table.',
 request: () => ({
 url: `${BASE}/api/v1/deals?limit=50&offset=0`,
 init: { headers: { authorization: `Bearer ${token}` } },
 }),
 },
 {
 name: 'current org + membership',
 note: 'Auth path: token verification and the tenant lookup that every request performs.',
 request: () => ({
 // `/api/v1/org/` is the organisation itself; `/api/v1/auth/me` is the
 // user. Hitting the org exercises the tenant resolution every other
 // request depends on.
 url: `${BASE}/api/v1/org/`,
 init: { headers: { authorization: `Bearer ${token}` } },
 }),
 },
 // ── Second wave (2026-10-12) ───────────────────────────────────────────────
 // Without these the numbers below describe an API that no longer exists:
 // reports aggregate across records, and the audit log is the one endpoint
 // whose row count grows without bound as the system is used, so it is the
 // most likely of the new reads to degrade under sustained traffic.
 {
 name: 'reports overview',
 note: 'Cross-record aggregation -- the heaviest new read path.',
 request: () => ({
 url: `${BASE}/api/v1/reports/overview`,
 init: { headers: { authorization: `Bearer ${token}` } },
 }),
 },
 {
 name: 'audit log page',
 note: 'Append-only table. Grows for the life of the deployment; index quality matters here.',
 request: () => ({
 url: `${BASE}/api/v1/org/audit-logs?limit=25&offset=0`,
 init: { headers: { authorization: `Bearer ${token}` } },
 }),
 },
 {
 name: 'notifications',
 note: 'Org-AND-user scoped read with an unread aggregate.',
 request: () => ({
 url: `${BASE}/api/v1/notifications`,
 init: { headers: { authorization: `Bearer ${token}` } },
 }),
 },
 {
 name: 'saved views',
 note: 'Small per-user set; included to confirm the added routes do not tax the auth path.',
 request: () => ({
 url: `${BASE}/api/v1/views?entityType=contacts`,
 init: { headers: { authorization: `Bearer ${token}` } },
 }),
 },
 // ── Calendar (2026-10-14) ──────────────────────────────────────────────────
 // Two-table range read (activities + tasks) behind one endpoint -- the
 // heaviest read added since the second wave, and the one whose row counts
 // grow with meetings and dated tasks rather than staying flat.
 {
 name: 'calendar agenda',
 note: 'Month-range agenda across meetings and tasks.',
 request: () => ({
 url: `${BASE}/api/v1/calendar?from=2026-11-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z`,
 init: { headers: { authorization: `Bearer ${token}` } },
 }),
 },
];

// ── runner ───────────────────────────────────────────────────────────────────

/**
 * Drives one scenario with `CONCURRENCY` workers for `DURATION_MS`.
 *
 * A worker loop rather than a burst: each worker sends a request, records it,
 * and immediately sends the next. That models a steady arrival rate and keeps
 * the connection warm, which is what a long-lived client pool looks like. A
 * single burst would measure connection setup as much as the endpoint.
 */
async function runScenario(scenario, durationMs) {
 const rec = new Recorder();
 const deadline = Date.now() + durationMs;
 let stop = false;

 const worker = async () => {
 while (!stop && Date.now() < deadline) {
 const t0 = performance.now();
 let status = 0;
 try {
 const { url, init } = scenario.request();
 const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
 status = res.status;
 // Drain the body so the socket is fully consumed and reusable; an
 // undrained response keeps the connection busy and skews throughput.
 await res.arrayBuffer().catch(() => undefined);
 } catch (err) {
 status = err?.name === 'TimeoutError' ? 504 : 0; // 0 = connection failure
 }
 rec.record(performance.now() - t0, status);
 }
 };

 await Promise.all(Array.from({ length: CONCURRENCY }, worker));
 stop = true;
 return rec.summary(durationMs / 1000);
}

// ── main ─────────────────────────────────────────────────────────────────────

const envProbe = await fetch(`${BASE}/health`).catch(() => null);
if (!envProbe?.ok) {
 console.error(`target ${BASE} is not reachable -- start it first (see infra/scripts/load-test.sh)`);
 process.exit(2);
}

console.log(`target ${BASE}`);
console.log(`account ${EMAIL}`);
console.log(`concurrency ${CONCURRENCY}`);
console.log(`duration ${DURATION_MS / 1000}s per scenario (+${WARMUP_MS / 1000}s warmup)`);
console.log('');

const token = await login();
console.log('authenticated\n');

const list = scenarios(token);
const results = [];

for (const sc of list) {
 process.stdout.write(` ${sc.name.padEnd(32)}`);
 // Warmup traffic is discarded so the first recorded request does not pay for
 // a cold pool, a JIT tier-up, or a plan that had not been cached yet.
 await runScenario(sc, WARMUP_MS);
 const r = await runScenario(sc, DURATION_MS);
 results.push({ scenario: sc.name, note: sc.note, ...r });
 process.stdout.write(`${r.rps.toFixed(0).padStart(6)} req/s p50 ${ms(r.p50).padStart(9)} p99 ${ms(r.p99).padStart(9)}`);
 // The status breakdown is printed, not just a rate: a 100% error line that
 // says `{429: 38000}` is a rate-limit story, while `{401: 38000}` is an auth
 // story. The first version of this harness printed only the rate, and a run
 // that tripped the global limiter was indistinguishable from one with a bad
 // token until the raw responses were inspected by hand.
 if (r.errorRate > 0) process.stdout.write(` !! ${(r.errorRate * 100).toFixed(1)}% ${JSON.stringify(r.errors)}`);
 process.stdout.write('\n');
}

// ── report ───────────────────────────────────────────────────────────────────

const stamp = new Date().toISOString().slice(0, 10);
const outPath = join(OUT_DIR, `load-test-${stamp}.md`);
await mkdir(OUT_DIR, { recursive: true });

const worstP99 = results.reduce((a, b) => (b.p99 > a.p99 ? b : a), results[0]);
const totalErr = results.reduce((a, b) => a + b.errorRate, 0);

const lines = [
 '# Load / performance -- measured',
 '',
 `Run ${new Date().toISOString()} against \`${BASE}\`.`,
 `Production image, concurrency ${CONCURRENCY}, ${DURATION_MS / 1000}s per scenario after a ${WARMUP_MS / 1000}s warmup.`,
 '',
 '## Results',
 '',
 '| Scenario | req/s | p50 | p90 | p95 | p99 | max | errors |',
 '|---|---:|---:|---:|---:|---:|---:|---:|',
];
for (const r of results) {
 const err = r.errorRate > 0 ? `${(r.errorRate * 100).toFixed(1)}%` : '0';
 lines.push(
 `| ${r.scenario} | ${r.rps.toFixed(0)} | ${ms(r.p50)} | ${ms(r.p90)} | ${ms(r.p95)} | ${ms(r.p99)} | ${ms(r.max)} | ${err} |`,
 );
}

lines.push('', '## What each scenario is', '');
for (const r of results) lines.push(`- **${r.scenario}** -- ${r.note}`);

lines.push(
 '',
 '## Reading these numbers',
 '',
 `- Slowest tail: **${worstP99.scenario}** at p99 ${ms(worstP99.p99)}.`,
 `- Aggregate error rate across all scenarios: **${(totalErr / results.length * 100).toFixed(2)}%**.`,
 '',
 'Two caveats that bound what these figures mean, stated rather than assumed:',
 '',
 '1. **Same-host measurement.** The generator and the target share a machine, so',
 ' these numbers cover the application and the database, not a network. Real',
 ' client latency adds round-trip time and TLS handshakes on top. Treat these',
 ' as a floor, not as what a user will observe.',
 '2. **Read-only.** The harness issues no writes, deliberately: a benchmark that',
 ' creates rows makes its own next run slower and stops being comparable.',
 ' Sustained write throughput is therefore **unmeasured**, and is recorded as',
 ' such rather than estimated.',
 '',
 '## Reproduce',
 '',
 '```bash',
 'docker build -t bigcrm-api:final .',
 'infra/scripts/load-test.sh # starts the target, runs this, tears down',
 '```',
 '',
);

await writeFile(outPath, lines.join('\n'), 'utf8');
console.log('');
console.log(`report: ${outPath}`);

const failed = results.filter((r) => r.errorRate > 0);
if (failed.length) {
 console.error(`\n${failed.length} scenario(s) returned errors -- see the report`);
 process.exit(1);
}
