/**
 * Test runner. Each suite runs in a fresh child process so it gets a clean
 * database, and only observed results are reported (RULE 5).
 *
 *   node --experimental-strip-types --env-file=.env.test src/tests/run.ts
 */
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Files excluded from `tsconfig.json` are not part of the build, so they must not
 * be part of the test run either. Deriving this from tsconfig rather than a
 * hardcoded list means a file disabled in one place cannot still be executed in
 * another — which is exactly what happened to `unit/mongodb.test.ts`: commented
 * out and excluded from typecheck, yet still spawned as a suite and reported as
 * a failing test.
 *
 * tsconfig files are JSONC (they carry comments), so comments are stripped
 * before parsing — the same approach as `unit/modules.test.ts:readJsonc`.
 */
const disabled = new Set<string>(
  (JSON.parse(
    (await readFile(join(HERE, '..', '..', 'tsconfig.json'), 'utf8')).replace(/^\s*\/\/.*$/gm, ''),
  ).exclude ?? [])
    .map((p: string) => resolve(HERE, '..', '..', p)),
);

const collect = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(join(HERE, dir));
    return entries
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => join(HERE, dir, f))
      .filter((f) => !disabled.has(resolve(f)))
      .sort();
  } catch { return []; }
};

const suites = [...(await collect('unit')), ...(await collect('integration')), ...(await collect('security'))];

/** Reported so a disabled suite is visible rather than silently absent. */
const skipped: string[] = [];
for (const dir of ['unit', 'integration', 'security']) {
  try {
    for (const f of await readdir(join(HERE, dir))) {
      const full = join(HERE, dir, f);
      if (f.endsWith('.test.ts') && disabled.has(resolve(full))) skipped.push(`${dir}/${f}`);
    }
  } catch { /* directory may not exist */ }
}
if (skipped.length) {
  console.log(`SKIPPED (excluded from tsconfig): ${skipped.join(', ')}\n`);
}

const run = (file: string) => new Promise<{ code: number; out: string; err: string; ms: number }>((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', file],
    { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { err += String(d); });
  child.on('close', (code) => resolve({ code: code ?? -1, out, err, ms: Date.now() - started }));
});

let totalPass = 0; let totalFail = 0;
const failed: string[] = [];
console.log(`Running ${suites.length} suite(s)\n${'='.repeat(72)}`);

for (const file of suites) {
  const name = relative(HERE, file);
  const r = await run(file);
  const pm = /\b(\d+) passed/.exec(r.out);
  const fm = /\b(\d+) failed/.exec(r.out);
  totalPass += Number(pm?.[1] ?? 0);
  totalFail += Number(fm?.[1] ?? 0);
  console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${name.padEnd(36)} ${String(pm?.[1] ?? '?').padStart(4)} assertions  ${r.ms}ms`);
  if (r.code !== 0) {
    failed.push(name);
    for (const l of (r.out + '\n' + r.err).split('\n')
      .filter((x) => /\[FAIL\]|Error:|error:|AssertionError/i.test(x)).slice(0, 8)) {
      console.log(`      ${l.trim().slice(0, 150)}`);
    }
  }
}

console.log('='.repeat(72));
console.log(`TOTAL: ${totalPass} assertions passed, ${totalFail} failed across ${suites.length} suites`);
if (failed.length) { console.log(`FAILED SUITES:\n - ${failed.join('\n - ')}`); process.exit(1); }
