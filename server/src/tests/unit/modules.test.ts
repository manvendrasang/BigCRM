/**
 * Module loadability.
 *
 * Every other suite imports the modules it exercises. A module that nothing
 * imports is therefore never parsed, and can carry a defect indefinitely --
 * `src/integrations/email.ts` sat there with a TypeScript parameter property
 * (`constructor(private readonly url: string)`) for the whole project. Typecheck
 * accepted it; `npm test` passed 213 assertions; CI typechecked and tested green.
 * It would have thrown `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` the moment a route
 * imported it, which is precisely when a production API needs it to work.
 *
 * This suite imports every non-test source file, so an unparseable or
 * unloadable module fails here instead of at boot. It is a cheap, total guard
 * against an entire class of "written but never executed" defect.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l} -> ${typeof x === 'string' ? x.slice(0, 150) : String(x ?? '').slice(0, 150)}`); }
};

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function walk(dir: string): Promise<string[]> {
 const out: string[] = [];
 for (const entry of await readdir(dir, { withFileTypes: true })) {
 const full = join(dir, entry.name);
 if (entry.isDirectory()) {
 if (entry.name === 'tests') continue; // suites import themselves
 if (entry.name === 'node_modules') continue;
 out.push(...await walk(full));
 } else if (entry.name.endsWith('.ts')) {
 out.push(full);
 }
 }
 return out.sort();
}

/**
 * tsconfig files are JSONC, not JSON -- they carry comments. `JSON.parse` rejects
 * them, so comments are stripped before parsing. The values under test (exclude
 * lists) are plain arrays and are unaffected.
 */
async function readJsonc(path: string): Promise<Record<string, unknown>> {
 const raw = await readFile(path, 'utf8');
 return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>;
}

/** Narrow a parsed config value to a string array, defaulting to empty. */
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const files = await walk(SRC);
T('the source tree was discovered', files.length > 20, `${files.length} files`);

/**
 * Files deliberately disabled -- preserved as commented source, excluded from
 * `tsconfig.json`, and never imported. They are reported separately so a reader
 * can tell "disabled on purpose" apart from "accidentally broken".
 */
const DISABLED = new Set(['integrations/mongodb.ts', 'tests/unit/mongodb.test.ts']);
const DISABLED_MARKER = 'DISABLED -- MongoDB Atlas integration';

