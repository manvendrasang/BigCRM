/**
 * Deal board page tests.
 *
 * The board moves through the stubbed stage endpoint and reloads: the move
 * menu posts the chosen stage, and the server (stubbed here) is what applies
 * won/lost -- the page never computes status, and these tests pin that the
 * page does not try.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../lib/auth';
import { resetApiClient, setFetchImplementation } from '../lib/api';
import { DealBoard } from './DealBoard';

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

function stub(role: string): void {
 posted.length = 0;
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
 if (url.includes('/pipelines?')) {
 return jsonResponse({ data: [{ id: 'p1', name: 'Sales Pipeline' }], pageInfo: {} });
 }
 if (url.includes('/pipelines/p1/stages')) {
 return jsonResponse([
 { id: 's1', name: 'New', position: 0, probability: 10, is_won: false, is_lost: false },
 { id: 's2', name: 'Won', position: 1, probability: 100, is_won: true, is_lost: false },
 ]);
 }
 if (url.includes('/deals?')) {
 return jsonResponse({
 data: [
 { id: 'd1', name: 'Acme deal', value_c: 50000, currency: 'USD', status: 'open', stage_id: 's1' },
 ],
 pageInfo: { limit: 200, offset: 0, totalCount: 1, hasMore: false },
 });
 }
 if (url.includes('/deals/d1/stage')) {
 posted.push({ url, body: String((init as { body?: unknown })?.body ?? '') });
 return jsonResponse({ data: { id: 'd1' } });
 }
 return jsonResponse({ data: {} }, 404);
 });
}

function renderBoard(): void {
 render(
 <MemoryRouter>
 <AuthProvider>
 <DealBoard />
 </AuthProvider>
 </MemoryRouter>,
 );
}

describe('DealBoard page', () => {
 it('renders one column per stage with the deal inside', async () => {
 stub('owner');
 renderBoard();

 const board = await screen.findByRole('list', { name: 'Deal stages' });
 expect(within(board).getByRole('listitem', { name: 'New' })).toBeInTheDocument();
 expect(within(board).getByRole('listitem', { name: 'Won' })).toBeInTheDocument();
 expect(screen.getByRole('link', { name: 'Acme deal' })).toHaveAttribute('href', '/deals/d1');
 });

 it('moving a deal through the menu posts the chosen stage', async () => {
 const user = userEvent.setup();
 stub('owner');
 renderBoard();

 await screen.findByRole('link', { name: 'Acme deal' });
 const menu = screen.getByRole('combobox', { name: 'Move Acme deal to another stage' });
 await user.selectOptions(menu, 's2');

 await waitFor(() => {
 expect(posted).toHaveLength(1);
 });
 expect(posted[0]!.url).toContain('/deals/d1/stage');
 expect(posted[0]!.body).toContain('s2');
 });

 it('viewers get a read-only board with no move menus', async () => {
 stub('viewer');
 renderBoard();

 await screen.findByRole('link', { name: 'Acme deal' });
 expect(screen.queryByRole('combobox', { name: /Move .* to another stage/ })).toBeNull();
 });
});
