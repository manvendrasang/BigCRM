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

const posted: { url: string; body: string }[] = [];

function stubMembers(opts: {
 members?: unknown[];
 membersStatus?: number;
 assignable?: string[];
 postStatus?: number;
} = {}): void {
 const { members = [], membersStatus = 200, assignable = ['manager', 'sales', 'viewer'], postStatus = 201 } = opts;
 posted.length = 0;
 setFetchImplementation(async (url, init) => {
  const method = String((init as { method?: string })?.method ?? 'GET');

  if (url.includes('/org/members') && method === 'POST') {
   posted.push({ url, body: String((init as { body?: unknown })?.body ?? '') });
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

const renderSettings = (): void => {
 render(
  <MemoryRouter>
   <Settings />
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
