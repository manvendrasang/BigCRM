/**
 * Window-close sign-out.
 *
 * The decision is the interesting part: the browser cannot tell "the window was
 * closed" from "the page was refreshed" inside the unload handler, so the
 * distinction is made on the *next* load using `sessionStorage` (per-tab,
 * refresh-surviving, close-destroying) plus a cross-tab liveness registry.
 *
 * These are pure-function tests over that decision. The registry format is
 * asserted too, because the two halves have to agree: `initSessionWindow` writes
 * `closing` on teardown and `shouldSignOutOnOpen` reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
 HEARTBEAT_MS,
 STALE_MS,
 clearSessionActive,
 initSessionWindow,
 markSessionActive,
 readRegistry,
 shouldSignOutOnOpen,
 tabId,
 wasSignedOutOnOpen,
} from './sessionWindow';

const NOW = 1_700_000_000_000;

beforeEach(() => {
 localStorage.clear();
 sessionStorage.clear();
 vi.useFakeTimers();
});

afterEach(() => {
 vi.useRealTimers();
 vi.restoreAllMocks();
});

/** A live tab entry: recent heartbeat, not on its way out. */
function live(id: string, ts = NOW): [string, { ts: number; closing: boolean }] {
 return [id, { ts, closing: false }];
}

/** A tab that tore down normally: `pagehide` set the flag. */
function closing(id: string, ts = NOW): [string, { ts: number; closing: boolean }] {
 return [id, { ts, closing: true }];
}

/** A tab that crashed: no `pagehide`, heartbeat simply stopped. */
function crashed(id: string, ts: number): [string, { ts: number; closing: boolean }] {
 return [id, { ts, closing: false }];
}

describe('shouldSignOutOnOpen', () => {
 it('never signs out on a refresh: sessionStorage already held this tab', () => {
  // The whole point of the design: F5 must not end the session.
  expect(
  shouldSignOutOnOpen({
  selfIdInSession: true,
  selfId: 't-1',
  registry: Object.fromEntries([closing('t-1')]),
  sessionActive: true,
  now: NOW,
  }),
  ).toBe(false);
 });

 it('signs out when the only tab was closed and a new one opens', () => {
  expect(
  shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: 't-new',
  registry: Object.fromEntries([closing('t-old')]),
  sessionActive: true,
  now: NOW,
  }),
  ).toBe(true);
 });

 it('signs out even when the closed tab closed a moment ago', () => {
  // `closing` is what makes this immediate; staleness alone would need seconds.
  expect(
  shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: 't-new',
  registry: Object.fromEntries([closing('t-old', NOW - 50)]),
  sessionActive: true,
  now: NOW,
  }),
  ).toBe(true);
 });

 it('signs out when the previous tab crashed and its heartbeat went stale', () => {
  expect(
  shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: 't-new',
  registry: Object.fromEntries([crashed('t-old', NOW - STALE_MS - 1)]),
  sessionActive: true,
  now: NOW,
  }),
  ).toBe(true);
 });

 it('keeps the session when another tab is still open', () => {
  // Closing one of several tabs must not sign the others out.
  expect(
  shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: 't-new',
  registry: Object.fromEntries([closing('t-gone'), live('t-other')]),
  sessionActive: true,
  now: NOW,
  }),
  ).toBe(false);
 });

 it('keeps the session when opening a new tab alongside the current one', () => {
  expect(
  shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: 't-new',
  registry: Object.fromEntries([live('t-other')]),
  sessionActive: true,
  now: NOW,
  }),
  ).toBe(false);
 });

 it('ignores its own registry entry when deciding', () => {
  // The refresh case from the other side: our entry exists and is alive, and
  // `selfIdInSession` is false because this is the boot that created it.
  expect(
  shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: 't-1',
  registry: Object.fromEntries([live('t-1')]),
  sessionActive: true,
  now: NOW,
  }),
  ).toBe(false);
 });

 it('does nothing when no session was ever active in this browser', () => {
  expect(
  shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: 't-new',
  registry: Object.fromEntries([closing('t-old')]),
  sessionActive: false,
  now: NOW,
  }),
  ).toBe(false);
 });

 it('does nothing when there is no previous tab to have closed', () => {
  // First ever visit: the registry is empty, so "nobody is left" means "nobody
  // was here", not "the session must end".
  expect(
  shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: 't-new',
  registry: {},
  sessionActive: true,
  now: NOW,
  }),
  ).toBe(false);
 });

 it('treats a heartbeat older than the stale window as dead', () => {
  const justInside = shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: 't-new',
  registry: Object.fromEntries([crashed('t-old', NOW - STALE_MS + 1)]),
  sessionActive: true,
  now: NOW,
  });
  const justOutside = shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: 't-new',
  registry: Object.fromEntries([crashed('t-old', NOW - STALE_MS - 1)]),
  sessionActive: true,
  now: NOW,
  });

  expect(justInside).toBe(false);
  expect(justOutside).toBe(true);
 });

 it('signs out when sessionStorage is unavailable and we cannot tell', () => {
  // Without a tab id we cannot recognise our own entry, so every entry looks
  // like somebody else's. Failing towards signing out is the safe direction.
  expect(
  shouldSignOutOnOpen({
  selfIdInSession: false,
  selfId: '',
  registry: Object.fromEntries([live('t-other')]),
  sessionActive: true,
  now: NOW,
  }),
  ).toBe(true);
 });
});

