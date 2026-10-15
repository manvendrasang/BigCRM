/**
 * Durable queue tests.
 *
 * The properties that matter are all about concurrent execution:
 * 1. Two claimants cannot win the same row (the SKIP LOCKED contract).
 * 2. Failure re-queues with backoff; the budget going terminal is observable.
 * 3. An unknown type fails its job without killing the worker.
 * 4. enqueue validates its inputs rather than storing garbage.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { getDb } from '../../db/driver.ts';
import {
 backoffForAttempt,
 claimNext,
 clearHandlers,
 complete,
 enqueue,
 fail,
 registerHandler,
 runWorkerOnce,
 __testing,
} from '../../services/queue.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 130)}`;
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l}${detail}`); }
};
type Attempt<T> = { ok: true; v: T } | { ok: false; e: any };
const attempt = async <T>(fn: () => Promise<T>): Promise<Attempt<T>> => {
 try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, e }; }
};

const db = await getDb();
const rowOf = async (id: string) =>
 (await db.query<{ status: string; attempts: number; last_error: string | null }>(
 'SELECT status, attempts, last_error FROM job_queue WHERE id = $1', [id])).rows[0]!;

console.log('\n=== enqueue validates ===');
{
 const id = await enqueue({ type: 'welcome_email', payload: { userId: 'u1' } });
 T('enqueue returns an id', typeof id === 'string' && id.length > 0, id);

 const badType = await attempt(() => enqueue({ type: ' ' }));
 T('an empty type is refused', !badType.ok, badType);

 const badBudget = await attempt(() => enqueue({ type: 'x', maxAttempts: 99 }));
 T('an absurd budget is refused', !badBudget.ok, badBudget);

 const badDate = await attempt(() => enqueue({ type: 'x', runAt: 'whenever' }));
 T('an unparsable run time is refused', !badDate.ok, badDate);

 const future = await enqueue({ type: 'x', runAt: new Date(Date.now() + 3_600_000).toISOString() });
 T('a future job is not claimable yet', (await claimNext('w1'))?.id !== future);
 await db.query(`DELETE FROM job_queue WHERE id = $1`, [future]);
 await db.query(`DELETE FROM job_queue WHERE id = $1`, [id]);
}

console.log('\n=== claim, complete, fail ===');
{
 const id = await enqueue({ type: 't', payload: { n: 1 } });
 const claimed = await claimNext('worker-a');
 T('a queued job is claimed', claimed?.id === id, claimed?.id);
 T('attempts increment on claim', (await rowOf(id)).attempts === 1);

 const again = await claimNext('worker-b');
 T('a claimed job is not claimable again', again === null, again);

 await complete(id);
 T('completion is terminal', (await rowOf(id)).status === 'completed');

 const failing = await enqueue({ type: 't', maxAttempts: 2 });
 await claimNext('worker-a');
 await fail(failing, new Error('boom'));
 const afterFirst = await rowOf(failing);
 T('a failure re-queues within budget', afterFirst.status === 'queued', afterFirst.status);
 T('the error is recorded', (afterFirst.last_error ?? '').includes('boom'), afterFirst.last_error);

 // Second failure exhausts maxAttempts = 2.
 const reclaimed = await (async () => {
 // Backoff hides the row; lift the lease the way time would.
 await db.query(`UPDATE job_queue SET run_at = now() WHERE id = $1`, [failing]);
 return claimNext('worker-a');
 })();
 T('the backed-off job becomes claimable again', reclaimed?.id === failing);
 await fail(failing, new Error('boom again'));
 T('the budget going terminal is observable', (await rowOf(failing)).status === 'failed');
}

console.log('\n=== concurrent claimants ===');
{
 const id = await enqueue({ type: 't' });
 const results = await Promise.all([
 claimNext('worker-a'), claimNext('worker-b'), claimNext('worker-c'),
 ]);
 const winners = results.filter((r) => r !== null);
 T('exactly one claimant wins the row', winners.length === 1, winners.length);
 await complete(id);
}

console.log('\n=== worker dispatch ===');
{
 clearHandlers();
 const seen: string[] = [];
 registerHandler('greet', async (job) => {
 seen.push(String(job.payload['who'] ?? ''));
 });

 const id = await enqueue({ type: 'greet', payload: { who: 'ava' } });
 const ran = await runWorkerOnce('worker-a');
 T('the handler ran with the payload', ran?.id === id && seen.join(',') === 'ava', seen);
 T('success completes the job', (await rowOf(id)).status === 'completed');

 const throwing = await enqueue({ type: 'greet', payload: { who: 'x' } });
 clearHandlers();
 registerHandler('greet', async () => { throw new Error('handler blew up'); });
 await runWorkerOnce('worker-a');
 T('a throwing handler fails rather than crashing the loop',
 (await rowOf(throwing)).status === 'queued');

 const unknown = await enqueue({ type: 'nope' });
 await runWorkerOnce('worker-a');
 T('an unregistered type fails its job', (await rowOf(unknown)).status === 'queued');
 clearHandlers();

 T('backoff schedule is 30s, 5m, 30m, then 3h capped',
 [backoffForAttempt(1), backoffForAttempt(2), backoffForAttempt(3), backoffForAttempt(4), backoffForAttempt(99)]
 .join(',') === [30_000, 300_000, 1_800_000, 10_800_000, 10_800_000].join(','));
 T('BACKOFF_MS matches', __testing.BACKOFF_MS.length === 4);
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
