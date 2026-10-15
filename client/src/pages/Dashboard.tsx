import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { money } from '../lib/records';
import { useAuth } from '../lib/auth';
import { KpiCard, KpiLinkCard } from '../components/ui';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  member: 'Member',
  viewer: 'Viewer',
};

interface Overview {
  contacts: number;
  companies: number;
  leads: number;
  openDeals: number;
  openDealValueC: number | string;
  openTasks: number;
}

/**
 * Workspace overview.
 *
 * Rendered inside `AuthenticatedShell`, which provides the header and nav —
 * this page owns only its content. The stat cards come from the `overview`
 * report (`GET /api/v1/reports/overview`), so the numbers here and the numbers
 * on the Reports page cannot disagree: same endpoint, same definitions.
 *
 * A failed overview degrades to the session cards rather than an error page.
 * Knowing who you are signed in as is more important than knowing how many
 * contacts you have, and a reporting outage must not lock the user out of the
 * navigation that leads everywhere else.
 */
export function Dashboard(): JSX.Element {
  const { user, actor } = useAuth();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState(false);

  const role = actor?.role ?? 'member';
  const roleLabel = ROLE_LABELS[role] ?? role;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await api.get<unknown>('/reports/overview');
        if (!cancelled && typeof body === 'object' && body !== null) setOverview(body as Overview);
      } catch (err) {
        // 403 (no reports.read) and network failures both land here. Either
        // way the session cards still render; the counts simply stay hidden.
        if (!cancelled) {
          setOverview(null);
          setOverviewError(err instanceof ApiError && err.status !== 403);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <h1>Dashboard</h1>
      <p className="muted">
        Signed in as <strong>{user?.name || user?.email}</strong>.
      </p>

      <div className="grid">
        <KpiCard title="Organization" value={actor?.organizationId ? 'Active' : '—'} note="Tenant-scoped workspace" />
        <KpiCard title="Your role" value={roleLabel} note="Determines what you can read and change" />
        <KpiCard
          title="Email verification"
          value={user?.emailVerified ? 'Verified' : 'Pending'}
          note={user?.mfaEnabled ? 'Multi-factor authentication is on' : 'No MFA enrolled'}
        />
      </div>

      {overview && (
        <>
          <h2>Workspace</h2>
          <div className="grid">
            <KpiLinkCard title="Contacts" value={overview.contacts.toLocaleString()} note="View all →" to="/contacts" />
            <KpiLinkCard title="Companies" value={overview.companies.toLocaleString()} note="View all →" to="/companies" />
            <KpiLinkCard title="Leads" value={overview.leads.toLocaleString()} note="View all →" to="/leads" />
            <KpiLinkCard
              title="Open projects"
              value={overview.openDeals.toLocaleString()}
              note={`${money(Number(overview.openDealValueC) || 0)} open value`}
              to="/deals"
            />
            <KpiLinkCard title="Open tasks" value={overview.openTasks.toLocaleString()} note="View all →" to="/tasks" />
          </div>
        </>
      )}

      {overviewError && (
        <p className="muted">Workspace counts are unavailable right now.</p>
      )}
    </div>
  );
}

export default Dashboard;