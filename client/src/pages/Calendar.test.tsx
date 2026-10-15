/**
 * Calendar page tests.
 *
 * Rendered inside the real `AuthProvider` with fetch stubbed by URL, so these
 * prove the page wiring (grid -> agenda -> invite dialog) rather than the
 * pieces in isolation. The provider restores its session from `/auth/me`,
 * which is also stubbed -- the role in that response drives the
 * viewer/non-viewer branches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../lib/auth';
import { resetApiClient, setFetchImplementation } from '../lib/api';
import { Calendar } from './Calendar';

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

function stub(role: string): { dayKey: string } {
 // The 15th of next month, whatever "now" is -- always one "Next month" away
 // and always in-month (never a filler cell).
 const now = new Date();
 const nm = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 15));
 const pad = (n: number): string => String(n).padStart(2, '0');
 const dayKey = `${nm.getUTCFullYear()}-${pad(nm.getUTCMonth() + 1)}-15`;
 const at = (hour: string): string => `${dayKey}T${hour}:00.000Z`;
 postedInvites.length = 0;
 setFetchImplementation(async (url, init) => {
 if (url.includes('/auth/me')) {
 return jsonResponse({
 data: {
 user: { id: 'u1', email: 'ava@corp.io', name: 'Ava', emailVerified: true, mfaEnabled: false },
 organizationId: 'o1',
 role,
 },
 });
 }
 if (url.includes('/calendar/invitees')) {
 return jsonResponse([{ id: 'u2', name: 'Ben', email: 'ben@corp.io' }]);
 }
 if (url.includes('/calendar/invites')) {
 if ((init as { method?: string })?.method === 'POST') {
 postedInvites.push(String((init as { body?: unknown })?.body ?? ''));
 return jsonResponse({ data: { id: 'i1', status: 'accepted' } });
 }
 return jsonResponse([
 {
 id: 'i1', status: 'invited', createdAt: dayKey,
 meetingId: 'm9', subject: 'Board review', occurredAt: at('09:00'),
 entityType: 'deal', entityId: 'd9', inviterName: 'Ben',
 },
 ]);
 }
 if (url.includes('/calendar/meetings/')) {
 return jsonResponse({ data: { invited: [{ id: 'i1' }], alreadyInvited: [] } });
 }
 if (url.includes('/calendar?')) {
 return jsonResponse({
 data: {
 from: dayKey,
 to: dayKey,
 meetings: [
 {
 id: 'm1', entityType: 'contact', entityId: 'c1',
 subject: 'Kickoff', description: null,
 occurredAt: at('10:00'), actorId: 'u1', actorName: 'Ava',
 },
 ],
 tasks: [
 {
 id: 't1', title: 'Proposal', status: 'todo', priority: 'high',
 dueDate: at('12:00'), relatedType: null, relatedId: null,
 },
 ],
 },
 });
 }
 return jsonResponse({ data: {} }, 404);
 });
 return { dayKey };
}

function renderCalendar(): void {
 render(
 <MemoryRouter>
 <AuthProvider>
 <Calendar />
 </AuthProvider>
 </MemoryRouter>,
 );
}

const postedInvites: string[] = [];

describe('Calendar page', () => {
 it('renders the month grid with weekday headers', async () => {
 stub('owner');
 renderCalendar();

 for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
 expect(await screen.findByRole('columnheader', { name: day })).toBeInTheDocument();
 }
 // The stubbed agenda is mid-November; navigate there from October.
 await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
 // Chips from the stubbed agenda land on the 15th.
 expect(await screen.findByTitle('Kickoff')).toBeInTheDocument();
 expect(await screen.findByTitle('Proposal')).toBeInTheDocument();
 });

 it('selecting a day shows its agenda with record links', async () => {
 const { dayKey } = stub('owner');
 renderCalendar();

 await screen.findByRole('columnheader', { name: 'Mon' });
 await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
 await screen.findByTitle('Kickoff');
 const day = screen.getByRole('button', { name: new RegExp(dayKey) });
 await userEvent.click(day);

 const agenda = screen.getByRole('region', { name: 'Agenda' });
 expect(within(agenda).getByRole('link', { name: 'Kickoff' })).toHaveAttribute('href', '/contacts/c1');
 expect(within(agenda).getByRole('link', { name: 'Proposal' })).toHaveAttribute('href', '/tasks/t1');
 });

 it('inviting opens the member picker and confirms', async () => {
 const user = userEvent.setup();
 const { dayKey } = stub('owner');
 renderCalendar();

 await screen.findByRole('columnheader', { name: 'Mon' });
 await user.click(screen.getByRole('button', { name: 'Next month' }));
 await screen.findByTitle('Kickoff');
 await user.click(screen.getByRole('button', { name: new RegExp(dayKey) }));
 await user.click(screen.getByRole('button', { name: 'Invite' }));

 expect(await screen.findByRole('dialog')).toBeInTheDocument();
 await user.click(screen.getByRole('checkbox', { name: /Ben/ }));
 await user.click(screen.getByRole('button', { name: /Invite 1/ }));

 expect(await screen.findByText('1 invited.')).toBeInTheDocument();
 });

 it('viewers see no invite buttons', async () => {
 const { dayKey } = stub('viewer');
 renderCalendar();

 await screen.findByRole('columnheader', { name: 'Mon' });
 await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
 await screen.findByTitle('Kickoff');
 await userEvent.click(screen.getByRole('button', { name: new RegExp(dayKey) }));
 await waitFor(() => {
 expect(screen.getByRole('region', { name: 'Agenda' })).toBeInTheDocument();
 });
 expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
 });

 it('the inbox lists my pending invites and accepts them', async () => {
 const user = userEvent.setup();
 stub('owner');
 renderCalendar();

 const inbox = await screen.findByRole('region', { name: 'Your invitations' });
 expect(within(inbox).getByText('Board review')).toBeInTheDocument();
 await user.click(within(inbox).getByRole('button', { name: 'Accept' }));

 await waitFor(() => {
 expect(postedInvites).toHaveLength(1);
 });
 expect(postedInvites[0]).toContain('accepted');
 });
});
