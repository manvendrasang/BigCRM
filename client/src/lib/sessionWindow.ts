/**
 * Sign out when the window is closed -- but not when the page is refreshed, and
 * not while another tab is still open.
 *
 * The naive implementation is a `sendBeacon` to `/auth/logout` on `pagehide`.
 * It is wrong in two ways that matter on a shared office machine:
 *
 * 1. `pagehide` fires on an ordinary refresh, so F5 would sign you out. The
 *    requirement is that closing the *window* ends the session.
 * 2. The session lives in an HttpOnly cookie shared by every tab, so closing
 *    one of three tabs would revoke all three.
 *
 * Neither is decidable inside the unload handler: at that moment "the user
 * closed the window" and "the user pressed F5" produce identical events. So the
 * decision is not made on the way out; it is made by the *next* page load, using
 * the one storage primitive that differs between the two cases:
 *
 * `sessionStorage` is per-tab, survives a refresh, and is destroyed when the tab
 * is closed. Therefore:
 *
 * * sessionStorage id present at boot  -> this tab was already alive -> refresh.
 * * sessionStorage id absent at boot   -> this is a brand-new tab/window.
 *
 * A brand-new tab is not automatically a reason to sign out (opening a new tab
 * while signed in is ordinary), so the tab registry answers the remaining
 * question: is any *other* tab still alive?
 *
 * Each tab writes `{ id, ts, closing }` into a localStorage registry and
 * refreshes `ts` on an interval. On real teardown it sets `closing` on its own
 * entry (a synchronous localStorage write, so it lands even though the context
 * is being destroyed). So an entry is "alive" only if it is neither closing nor
 * stale. `closing` covers the fast case (reopen a second after closing);
 * staleness covers the crash case (no `pagehide` at all).
 *
 * Decision table:
 *
 * | situation                          | other live tabs | sign out |
 * |------------------------------------|-----------------|----------|
 * | F5 / reload in the same tab        | (self)          | no       |
 * | last tab closed, reopened later    | none            | yes      |
 * | one of three tabs closed, new tab  | two alive       | no       |
 * | all tabs closed, one reopened      | none            | yes      |
 * | new tab while the only tab is open | one alive       | no       |
 *
 * The sign-out itself is a fire-and-forget beacon to the existing logout route:
 * the access token cookie authenticates it, `csrfGuard` is satisfied by the
 * same-origin `Origin` header, and the response is discarded because the page is
 * already gone. `wasSignedOutOnOpen()` then tells the auth provider to skip its
 * session probe, so the dashboard never flashes before the login page appears.
 */

/** Per-tab id. sessionStorage: survives refresh, dies with the tab. */
const TAB_ID_KEY = 'bigcrm.tab.id';
/** Cross-tab liveness registry: `{ [tabId]: { ts, closing } }`. */
const REGISTRY_KEY = 'bigcrm.tabs';
/** "A signed-in session may exist in this browser", set at login. */
const SESSION_KEY = 'bigcrm.session.active';

/** How often a live tab refreshes its entry. */
export const HEARTBEAT_MS = 2_000;
/**
 * An entry with no heartbeat for this long is assumed dead. Four missed beats
 * is enough slack for a backgrounded tab's timers to be throttled, and short
 * enough that a crashed tab stops counting as "another live tab".
 */
export const STALE_MS = 8_000;

const LOGOUT_URL = '/api/v1/auth/logout';

type Registry = Record<string, { ts: number; closing: boolean }>;

/** Storage is unavailable in private mode and some embedded contexts. */
function safeLocal(): Storage | null {
 try {
  return window.localStorage;
 } catch {
  return null;
 }
}

function safeSession(): Storage | null {
 try {
  return window.sessionStorage;
 } catch {
  return null;
 }
}

export function readRegistry(store: Storage | null = safeLocal()): Registry {
  if (store === null) return {};
  try {
  const raw = store.getItem(REGISTRY_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return {};
  const out: Registry = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
  if (typeof value === 'object' && value !== null) {
  const v = value as { ts?: unknown; closing?: unknown };
  if (typeof v.ts === 'number') {
  out[id] = { ts: v.ts, closing: v.closing === true };
  }
  }
  }
  return out;
 } catch {
  // Corrupt or unreadable: treat as empty rather than wedging sign-in.
  return {};
 }
}

function writeRegistry(registry: Registry, store: Storage | null = safeLocal()): void {
  if (store === null) return;
  try {
  store.setItem(REGISTRY_KEY, JSON.stringify(registry));
 } catch {
  // Quota or private mode. The heartbeat degrades to no cross-tab knowledge,
  // which is the pre-existing behaviour, not a failure.
 }
}

