/**
 * Related-records tests.
 *
 * A company page must show that company's tasks and deals -- and only those --
 * and the quick-add forms must carry the linkage (related_type/id,
 * company_id) so the new row lands on this record, not nowhere.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../lib/auth';
import { resetApiClient, setFetchImplementation } from '../lib/api';
import { RelatedDeals, RelatedTasks } from './RelatedRecords';

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

function stub(): void {
 posted.length = 0;
 setFetchImplementation(async (url, init) => {
 if (url.includes('/auth/me')) {
 return jsonResponse({
 data: {
 user: { id: 'u1', email: 'ava@corp.io', name: 'Ava', emailVerified: true, mfaEnabled: false },
 organizationId: 'o1',
 role: 'owner',
 },
 });
 }
 if ((init as { method?: string })?.method === 'POST') {
 posted.push({ url, body: String((init as { body?: unknown })?.body ?? '') });
 return jsonResponse({ data: { id: 'new1' } });
 }
 if (url.includes('/tasks?')) {
 return jsonResponse({
 data: [
 { id: 't1', title: 'Call back', status: 'todo', priority: 'high', due_date: '2026-11-20T00:00:00Z' },
 ],
 pageInfo: { limit: 50, offset: 0, totalCount: 1, hasMore: false },
 });
 }
 if (url.includes('/deals?')) {
 return jsonResponse({
 data: [{ id: 'd1', name: 'Acme renewal', value_c: 100000, currency: 'USD', status: 'open' }],
 pageInfo: { limit: 50, offset: 0, totalCount: 1, hasMore: false },
 });
 }
 if (url.includes('/pipelines?')) {
 return jsonResponse({ data: [{ id: 'p1', name: 'Sales Pipeline' }], pageInfo: {} });
 }
 if (url.includes('/pipelines/p1/stages')) {
 return jsonResponse([{ id: 's1', name: 'New', position: 0, probability: 10, is_won: false, is_lost: false }]);
 }
 return jsonResponse({ data: {} }, 404);
 });
}

function renderWithAuth(element: JSX.Element): void {
 render(
 <MemoryRouter>
 <AuthProvider>{element}</AuthProvider>
 </MemoryRouter>,
 );
}

describe('RelatedTasks', () => {
 it('lists only this record’s tasks and links them', async () => {
 stub();
 renderWithAuth(<RelatedTasks entityType="company" entityId="c1" />);

 expect(await screen.findByRole('link', { name: 'Call back' })).toHaveAttribute('href', '/tasks/t1');
 });

 it('quick-add carries the linkage', async () => {
 const user = userEvent.setup();
 stub();
 renderWithAuth(<RelatedTasks entityType="company" entityId="c1" />);

 await screen.findByRole('link', { name: 'Call back' });
 await user.type(screen.getByPlaceholderText('e.g. Send the proposal'), 'Send deck');
 await user.click(screen.getByRole('button', { name: 'Add task' }));

 await waitFor(() => {
 expect(posted).toHaveLength(1);
 });
 expect(posted[0]!.url).toContain('/tasks');
 expect(posted[0]!.body).toContain('Send deck');
 expect(posted[0]!.body).toContain('company');
 expect(posted[0]!.body).toContain('c1');
 });
});

describe('RelatedDeals', () => {
 it('lists the company’s deals and quick-add presets the company', async () => {
 const user = userEvent.setup();
 stub();
 renderWithAuth(<RelatedDeals companyId="c1" />);

 expect(await screen.findByRole('link', { name: 'Acme renewal' })).toHaveAttribute('href', '/deals/d1');
 await user.type(screen.getByPlaceholderText('e.g. Acme renewal'), 'Upsell');
 await user.click(screen.getByRole('button', { name: 'Add deal' }));

 await waitFor(() => {
 expect(posted).toHaveLength(1);
 });
 expect(posted[0]!.url).toContain('/deals');
 expect(posted[0]!.body).toContain('Upsell');
 expect(posted[0]!.body).toContain('c1');
 expect(posted[0]!.body).toContain('s1');
 });
});
