/**
 * Notifications page tests.
 *
 * Pins the link rendering added for meeting invites: a server-issued
 * internal path renders as a router link, anything else (or nothing) renders
 * as plain text, so a stored absolute URL can never become a link out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