console.log('\n=== disabled files are inert, not merely commented ===');
{
 for (const rel of DISABLED) {
 const full = join(SRC, rel);
 let present = false;
 let marked = false;
 let noTopLevelImport = false;
 try {
 const src = await readFile(full, 'utf8');
 present = true;
 marked = src.includes(DISABLED_MARKER);
 // A file that is entirely inside a block comment has no executable
 // statement before the comment closes.
 const closeIdx = src.indexOf('*/');
 noTopLevelImport = closeIdx >= 0 && !/^\s*import\s/m.test(src.slice(0, closeIdx));
 } catch { /* absent is also acceptable */ }
 T(`${rel} carries the DISABLED banner`, marked, rel);
 T(`${rel} contains no executable import`, noTopLevelImport, rel);
 void present;
 }
 const tsconfig = await readJsonc(join(SRC, '..', 'tsconfig.json'));
 const excluded = strArray(tsconfig.exclude);
 T('both disabled files are excluded from typecheck',
 [...DISABLED].every((f) => excluded.includes(`src/${f}`)), excluded);

 // `include`/`exclude` do not inherit through `extends` the way one expects:
 // restating `include` in a child config replaces the parent's, so the build
 // config has to restate `exclude` too. When it did not, `npm run typecheck`
 // stayed green while `npm run build` failed on the disabled sources -- the image
 // build broke with a passing typecheck, which is the combination easiest to
 // miss and most expensive to discover late.
 const buildTsconfig = await readJsonc(join(SRC, '..', 'tsconfig.build.json'));
 const buildExcluded = strArray(buildTsconfig.exclude);
 T('the BUILD config also excludes the disabled sources',
 [...DISABLED].every((f) => buildExcluded.includes(`src/${f}`)), buildExcluded);
 T('the build config excludes tests, so the suite is not shipped',
 buildExcluded.some((e) => e.includes('tests')), buildExcluded);

 const pkg = await readJsonc(join(SRC, '..', 'package.json'));
 const deps = { ...(pkg.dependencies as Record<string, unknown> | undefined), ...(pkg.devDependencies as Record<string, unknown> | undefined) };
 T('the mongodb package is not installed', !('mongodb' in deps), Object.keys(deps).join(','));

 const envSrc = await readFile(join(SRC, 'config', 'env.ts'), 'utf8');
 T('config/env.ts has no mongodb block', !/mongodb:\s*\{/.test(envSrc));
 const idxSrc = await readFile(join(SRC, 'index.ts'), 'utf8');
 T('index.ts does not probe or close a mongo connection',
 !/getMongo|closeMongo|mongoHealth/.test(idxSrc));
 const cliSrc = await readFile(join(SRC, 'db', 'cli.ts'), 'utf8');
 T('the atlas:ping CLI command is gone', !/atlas:ping/.test(cliSrc));
}

console.log('\n=== every ACTIVE module loads under --experimental-strip-types ===');
const failures: string[] = [];
let active = 0;
for (const file of files) {
 const rel = relative(SRC, file).replace(/\\/g, '/');
 if (DISABLED.has(rel)) continue;
 // `index.ts` starts a server and `db/cli.ts` executes a command on import;
 // both are exercised for real elsewhere (integration/http.test.ts and
 // `npm run migrate`). Importing them here would start a listener.
 if (rel === 'index.ts' || rel === 'db/cli.ts') continue;
 active++;
 try {
 await import(pathToFileURL(file).href);
 pass++;
 } catch (err) {
 failures.push(`${rel}: ${(err as Error).message.split('\n')[0]}`);
 }
}
T(`all ${active} active modules load cleanly`, failures.length === 0, failures.join(' | '));
T('at least 30 modules are active', active >= 30, active);

console.log('\n=== syntax Node cannot strip is banned repo-wide ===');
{
 // Parameter properties are erased at compile time by tsc but are a hard error
 // for Node's type-stripping loader. Catching them textually means the rule is
 // enforced even for files no test imports.
 const offenders: string[] = [];
 for (const file of files) {
 const src = await readFile(file, 'utf8');
 // Strip comments so the rule in email.ts explaining this does not trip it.
 const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
 if (/constructor\s*\([^)]*\b(private|public|protected|readonly)\b/.test(code)) {
 offenders.push(relative(SRC, file));
 }
 }
 T('no TypeScript parameter properties anywhere in src/', offenders.length === 0, offenders.join(', '));
}

console.log('\n=== no relative import is missing its .ts extension ===');
{
 const offenders: string[] = [];
 for (const file of files) {
 const src = await readFile(file, 'utf8');
 const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
 for (const m of code.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
 const spec = m[1]!;
 // Node resolves relative specifiers literally; `./foo.js` does not map
 // to `./foo.ts` under type stripping, and `./foo` does not either.
 if (!spec.endsWith('.ts')) offenders.push(`${relative(SRC, file)} -> ${spec}`);
 }
 }
 T('every relative import carries an explicit .ts extension', offenders.length === 0, offenders.slice(0, 4).join(', '));
}

console.log('\n=== no secret is committed in source ===');
{
 // A cheap guard against the exact class of leak the audit catalogue records in
 // the two legacy repos. Pattern-based, so it is a backstop, not a substitute
 // for gitleaks, which CI also runs.
 const patterns: [string, RegExp][] = [
 ['mongodb+srv with inline credentials', /mongodb(?:\+srv)?:\/\/[^:@\s/]+:[^@\s/]+@/i],
 ['postgres URL with inline password', /postgres(?:ql)?:\/\/[^:@\s/]+:[^@\s/]+@(?![\s\S]{0,40}(?:example|localhost|127\.0\.0\.1))/i],
 ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
 ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
 ['hard-coded JWT secret', /JWT_(?:ACCESS|REFRESH)_SECRET\s*=\s*['"][^'"\s]{20,}/],
 ];
 const hits: string[] = [];
 for (const file of files) {
 const src = await readFile(file, 'utf8');
 for (const [label, re] of patterns) {
 if (re.test(src)) hits.push(`${label} in ${relative(SRC, file)}`);
 }
 }
 T('no credential-shaped literal in any source file', hits.length === 0, hits.join(' | '));
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