describe('tab identity', () => {
 it('is stable within a tab across reads', () => {
  const first = tabId();
  expect(first).not.toBe('');
  expect(tabId()).toBe(first);
 });

 it('does not survive a cleared sessionStorage, which is what a closed tab does', () => {
  const first = tabId();
  sessionStorage.clear();
  expect(tabId()).not.toBe(first);
 });
});

describe('registry storage', () => {
 it('round-trips through localStorage', () => {
  localStorage.setItem('bigcrm.tabs', JSON.stringify({ t1: { ts: NOW, closing: false } }));
  expect(readRegistry()).toEqual({ t1: { ts: NOW, closing: false } });
 });

 it('treats corrupt JSON as an empty registry instead of throwing', () => {
  localStorage.setItem('bigcrm.tabs', 'not json');
  expect(readRegistry()).toEqual({});
 });

 it('drops entries whose timestamp is not a number', () => {
  localStorage.setItem('bigcrm.tabs', JSON.stringify({ t1: { ts: 'soon' }, t2: { ts: 5 } }));
  expect(readRegistry()).toEqual({ t2: { ts: 5, closing: false } });
 });
});

describe('initSessionWindow', () => {
 it('registers the tab and leaves a refresh alone', () => {
  markSessionActive();
  // Simulate a tab that already exists and then reloaded.
  const id = tabId();
  localStorage.setItem('bigcrm.tabs', JSON.stringify({ [id]: { ts: NOW, closing: true } }));

  initSessionWindow();

  expect(wasSignedOutOnOpen()).toBe(false);
  const registry = readRegistry();
  expect(registry[id]?.closing).toBe(false);
 });

 it('signs out and sends a beacon when the last tab was closed', () => {
  const sendBeacon = vi.fn();
  Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
  markSessionActive();
  localStorage.setItem(
  'bigcrm.tabs',
  JSON.stringify({ 't-closed': { ts: Date.now(), closing: true } }),
  );

  initSessionWindow();

  expect(wasSignedOutOnOpen()).toBe(true);
  expect(sendBeacon).toHaveBeenCalledWith('/api/v1/auth/logout');
  // The marker is cleared so the next visit starts from nothing.
  expect(localStorage.getItem('bigcrm.session.active')).toBeNull();
  expect(readRegistry()).toEqual({});
 });

 it('does not send a beacon when a tab is still open', () => {
  const sendBeacon = vi.fn();
  Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
  markSessionActive();
  localStorage.setItem(
  'bigcrm.tabs',
  JSON.stringify({ 't-other': { ts: Date.now(), closing: false } }),
  );

  initSessionWindow();

  expect(wasSignedOutOnOpen()).toBe(false);
  expect(sendBeacon).not.toHaveBeenCalled();
 });

 it('refreshes its entry on the heartbeat so a backgrounded tab stays alive', () => {
  markSessionActive();
  localStorage.setItem(
  'bigcrm.tabs',
  JSON.stringify({ 't-other': { ts: Date.now(), closing: false } }),
  );

  initSessionWindow();
  const id = tabId();
  vi.advanceTimersByTime(HEARTBEAT_MS * 3);

  const entry = readRegistry()[id];
  expect(entry?.closing).toBe(false);
  expect(entry).toBeDefined();
 });

 it('survives storage being unavailable', () => {
  // Nothing here may throw: a blocked storage partition (private mode, locked
  // down profile) degrades the feature, it does not break the app. Accessing
  // `window.localStorage` itself is what throws in that case, which is why the
  // accessors are wrapped rather than the calls.
  const realLocal = window.localStorage;
  const realSession = window.sessionStorage;
  const blocked = {
  configurable: true,
  get() {
  throw new Error('storage blocked');
  },
  };
  Object.defineProperty(window, 'localStorage', blocked);
  Object.defineProperty(window, 'sessionStorage', blocked);

  try {
  expect(() => initSessionWindow()).not.toThrow();
  // No storage means no tab id, so nothing can be proven about other tabs; the
  // safe direction is to stay signed out rather than to guess.
  expect(wasSignedOutOnOpen()).toBe(false);
  } finally {
  // Restored explicitly: the override is on the window, and `beforeEach` calls
  // `localStorage.clear()`.
  Object.defineProperty(window, 'localStorage', { configurable: true, value: realLocal });
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: realSession });
  }
 });
});

describe('session marker', () => {
 it('round-trips', () => {
  expect(localStorage.getItem('bigcrm.session.active')).toBeNull();
  markSessionActive();
  expect(localStorage.getItem('bigcrm.session.active')).toBe('1');
  clearSessionActive();
  expect(localStorage.getItem('bigcrm.session.active')).toBeNull();
 });
});