/**
 * Settings > Members tests.
 *
 * This section is the only way accounts enter the deployment now that public
 * signup is closed, so three properties matter:
 *
 * 1. The roster the server returns is rendered.
 * 2. The create form appears only when the server says the actor may grant a
 *    role -- the client asks `/org/roles` rather than deciding for itself, so
 *    the authority lives in one place.
 * 3. A created account's one-time password is shown, because it is never
 *    readable again after the response.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { resetApiClient, setFetchImplementation } from '../lib/api';
import { AuthProvider } from '../lib/auth';
import { Settings } from './Settings';

afterEach(() => {
 resetApiClient();
 vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
 return new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
 });
}

const posted: { url: string; body: string; method: string }[] = [];

function stubMembers(opts: {
 members?: unknown[];
 membersStatus?: number;
 assignable?: string[];
 postStatus?: number;
 role?: string;
 resetStatus?: number;
} = {}): void {
 const {
 members = [], membersStatus = 200, assignable = ['manager', 'sales', 'viewer'],
 postStatus = 201, role = 'owner', resetStatus = 200,
 } = opts;
 posted.length = 0;
 setFetchImplementation(async (url, init) => {
  const method = String((init as { method?: string })?.method ?? 'GET');

  // The Members page reads the actor role from the session; the roster's
  // canResetPassword flags arrive from the server.
  if (url.includes('/auth/me')) {
   return jsonResponse({
    data: {
     user: { id: 'u-me', email: 'me@corp.io', name: 'Me', emailVerified: true, mfaEnabled: false },
     organizationId: 'o1',
     role,
    },
   });
  }

  if (url.includes('/password') && method === 'POST') {
   posted.push({ url, body: String((init as { body?: unknown })?.body ?? ''), method });
   if (resetStatus !== 200) {
    return jsonResponse({ code: 'FORBIDDEN', message: "You cannot reset that member's password.", requestId: 'req-1' }, resetStatus);
   }
   return jsonResponse({ data: { userId: 'u1', sessionsRevoked: 2 } });
  }

  if (url.includes('/org/members') && method === 'POST') {
   posted.push({ url, body: String((init as { body?: unknown })?.body ?? ''), method });
   if (postStatus !== 201) {
    // The server's real error contract: top-level code/message, no envelope.
    return jsonResponse({ code: 'CONFLICT', message: 'That email is already taken.', requestId: 'req-1' }, postStatus);
   }
   return jsonResponse({
    data: {
     user: { id: 'u9', email: 'new@corp.io', name: 'New Hire', emailVerified: true, mfaEnabled: false },
     membershipRole: 'sales',
     generatedPassword: 'ONETIME-SECRET-123',
    },
   }, 201);
  }
  if (url.includes('/org/members')) {
   if (membersStatus !== 200) {
    return jsonResponse({ code: 'FORBIDDEN', message: 'You need the users permission to manage members.', requestId: 'req-1' }, membersStatus);
   }
   return jsonResponse({ data: members });
  }
  if (url.includes('/org/roles')) {
   return jsonResponse({
    data: {
     assignable,
     hierarchy: ['owner', 'admin', 'manager', 'sales', 'viewer'],
     note: 'Owner cannot be granted by invitation or by role change; use POST /org/members/transfer-ownership.',
    },
   });
  }
  // Custom fields and anything else the page mounts load as empty.
  return jsonResponse({ data: [] });
 });
}

const renderSettings = (initialEntries: string[] = ['/settings']): void => {
 render(
  <MemoryRouter initialEntries={initialEntries}>
   <AuthProvider>
    <Settings />
   </AuthProvider>
  </MemoryRouter>,
 );
};

describe('Settings members section', () => {
 it('renders the roster the server returns', async () => {
  stubMembers({
   members: [
    { userId: 'u1', email: 'ava@corp.io', name: 'Ava', role: 'admin', status: 'active', mfaEnabled: true, lastLoginAt: null },
   ],
  });

  renderSettings();

  expect(await screen.findByText('ava@corp.io')).toBeInTheDocument();
  expect(screen.getByText('admin')).toBeInTheDocument();
  expect(screen.getByText('On')).toBeInTheDocument();
 });

 it('offers exactly the roles the server says are assignable, never owner', async () => {
  stubMembers({ assignable: ['manager', 'sales', 'viewer'] });

  renderSettings();

  const select = await screen.findByLabelText('Role');
  const values = within(select)
   .getAllByRole('option')
   .map((o) => (o as HTMLOptionElement).value);

  expect(values).toEqual(['manager', 'sales', 'viewer']);
  expect(values).not.toContain('owner');
 });

 it('shows the one-time password after creating a member', async () => {
  stubMembers();

  renderSettings();
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Email'), 'new@corp.io');
  await user.click(screen.getByRole('button', { name: 'Create member' }));

  expect(await screen.findByText('ONETIME-SECRET-123')).toBeInTheDocument();
  expect(screen.getByText(/Account created for new@corp.io/)).toBeInTheDocument();
  expect(posted).toHaveLength(1);
  expect(posted[0]!.url).toContain('/org/members');
  expect(posted[0]!.body).toContain('"email":"new@corp.io"');
  expect(posted[0]!.body).not.toContain('owner');
 });

 it('explains a missing permission instead of offering the form', async () => {
  stubMembers({ membersStatus: 403, assignable: [] });

  renderSettings();

  expect(await screen.findByText(/need the users permission/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Create member' })).toBeNull();
 });

 it('sends the chosen role and name, and clears the credential notice on dismiss', async () => {
  stubMembers();

  renderSettings();
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Email'), 'new@corp.io');
  await user.type(screen.getByLabelText('Name'), 'New Hire');
  await user.selectOptions(screen.getByLabelText('Role'), 'manager');
  await user.click(screen.getByRole('button', { name: 'Create member' }));

  await screen.findByText('ONETIME-SECRET-123');
  expect(posted[0]!.body).toContain('"role":"manager"');
  expect(posted[0]!.body).toContain('"name":"New Hire"');

  await user.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('ONETIME-SECRET-123')).toBeNull();
 });

 it('surfaces a creation failure without losing the form', async () => {
  stubMembers({ postStatus: 409 });

  renderSettings();
  const user = userEvent.setup();

  await user.type(await screen.findByLabelText('Email'), 'taken@corp.io');
  await user.click(screen.getByRole('button', { name: 'Create member' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/already taken/i);
  expect(screen.getByRole('button', { name: 'Create member' })).toBeInTheDocument();
 });
});

describe('Settings password reset', () => {
 const resettable = {
  userId: 'u1', email: 'sam@corp.io', name: 'Sam', role: 'sales', status: 'active',
  mfaEnabled: false, lastLoginAt: null, canResetPassword: true, passwordResetRequested: true,
 };

 it('offers Reset password only for members the server says this actor may reset', async () => {
  stubMembers({
   members: [
    { ...resettable },
    {
     userId: 'u2', email: 'root@corp.io', name: 'Root', role: 'owner', status: 'active',
     mfaEnabled: true, lastLoginAt: null, canResetPassword: false, passwordResetRequested: false,
    },
   ],
  });

  renderSettings();

  await screen.findByText('sam@corp.io');
  // One resettable row => exactly one button; the owner row gets a placeholder.
  expect(screen.getAllByRole('button', { name: 'Reset password' })).toHaveLength(1);
  expect(screen.getByText('Reset requested')).toBeInTheDocument();
 });

 it('sets a new password after the two fields match', async () => {
  stubMembers({ members: [{ ...resettable }] });

  renderSettings();
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: 'Reset password' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('New password'), 'Zz-5521-Lantern-kq');
  await user.type(within(dialog).getByLabelText('Repeat password'), 'Zz-5521-Lantern-kq');
  await user.click(within(dialog).getByRole('button', { name: 'OK' }));

  expect(await screen.findByText(/Password reset for sam@corp.io/)).toBeInTheDocument();
  const reset = posted.find((p) => p.url.includes('/password'));
  expect(reset?.url).toContain('/org/members/u1/password');
  expect(reset?.body).toContain('Zz-5521-Lantern-kq');
 });

 it('refuses mismatched passwords without calling the server', async () => {
  stubMembers({ members: [{ ...resettable }] });

  renderSettings();
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: 'Reset password' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('New password'), 'Zz-5521-Lantern-kq');
  await user.type(within(dialog).getByLabelText('Repeat password'), 'something-else-99');
  await user.click(within(dialog).getByRole('button', { name: 'OK' }));

  expect(await within(dialog).findByRole('alert')).toHaveTextContent(/do not match/i);
  expect(posted.some((p) => p.url.includes('/password'))).toBe(false);
 });

 it('opens the reset card straight from a notification link', async () => {
  stubMembers({ members: [{ ...resettable }] });

  // `/settings?member=<id>` is the link a password-reset notification carries.
  renderSettings(['/settings?member=u1']);

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('sam@corp.io')).toBeInTheDocument();
 });

 it('hides the Custom fields section from a viewer', async () => {
  // A viewer holds no `custom_fields.read`; the section must not appear.
  stubMembers({ role: 'viewer', membersStatus: 403, assignable: [] });

  renderSettings();

  await screen.findByText(/need the users permission/i);
  expect(screen.queryByRole('heading', { name: 'Custom fields' })).toBeNull();
 });
});
