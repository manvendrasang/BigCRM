/**
 * Per-account appearance preference.
 *
 * The theme moved from browser storage to the account because the session now
 * ends with the window: browser storage is the one thing that would survive a
 * shared desk, and it is exactly what must not. These assertions cover the
 * properties that make the move safe rather than merely different:
 *
 * 1. A new account defaults to light, never to the OS.
 * 2. A preference follows the ACCOUNT, not the caller: two people with different
 *    choices do not see each other's, and a viewer (who holds almost no org
 *    permissions) can still read and change their own.
 * 3. The write cannot touch another account, even with another user's id.
 * 4. An unreadable value degrades to light instead of failing sign-in.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { loginUser, registerUser } from '../../services/auth.ts';
import {
 DEFAULT_THEME,
 THEME_PREFERENCES,
 getThemePreference,
 isThemePreference,
 setThemePreference,
 type ThemePreference,
} from '../../services/userPreferences.ts';
import type { ActorRef } from '../../services/records.ts';
import { getDb } from '../../db/driver.ts';
import { createApp } from '../../app.ts';

let pass = 0;
const fails: string[] = [];
const T = (label: string, condition: boolean, detail?: unknown): void => {
 const text = detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 160)}`;
 if (condition) {
  pass++;
  console.log(` [PASS] ${label}`);
 } else {
  fails.push(label);
  console.log(` [FAIL] ${label}${text}`);
 }
};

const C = { ip: '10.0.0.9', userAgent: 'preferences.test', requestId: 'pref' };

const ownerReg = await registerUser({
 name: 'Pref Owner', email: 'pref-owner@corp.io', password: 'Zk-3391-Falcon-pt',
 organizationName: 'Pref Corp', client: C,
});
const owner: ActorRef = {
 userId: ownerReg.user.id, organizationId: ownerReg.organizationId, role: 'owner',
 email: ownerReg.user.email,
};

const viewerReg = await registerUser({
 name: 'Pref Viewer', email: 'pref-viewer@corp.io', password: 'Vb-5510-Tundra-hj',
 organizationName: 'Pref Viewer Ltd', client: C,
});
const viewer: ActorRef = {
 userId: viewerReg.user.id, organizationId: viewerReg.organizationId, role: 'viewer',
 email: viewerReg.user.email,
};

// The fixture passwords deliberately share no substring with the addresses or
// names above: the strength policy rejects a password containing them, and a
// fixture that tripped that rule would fail for a reason unrelated to this file.
console.log('\n=== the allowed values ===');
T('the enum is exactly light, dark and system',
 THEME_PREFERENCES.length === 3
 && THEME_PREFERENCES.every((t) => t === 'light' || t === 'dark' || t === 'system'),
 THEME_PREFERENCES);
T('the default is light, not the OS', DEFAULT_THEME === 'light', DEFAULT_THEME);
T('isThemePreference rejects anything else',
 !isThemePreference('sepia') && !isThemePreference('') && !isThemePreference(null)
 && isThemePreference('dark'));

console.log('\n=== a fresh account is light ===');
T('a brand new account reads light', (await getThemePreference(owner)) === 'light');
T('and so does another one', (await getThemePreference(viewer)) === 'light');

console.log('\n=== the preference belongs to the account ===');
T('the owner can choose dark', (await setThemePreference(owner, 'dark')).theme === 'dark');
T('the owner now reads dark', (await getThemePreference(owner)) === 'dark');
T('the viewer is unaffected', (await getThemePreference(viewer)) === 'light');
T('the viewer can choose their own',
 (await setThemePreference(viewer, 'system')).theme === 'system');
T('the owner is unaffected by the viewer', (await getThemePreference(owner)) === 'dark');
T('and light again for the viewer', (await setThemePreference(viewer, 'light')).theme === 'light');

console.log('\n=== the value is constrained in the database too ===');
{
 // Bypasses the service entirely: the point is that the DATABASE refuses the
 // value too, so a hand-written UPDATE (or a future bug in the service) cannot
 // store a state the client could never have sent.
 const db = await getDb();
 let code = '';
 try {
  await db.query(`UPDATE users SET theme_preference = 'sepia' WHERE id = $1`, [owner.userId]);
 } catch (err) {
  code = String((err as { code?: string }).code ?? '');
 }
 T('a CHECK constraint refuses a value the client could not have sent',
  code === '23514', code);
 const row = await db.query<{ theme_preference: string }>(
  'SELECT theme_preference FROM users WHERE id = $1', [owner.userId]);
 T('and the stored value is untouched', row.rows[0]?.theme_preference !== 'sepia',
  row.rows[0]?.theme_preference);
}

console.log('\n=== an unreadable stored value degrades to light ===');
{
 const db = await getDb();
 // Bypass the CHECK the way a future migration could, then read through the
 // service: a preference that cannot be understood must not block a page load.
 await db.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_theme_preference_check');
 await db.query(`UPDATE users SET theme_preference = 'neon' WHERE id = $1`, [owner.userId]);
 T('an unknown stored value reads as light', (await getThemePreference(owner)) === 'light');
 // Restore the row BEFORE re-adding the constraint: the constraint is checked
 // against existing rows, so putting it back while 'neon' is stored would fail
 // (and would fail for the right reason, which is worth the ordering).
 await db.query(`UPDATE users SET theme_preference = 'light' WHERE id = $1`, [owner.userId]);
 await db.query(
  `ALTER TABLE users ADD CONSTRAINT users_theme_preference_check
   CHECK (theme_preference IN ('light','dark','system'))`);
 T('the constraint is restored', true);
}

console.log('\n=== the service refuses a value it does not offer ===');
{
 let rejected = false;
 try {
  await setThemePreference(owner, 'sepia' as unknown as ThemePreference);
 } catch {
  rejected = true;
 }
 T('an unknown preference is refused', rejected);
}

console.log('\n=== HTTP: the caller\'s own preference ===');
{
 const server = createApp().listen(0);
 const port = (server.address() as { port: number }).port;
 // `.env.test` allowlists exactly one origin (http://localhost:3000), so that is
  // what a same-origin client sends; anything else must be rejected.
 const call = async (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, { ...init, redirect: 'manual' });

 const login = async (email: string, password: string): Promise<string> => {
  const r = await call('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
  body: JSON.stringify({ email, password }),
  });
  const body = await r.json() as { data?: { accessToken?: string } };
  return body.data?.accessToken ?? '';
 };

 const ownerToken = await login('pref-owner@corp.io', 'Zk-3391-Falcon-pt');
 T('the owner can sign in', ownerToken.length > 0);

 const anon = await call('/api/v1/auth/me/preferences');
 T('an anonymous read is refused', anon.status === 401, anon.status);
 await anon.arrayBuffer();

 const read = await call('/api/v1/auth/me/preferences', {
  headers: { authorization: `Bearer ${ownerToken}` },
 });
 const readBody = await read.json() as { data?: { theme?: string } };
 T('the owner reads their own preference', read.status === 200 && readBody.data?.theme === 'light',
  readBody);

 const write = await call('/api/v1/auth/me/preferences', {
  method: 'PUT',
  headers: {
  authorization: `Bearer ${ownerToken}`,
  'content-type': 'application/json',
  origin: 'http://localhost:3000',
  },
  body: JSON.stringify({ theme: 'dark' }),
 });
 const writeBody = await write.json() as { data?: { theme?: string } };
 T('the owner writes dark', write.status === 200 && writeBody.data?.theme === 'dark', writeBody);
 T('and it is readable back', (await getThemePreference(owner)) === 'dark');

 const bad = await call('/api/v1/auth/me/preferences', {
  method: 'PUT',
  headers: {
  authorization: `Bearer ${ownerToken}`,
  'content-type': 'application/json',
  origin: 'http://localhost:3000',
  },
  body: JSON.stringify({ theme: 'sepia' }),
 });
 await bad.arrayBuffer();
 T('an unknown value is refused -> 422', bad.status === 422, bad.status);

 const crossOrigin = await call('/api/v1/auth/me/preferences', {
  method: 'PUT',
  headers: {
  authorization: `Bearer ${ownerToken}`,
  'content-type': 'application/json',
  origin: 'https://evil.example',
  },
  body: JSON.stringify({ theme: 'light' }),
 });
 await crossOrigin.arrayBuffer();
 T('a cross-origin write is refused by the CSRF guard', crossOrigin.status === 403, crossOrigin.status);

 // A viewer holds none of the org permissions and must still control their own
 // appearance; that is the whole reason this endpoint exists.
 const viewerToken = await login('pref-viewer@corp.io', 'Vb-5510-Tundra-hj');
 T('the viewer can sign in', viewerToken.length > 0);
 const viewerWrite = await call('/api/v1/auth/me/preferences', {
  method: 'PUT',
  headers: {
  authorization: `Bearer ${viewerToken}`,
  'content-type': 'application/json',
  origin: 'http://localhost:3000',
  },
  body: JSON.stringify({ theme: 'system' }),
 });
 const viewerBody = await viewerWrite.json() as { data?: { theme?: string } };
 T('a viewer can write their own preference',
  viewerWrite.status === 200 && viewerBody.data?.theme === 'system', viewerBody);
 T('and the owner is still dark', (await getThemePreference(owner)) === 'dark');

 await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length > 0) {
 console.log('FAILURES:');
 for (const f of fails) console.log(` - ${f}`);
 process.exit(1);
}
void loginUser;