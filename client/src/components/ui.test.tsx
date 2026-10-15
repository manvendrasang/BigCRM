/**
 * Shared UI primitive tests.
 *
 * These pin the contracts pages rely on: the badge renders nothing at zero
 * (so the nav stays clean), the dialog only resolves through its buttons or
 * Escape, and cancellation focuses nothing destructive on open.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
 ConfirmDialog,
 CountBadge,
 EmptyState,
 KpiCard,
 KpiLinkCard,
 Section,
 useConfirm,
} from './ui';

describe('EmptyState', () => {
 it('renders the message', () => {
 render(<EmptyState message="No records yet." />);
 expect(screen.getByText('No records yet.')).toBeInTheDocument();
 });
});

describe('KpiCard', () => {
 it('renders title, value and note', () => {
 render(<KpiCard title="Contacts" value="12" note="View all ->" />);
 expect(screen.getByText('Contacts')).toBeInTheDocument();
 expect(screen.getByText('12')).toBeInTheDocument();
 expect(screen.getByText('View all ->')).toBeInTheDocument();
 });

 it('omits the note when none is given', () => {
 const { container } = render(<KpiCard title="Contacts" value="12" />);
 expect(container.querySelector('.stat-note')).toBeNull();
 });
});

describe('KpiLinkCard', () => {
 it('links to the given route', () => {
 render(
 <MemoryRouter>
 <KpiLinkCard title="Contacts" value="12" to="/contacts" />
 </MemoryRouter>,
 );
 expect(screen.getByRole('link')).toHaveAttribute('href', '/contacts');
 });
});

describe('Section', () => {
 it('renders the title and children', () => {
 render(
 <Section title="Files">
 <p>child</p>
 </Section>,
 );
 expect(screen.getByText('Files')).toBeInTheDocument();
 expect(screen.getByText('child')).toBeInTheDocument();
 });
});

describe('CountBadge', () => {
 it('renders nothing at zero so the nav stays clean', () => {
 const { container } = render(<CountBadge count={0} />);
 expect(container).toBeEmptyDOMElement();
 });

 it('shows the count', () => {
 render(<CountBadge count={3} />);
 expect(screen.getByText('3')).toBeInTheDocument();
 });

 it('caps large counts', () => {
 render(<CountBadge count={120} />);
 expect(screen.getByText('99+')).toBeInTheDocument();
 });
});

describe('ConfirmDialog', () => {
 it('renders nothing when closed', () => {
 const { container } = render(
 <ConfirmDialog open={false} title="Delete?" confirmLabel="Delete" onConfirm={() => {}} onCancel={() => {}} />,
 );
 expect(container).toBeEmptyDOMElement();
 });

 it('focuses the safe action on open', () => {
 render(
 <ConfirmDialog open title="Delete?" confirmLabel="Delete" onConfirm={() => {}} onCancel={() => {}} />,
 );
 expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
 });

 it('Escape dismisses without confirming', async () => {
 const onConfirm = vi.fn();
 const onCancel = vi.fn();
 render(<ConfirmDialog open title="Delete?" confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel} />);
 fireEvent.keyDown(document, { key: 'Escape' });
 expect(onCancel).toHaveBeenCalledTimes(1);
 expect(onConfirm).not.toHaveBeenCalled();
 });

 it('confirm and cancel invoke their handlers', async () => {
 const user = userEvent.setup();
 const onConfirm = vi.fn();
 const onCancel = vi.fn();
 render(<ConfirmDialog open title="Delete?" confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel} />);
 await user.click(screen.getByRole('button', { name: 'Delete' }));
 expect(onConfirm).toHaveBeenCalledTimes(1);
 await user.click(screen.getByRole('button', { name: 'Cancel' }));
 expect(onCancel).toHaveBeenCalledTimes(1);
 });
});

describe('useConfirm', () => {
 function Harness({ onResult }: { onResult: (v: boolean) => void }): JSX.Element {
 const { confirm, dialog } = useConfirm();
 return (
 <div>
 <button
 type="button"
 onClick={() => {
 void confirm({ title: 'Delete this view?', confirmLabel: 'Delete' }).then(onResult);
 }}
 >
 trigger
 </button>
 {dialog}
 </div>
 );
 }

 it('resolves true on confirm and false on cancel', async () => {
 const user = userEvent.setup();
 const onResult = vi.fn();
 render(<Harness onResult={onResult} />);

 await user.click(screen.getByRole('button', { name: 'trigger' }));
 expect(screen.getByText('Delete this view?')).toBeInTheDocument();
 await user.click(screen.getByRole('button', { name: 'Delete' }));
 expect(onResult).toHaveBeenCalledWith(true);

 await user.click(screen.getByRole('button', { name: 'trigger' }));
 await user.click(screen.getByRole('button', { name: 'Cancel' }));
 expect(onResult).toHaveBeenCalledWith(false);
 });
});
