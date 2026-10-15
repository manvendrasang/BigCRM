/**
 * Authenticated page shell: header, nav, content.
 *
 * Every signed-in page shares this frame so the brand, the user chip, the nav
 * and the sign-out button cannot drift between sections. Pages render their
 * content as children; they never build their own header.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { listNotifications } from '../lib/workspace';
import { AppNav } from './AppNav';
import { ThemeSwitcher } from './ThemeSwitcher';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  member: 'Member',
  viewer: 'Viewer',
};

export function AuthenticatedShell({ children }: { children: ReactNode }): JSX.Element {
  const { user, actor, logout } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const location = useLocation();

  const role = actor?.role ?? 'member';
  const roleLabel = ROLE_LABELS[role] ?? role;

  // The drawer is a viewport concern, not a route concern: any navigation
  // closes it, so the back button can never strand it open.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Unread badge for the Notifications nav link. Refreshed on every
  // navigation and once a minute while the shell sits open; failures are
  // silent because the badge is auxiliary — the Notifications page itself
  // reports its own errors, and a signed-out shell unmounts anyway.
  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const result = await listNotifications(true);
        if (!cancelled) setUnread(result.unread);
      } catch {
        /* badge stays at its last known count */
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [location.pathname]);

  async function handleLogout(): Promise<void> {
    setIsSigningOut(true);
    try {
      await logout();
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-brand">
          <button
            type="button"
            className="nav-toggle"
            aria-expanded={navOpen}
            aria-controls="primary-nav"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            onClick={() => setNavOpen((v) => !v)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <span className="brand-mark" aria-hidden="true">
            B
          </span>
          <div>
            <p className="brand-name">BigCRM</p>
            <p className="brand-org">{actor?.name ? `${actor.name}'s workspace` : 'Workspace'}</p>
          </div>
        </div>

        <div className="app-header-actions">
          <ThemeSwitcher />
          <span className="user-chip">
            <span className="user-email">{user?.email ?? ''}</span>
            <span className="user-role">{roleLabel}</span>
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { void handleLogout(); }}
            disabled={isSigningOut}
          >
            {isSigningOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <AppNav unreadCount={unread} drawerOpen={navOpen} onNavigate={() => setNavOpen(false)} />

      <main className="app-main">{children}</main>
    </div>
  );
}
