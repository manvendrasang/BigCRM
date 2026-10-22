/**
 * Notifications page tests.
 *
 * Pins the link rendering added for meeting invites: a server-issued
 * internal path renders as a router link, anything else (or nothing) renders
 * as plain text, so a stored absolute URL can never become a link out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { resetApiClient, setFetchImplementation } from '../lib/api';
import { Notifications } from './Notifications';

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

describe('Notifications page', () => {
 it('renders an internal link as a router link and the rest as text', async () => {
 setFetchImplementation(async () =>
 jsonResponse({
 items: [
 {
 id: 'n1', type: 'meeting_invite', title: 'You are invited: Kickoff',
 body: '', link: '/calendar', readAt: null, createdAt: '2026-11-01T00:00:00Z',
 },
 {
 id: 'n2', type: 'note', title: 'Plain note',
 body: '', link: null, readAt: null, createdAt: '2026-11-01T00:00:00Z',
 },
 {
 id: 'n3', type: 'note', title: 'External',
 body: '', link: 'https://evil.example/x', readAt: null, createdAt: '2026-11-01T00:00:00Z',
 },
 ],
 unread: 3,
 }),
 );

 render(
 <MemoryRouter>
 <Notifications />
 </MemoryRouter>,
 );

 expect(await screen.findByRole('link', { name: 'You are invited: Kickoff' })).toHaveAttribute(
 'href', '/calendar',
 );
 expect(screen.getByText('Plain note').tagName).toBe('TD');
 expect(screen.getByText('External').tagName).toBe('TD');
 });

 it('a calendar event notification opens the shared event window', async () => {
 const user = userEvent.setup();
 setFetchImplementation(async (url) =>
 url.includes('/calendar/events/task/')
 ? jsonResponse({
 data: {
 id: 't1', kind: 'task', title: 'Proposal', description: 'Send it.',
 when: '2026-11-12T12:00:00Z', status: 'in_progress', priority: 'high',
 creatorId: 'u1', creatorName: 'Ava', assigneeId: 'u2', assigneeName: 'Noah',
 entityType: null, entityId: null, relatedType: 'deal', relatedId: 'd1',
 },
 })
 : jsonResponse({
 items: [
 {
 id: 'n4', type: 'calendar_task', title: 'Task scheduled: Proposal',
 body: '', link: '/calendar', entityType: 'task', entityId: 't1',
 readAt: '2026-11-01T00:00:00Z', createdAt: '2026-11-01T00:00:00Z',
 },
 ],
 unread: 0,
 }),
 );

 render(
 <MemoryRouter>
 <Notifications />
 </MemoryRouter>,
 );

 // The title is a button, not a link: the event opens in place, in the very
 // same window the calendar chip opens.
 await user.click(await screen.findByRole('button', { name: 'Task scheduled: Proposal' }));

 const dialog = await screen.findByRole('dialog');
 expect(within(dialog).getByText('Calendar task')).toBeInTheDocument();
 expect(await within(dialog).findByText('Send it.')).toBeInTheDocument();
 expect(within(dialog).getByText('in progress')).toBeInTheDocument();
 expect(within(dialog).getByText('Noah')).toBeInTheDocument();

 // Both the related record and the task itself are one click away.
 const links = within(dialog).getAllByRole('link', { name: 'Open record' });
 expect(links.map((l) => l.getAttribute('href'))).toEqual(['/deals/d1', '/tasks/t1']);
 });

 it('a due reminder opens the same window as any other event', async () => {
 const user = userEvent.setup();
 setFetchImplementation(async (url) =>
 url.includes('/calendar/events/task/')
 ? jsonResponse({
 data: {
 id: 't2', kind: 'task', title: 'Renew contract', description: null,
 when: '2026-11-12T12:00:00Z', status: 'todo', priority: 'high',
 creatorId: 'u1', creatorName: 'Ava', assigneeId: null, assigneeName: null,
 entityType: null, entityId: null, relatedType: null, relatedId: null,
 },
 })
 : jsonResponse({
 items: [
 // Both lead times of the same task, as the reminder scheduler writes them.
 {
 id: 'n5', type: 'calendar_due_1h', title: 'Due in 1 hour: Renew contract',
 body: '"Renew contract" is due at 2026-11-12T12:00:00.000Z.',
 link: '/calendar', entityType: 'task', entityId: 't2',
 readAt: null, createdAt: '2026-11-12T11:00:00Z',
 },
 {
 id: 'n6', type: 'calendar_due_15m', title: 'Due in 15 minutes: Renew contract',
 body: '', link: '/calendar', entityType: 'task', entityId: 't2',
 readAt: null, createdAt: '2026-11-12T11:45:00Z',
 },
 ],
 unread: 2,
 }),
 );

 render(
 <MemoryRouter>
 <Notifications />
 </MemoryRouter>,
 );

 // Both countdowns are buttons, and both land in the one event window.
 await user.click(await screen.findByRole('button', { name: 'Due in 1 hour: Renew contract' }));
 const dialog = await screen.findByRole('dialog');
 expect(within(dialog).getByText('Calendar task')).toBeInTheDocument();
 expect(within(dialog).getByText('Renew contract')).toBeInTheDocument();

 await user.click(await screen.findByRole('button', { name: 'Due in 15 minutes: Renew contract' }));
 expect(await screen.findByRole('dialog')).toBeInTheDocument();
 });
});
