/**
 * Project window tests.
 *
 * A clicked deal must open the whole project: header stats, the interactive
 * stage stepper, the linked company, and the record's tasks — not the generic
 * detail grid. Moving through the stepper posts to the stage endpoint and
 * reloads, exactly like the board does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../lib/auth';
import { resetApiClient, setFetchImplementation } from '../../lib/api';
import { ProjectDetail } from './ProjectDetail';

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
    if ((init as { method?: string })?.method === 'POST' && url.includes('/deals/d1/stage')) {
      posted.push({ url, body: String((init as { body?: unknown })?.body ?? '') });
      return jsonResponse({ data: { id: 'd1' } });
    }
    if ((init as { method?: string })?.method === 'PATCH' && url.includes('/deals/d1')) {
      posted.push({ url, body: String((init as { body?: unknown })?.body ?? '') });
      return jsonResponse({ data: { id: 'd1', name: 'Acme expansion' } });
    }
    if ((init as { method?: string })?.method === 'DELETE' && url.includes('/deals/d1')) {
      posted.push({ url, body: '' });
      return new Response(null, { status: 204 });
    }
    if (url.includes('/deals/d1')) {
      return jsonResponse({
        data: {
          id: 'd1', name: 'Acme renewal', value_c: 100000, currency: 'USD',
          status: 'open', probability: 40, pipeline_id: 'p1', stage_id: 's1',
          company_id: 'c1', contact_id: null, source: 'referral',
        },
      });
    }
    if (url.includes('/pipelines/p1/stages')) {
      return jsonResponse([
        { id: 's1', name: 'New', position: 0, probability: 10, is_won: false, is_lost: false },
        { id: 's2', name: 'Won', position: 1, probability: 100, is_won: true, is_lost: false },
      ]);
    }
    if (url.includes('/companies/c1')) {
      return jsonResponse({ data: { id: 'c1', name: 'Acme Widgets' } });
    }
    if (url.includes('/tasks?')) {
      return jsonResponse({
        data: [{ id: 't1', title: 'Send deck', status: 'todo', priority: 'high', due_date: null }],
        pageInfo: { limit: 50, offset: 0, totalCount: 1, hasMore: false },
      });
    }
    if (url.includes('/activities/')) {
      return jsonResponse([]);
    }
    return jsonResponse({ data: {} }, 404);
  });
}

function renderProject(): void {
  render(
    <MemoryRouter initialEntries={['/deals/d1']}>
      <AuthProvider>
        <Routes>
          <Route path="/deals/:id" element={<ProjectDetail />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('ProjectDetail page', () => {
  it('opens the whole project: stats, stepper, company, tasks', async () => {
    stub();
    renderProject();

    expect(await screen.findByRole('heading', { name: 'Acme renewal' })).toBeInTheDocument();
    // Value shows both in the header stat and the detail grid.
    expect(screen.getAllByText('$1,000.00')).toHaveLength(2);
    const progress = await screen.findByRole('region', { name: 'Pipeline progress' });
    expect(within(progress).getByText('New')).toBeInTheDocument();
    expect(within(progress).getByText('Won')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme Widgets' })).toHaveAttribute('href', '/companies/c1');
    // Generous timeout: under coverage instrumentation this file shares the
    // box with eleven others, and the tasks fetch is the last of several
    // parallel loads to settle.
    expect(await screen.findByRole('link', { name: 'Send deck' }, { timeout: 5000 })).toHaveAttribute(
      'href',
      '/tasks/t1',
    );
  });

  it('moving through the stepper posts and confirms first', async () => {
    const user = userEvent.setup();
    stub();
    renderProject();

    const progress = await screen.findByRole('region', { name: 'Pipeline progress' });
    await user.click(within(progress).getByRole('button', { name: 'Move project to Won' }));

    // The dialog asks because Won ends the project.
    expect(await screen.findByText('This marks the project won.')).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]!.url).toContain('/deals/d1/stage');
    expect(posted[0]!.body).toContain('s2');
  });

  it('edits fields inline and saves', async () => {
    const user = userEvent.setup();
    stub();
    renderProject();

    await screen.findByRole('heading', { name: 'Acme renewal' });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const nameInput = screen.getByRole('textbox', { name: /Name/ });
    await user.clear(nameInput);
    await user.type(nameInput, 'Acme expansion');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]!.body).toContain('Acme expansion');
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('deletes through the confirm dialog', async () => {
    const user = userEvent.setup();
    stub();
    renderProject();

    await screen.findByRole('heading', { name: 'Acme renewal' });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('It can be restored afterwards.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]!.url).toContain('/deals/d1');
  });
});