/** The stable id for this tab, created on first sight. `null` when unavailable. */
export function tabId(session: Storage | null = safeSession()): string {
  if (session === null) return '';
  let id = session.getItem(TAB_ID_KEY);
  if (!id) {
  id = `t-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  try {
  session.setItem(TAB_ID_KEY, id);
  } catch {
  // Unwritable sessionStorage: the id will not survive the next navigation,
  // so this tab will look like a fresh one. The sign-out path is designed to be
  // safe when that happens (it signs out; it never wrongly stays signed in).
  }
  }
  return id;
}

/**
 * The decision, as a pure function so it can be tested without a browser.
 *
 * `selfIdInSession` answers "was this tab alive before this page load?", which
 * is the entire refresh-vs-close distinction.
 */
export function shouldSignOutOnOpen(args: {
  /** sessionStorage held a tab id before this page load. */
  selfIdInSession: boolean;
  /** The registry as stored, before this tab writes its own entry. */
  registry: Registry;
  /** This tab's id, or '' when sessionStorage is unavailable. */
  selfId: string;
  /** Whether a signed-in session may exist in this browser. */
  sessionActive: boolean;
  now: number;
  staleMs?: number;
}): boolean {
  const {
  selfIdInSession, registry, selfId, sessionActive, now, staleMs = STALE_MS,
  } = args;
  // Not a new tab -> this is a refresh, and a refresh must never sign anyone out.
  if (selfIdInSession) return false;
  if (!sessionActive) return false;
  // Without a stable id we cannot recognise our own entry, so we cannot prove
  // the tabs we see are others. Signing out is the safe direction here.
  if (selfId === '') return true;

  const others = Object.entries(registry).filter(([id]) => id !== selfId);
  // No trace of a previous tab: nobody was ever signed in here. Nothing to end.
  if (others.length === 0) return false;

  const liveOthers = others.filter(([, entry]) => !entry.closing && now - entry.ts <= staleMs);
  return liveOthers.length === 0;
}

let signedOutOnOpen = false;

/** True when boot decided the session from the previous tab must not be reused. */
export function wasSignedOutOnOpen(): boolean {
  return signedOutOnOpen;
}

/** Marks that a session may exist, so a later closed tab ends it. */
export function markSessionActive(store: Storage | null = safeLocal()): void {
  try {
  store?.setItem(SESSION_KEY, '1');
 } catch {
  // Non-fatal: without the marker, closing a tab will not sign anyone out.
 }
}

/** Clears the marker. Called on explicit sign-out and after a boot sign-out. */
export function clearSessionActive(store: Storage | null = safeLocal()): void {
  try {
  store?.removeItem(SESSION_KEY);
 } catch {
  // Non-fatal.
 }
}

function sessionIsActive(store: Storage | null = safeLocal()): boolean {
  try {
  return store?.getItem(SESSION_KEY) === '1';
 } catch {
  return false;
 }
}

/**
 * Ends the previous tab's session. The beacon is best effort by nature: if it
 * does not arrive, the next page load still cannot reuse the session because
 * this page has already decided to render the login screen.
 */
function sendLogoutBeacon(): void {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
  try {
  // Same-origin POST with cookies included; `csrfGuard` checks the Origin
  // header, which the browser sends for POST regardless of page teardown.
  navigator.sendBeacon(LOGOUT_URL);
 } catch {
  // Blocked by policy or during teardown. Nothing else to do.
 }
}

/**
 * Installs the tab registry, the heartbeat and the teardown marker, and makes
 * the boot decision. Call once, before rendering.
 */
export function initSessionWindow(): void {
  if (typeof window === 'undefined') return;
  const session = safeSession();
  const store = safeLocal();

  // Recomputed from scratch every call: the flag is a fact about THIS load, not
  // a sticky one, so a second call cannot inherit an earlier verdict.
  signedOutOnOpen = false;

  const selfIdInSession = (session?.getItem(TAB_ID_KEY) ?? null) !== null;
  const selfId = tabId(session);
  const registry = readRegistry(store);

  const signOut = shouldSignOutOnOpen({
  selfIdInSession,
  registry,
  selfId,
  sessionActive: sessionIsActive(store),
  now: Date.now(),
  });

  // Our own entry goes in either way: a tab that boots is a tab that is alive,
  // which is exactly what another tab needs to know.
  const next: Registry = { ...registry, [selfId]: { ts: Date.now(), closing: false } };
  if (signOut) {
  // Nobody is left to tell, so the registry is emptied rather than left to rot.
  writeRegistry({}, store);
  clearSessionActive(store);
  signedOutOnOpen = true;
  sendLogoutBeacon();
 } else {
  writeRegistry(next, store);
 }

  if (typeof window.setInterval === 'function') {
  window.setInterval(() => {
  const current = readRegistry(store);
  // Another tab may have emptied the registry after a sign-out; re-assert.
  current[selfId] = { ts: Date.now(), closing: false };
  writeRegistry(current, store);
  }, HEARTBEAT_MS);
  }

  if (typeof window.addEventListener !== 'function') return;
  window.addEventListener('pagehide', (event) => {
  // `persisted` means the page is entering the back/forward cache: it is not
  // closed and will resume, so it must not be treated as a departure.
  if (event.persisted === true) return;
  const current = readRegistry(store);
  if (current[selfId] === undefined) return;
  current[selfId] = { ts: Date.now(), closing: true };
  writeRegistry(current, store);
  });
}