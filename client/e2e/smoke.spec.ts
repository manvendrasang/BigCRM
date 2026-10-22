/**
 * The end-to-end smoke test.
 *
 * One journey, in a real browser, against the real API:
 *
 *   sign in -> create a dated task -> the workspace is told -> the second
 *   member opens it from their notification -> the shared event window shows
 *   it -> they complete it from the record -> the calendar shows it done.
 *
 * Why this test exists at all
 * ---------------------------
 * Every other test in this repository is either a service-level suite (fast,
 * precise, but it never touches Express, cookies or the browser) or a jsdom
 * component test (real React, but a fake network). Neither can catch the class
 * of defect that costs a user their session: the cookie not being set, the
 * CSRF header not being sent, a route that does not exist in the running app,
 * a redirect that sends you to the wrong page. Those are wiring defects, and
 * wiring defects are only visible when the whole thing is wired.
 *
 * Two workspaces, two browsers
 * ----------------------------
 * The flow deliberately spans two people. A task with a due date announces
 * itself to the *other* members of the workspace, so "the notification
 * arrives" and "the recipient can act on it" are two different sessions. The
 * seed step uses the API directly -- creating a workspace and a second member
 * is setup, not the thing under test.
 *
 * What this test does not claim
 * -----------------------------
 * It does not assert that the advance notices were retired: the reminder
 * ledger is server state with no HTTP surface, so the browser cannot see it.
 * That property is asserted where it can be observed, in
 * `server/src/tests/integration/taskDueDate.test.ts`. The browser's version of
 * the same claim is that the calendar and the event window both show the
 * task as completed, which is what this test does assert.
 */
import { test, expect, request as apiRequest } from '@playwright/test';

const API_ORIGIN = 'http://localhost:3100';
const APP_ORIGIN = 'http://localhost:5273';

/** Unique per run, so a re-run never collides with the workspace before it. */
const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const OWNER = {
 name: 'Elena Marsh',
 email: `e2e-owner-${uniq}@corp.io`,
 // The password may not contain the account name; the strength checker says so.
 password: 'Wander-Pasture-1842!',
};
const MEMBER = { name: 'Sam Okafor', email: `e2e-member-${uniq}@corp.io` };
const TITLE = `E2E dated task ${uniq}`;

/** A `RegExp` that matches the literal string, wherever it appears. */
const literal = (value: string): RegExp =>
 new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

test('a dated task reaches the calendar and can be completed from a notification', async ({ browser }) => {
 test.setTimeout(180_000);

 //  seed: a workspace with a second member 
 const api = await apiRequest.newContext({
 baseURL: API_ORIGIN,
 extraHTTPHeaders: { origin: APP_ORIGIN },
 });

 const registered = await api.post('/api/v1/auth/register', {
 data: {
 name: OWNER.name,
 email: OWNER.email,
 password: OWNER.password,
 organizationName: `E2E ${uniq} Ltd`,
 },
 });
 expect(registered.status(), `register: ${await registered.text()}`).toBe(201);

 const signedIn = await api.post('/api/v1/auth/login', {
 data: { email: OWNER.email, password: OWNER.password },
 });
 expect(signedIn.status(), 'the owner can sign in').toBe(200);
 const session = (await signedIn.json()) as { data: { accessToken: string } };

 const created = await api.post('/api/v1/org/members', {
 headers: { authorization: `Bearer ${session.data.accessToken}` },
 data: { email: MEMBER.email, role: 'sales', name: MEMBER.name },
 });
 expect(created.status(), `create member: ${await created.text()}`).toBe(201);
 const member = (await created.json()) as { data: { generatedPassword: string } };

 //  the owner signs in through the form 
 const ownerContext = await browser.newContext({ timezoneId: 'UTC' });
 const ownerPage = await ownerContext.newPage();
 await ownerPage.goto('/login');
 await ownerPage.getByLabel('Work email').fill(OWNER.email);
 await ownerPage.getByLabel('Password').fill(OWNER.password);
 await ownerPage.getByRole('button', { name: 'Sign in' }).click();
 await expect(ownerPage).toHaveURL(/\/dashboard/);

 //  and creates a task with a due date 
 const dueDate = new Date().toISOString().slice(0, 10);
 await ownerPage.goto('/tasks/new');
 await ownerPage.getByLabel('Title').fill(TITLE);
 await ownerPage.getByLabel('Due date').fill(dueDate);
 await ownerPage.getByRole('button', { name: 'Create Task' }).click();

 await expect(ownerPage).toHaveURL(/\/tasks\/[0-9a-f-]{36}/);
 await expect(ownerPage.getByRole('heading', { level: 1 })).toHaveText(TITLE);
 await expect(ownerPage.getByText(dueDate, { exact: false }).first()).toBeVisible();

 //  the second member is told about it 
 const memberContext = await browser.newContext({ timezoneId: 'UTC' });
 const memberPage = await memberContext.newPage();
 await memberPage.goto('/login');
 await memberPage.getByLabel('Work email').fill(MEMBER.email);
 await memberPage.getByLabel('Password').fill(member.data.generatedPassword);
 await memberPage.getByRole('button', { name: 'Sign in' }).click();
 await expect(memberPage).toHaveURL(/\/dashboard/);

 await memberPage.goto('/notifications');
 const notice = memberPage.getByRole('button', { name: literal(TITLE) });
 await expect(notice).toBeVisible();
 await notice.click();

 //  and the notification opens the same event window a calendar chip opens 
 const dialog = memberPage.getByRole('dialog');
 await expect(dialog.getByRole('heading', { name: TITLE })).toBeVisible();
 await expect(dialog).toContainText('Calendar task');
 await expect(dialog).toContainText('todo');

 //  the window links to the record, where the task can be completed 
 await dialog.getByRole('link', { name: 'Open record' }).click();
 await expect(memberPage).toHaveURL(/\/tasks\/[0-9a-f-]{36}/);
 await memberPage.getByRole('button', { name: 'Edit' }).click();
 await memberPage.getByLabel('Status').selectOption('completed');
 await memberPage.getByRole('button', { name: 'Save changes' }).click();
 // The page also has an activity panel with its own `role="status"`, so the
 // confirmation is picked out by its text. The `status` role takes no
 // accessible name from its content, so it cannot be matched by name.
 await expect(memberPage.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

 //  the calendar shows the task, and now shows it done 
 await memberPage.goto('/calendar');
 const chip = memberPage.getByRole('button', { name: TITLE, exact: true });
 await expect(chip).toBeVisible();
 await expect(chip).toHaveClass(/cal-chip-done/);

 //  and the shared window agrees with the calendar 
 await chip.click();
 await expect(memberPage.getByRole('dialog')).toContainText('completed');

 await ownerContext.close();
 await memberContext.close();
 await api.dispose();
});
