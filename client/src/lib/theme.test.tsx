/**
 * Appearance preference.
 *
 * The behaviour under test is the ordering the requirement describes: light on
 * arrival, the account's own theme once there is somebody to attribute it to.
 * That means a signed-out visitor sees light, and a signed-in one sees whatever
 * they last chose -- with the flip happening only after authentication.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetApiClient, setFetchImplementation } from './api';
import { AuthProvider } from './auth';
import { AccountTheme, ThemeProvider, useTheme } from './theme';

afterEach(() => {
  resetApiClient();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
  });
}

const themeOf = (): string | null => document.documentElement.getAttribute('data-theme');

function stubApi(opts: { me?: unknown; preferences?: unknown; putStatus?: number } = {}): {
  puts: { body: string }[];
} {
  const { me = null, preferences = { theme: 'light' }, putStatus = 200 } = opts;
  const puts: { body: string }[] = [];
  setFetchImplementation(async (url, init) => {
  const method = String((init as { method?: string })?.method ?? 'GET');
  // `/auth/me/preferences` also contains `/auth/me`, so it must be matched
  // first: otherwise every preference read is answered with a session response
  // and the stored theme never arrives.
  if (url.includes('/me/preferences')) {
  if (method === 'PUT') {
  puts.push({ body: String((init as { body?: unknown })?.body ?? '') });
  return jsonResponse({ data: preferences }, putStatus);
  }
  return jsonResponse({ data: preferences });
  }
  if (url.includes('/auth/me') && method === 'GET') {
  return jsonResponse(
  me === null
  ? { code: 'UNAUTHENTICATED', message: 'Authentication required.', requestId: 'r1' }
  : {
  data: {
  user: { id: 'u1', email: 'a@corp.io', name: 'A', emailVerified: true, mfaEnabled: false },
  organizationId: 'o1',
  role: 'owner',
  },
  },
  me === null ? 401 : 200,
  );
  }
  return jsonResponse({ data: {} });
  });
  return { puts };
}

function Switcher(): JSX.Element {
  const { preference, resolved, setPreference, applyAccountTheme } = useTheme();
  return (
  <div>
   <span data-testid="preference">{preference}</span>
   <span data-testid="resolved">{resolved}</span>
   <button type="button" onClick={() => setPreference('dark')}>dark</button>
   <button type="button" onClick={() => setPreference('system')}>system</button>
   <button type="button" onClick={() => applyAccountTheme('dark')}>account dark</button>
  </div>
  );
}

function renderTheme(children: JSX.Element = <Switcher />): void {
  render(
  <ThemeProvider>
   <AuthProvider>{children}</AuthProvider>
  </ThemeProvider>,
  );
}

describe('theme preference', () => {
 it('starts light, whatever the DOM was told before React ran', () => {
  document.documentElement.setAttribute('data-theme', 'dark');
  stubApi();
  renderTheme();

  expect(screen.getByTestId('preference')).toHaveTextContent('light');
  expect(screen.getByTestId('resolved')).toHaveTextContent('light');
  expect(themeOf()).toBe('light');
 });

 it('applies a choice immediately and persists it to the account', async () => {
  const { puts } = stubApi();
  renderTheme();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'dark' }));

  expect(themeOf()).toBe('dark');
  expect(screen.getByTestId('preference')).toHaveTextContent('dark');
  expect(puts[0]?.body).toContain('"theme":"dark"');
 });

 it('never writes the theme to browser storage', async () => {
  // A browser-scoped copy is the one thing that must not survive on a shared
  // machine, and the account is the storage.
  stubApi();
  renderTheme();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'dark' }));

  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
 });

 it('keeps the page usable when the write fails', async () => {
  // The theme is cosmetic: a failed save must not surface an error the user has
  // to dismiss to keep working.
  stubApi({ putStatus: 500 });
  renderTheme();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'dark' }));

  expect(themeOf()).toBe('dark');
 });

 it('represents system by leaving the attribute off, so CSS stays the source of truth', async () => {
  stubApi();
  renderTheme();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'system' }));

  expect(themeOf()).toBeNull();
 });
});

describe('AccountTheme', () => {
 it('stays light while signed out and never asks the server', async () => {
  const seen: string[] = [];
  setFetchImplementation(async (url) => {
  seen.push(url);
  return jsonResponse(
  { code: 'UNAUTHENTICATED', message: 'Authentication required.', requestId: 'r1' },
  401,
  );
  });

  renderTheme(
  <>
   <AccountTheme />
   <Switcher />
  </>,
  );

  await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('light'));
  expect(seen.some((u) => u.includes('/me/preferences'))).toBe(false);
  expect(themeOf()).toBe('light');
 });

 it("restores the account's stored dark theme once authenticated", async () => {
  stubApi({
  me: { role: 'owner' },
  preferences: { theme: 'dark' },
  });

  renderTheme(
  <>
   <AccountTheme />
   <Switcher />
  </>,
  );

  // The transition the requirement describes: light first, then dark.
  await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('dark'));
  await waitFor(() => expect(themeOf()).toBe('dark'));
 });

 it('leaves the page light when the preference cannot be fetched', async () => {
  stubApi({ me: { role: 'owner' }, preferences: { theme: 'nonsense' } });

  renderTheme(
  <>
   <AccountTheme />
   <Switcher />
  </>,
  );

  await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('light'));
  expect(themeOf()).toBe('light');
 });

 it('applies without writing back, so restoring is not a mutation', async () => {
  const { puts } = stubApi({ me: { role: 'owner' }, preferences: { theme: 'dark' } });

  renderTheme(
  <>
   <AccountTheme />
   <Switcher />
  </>,
  );

  await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('dark'));
  expect(puts).toHaveLength(0);
 });
});