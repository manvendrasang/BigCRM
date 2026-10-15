/**
 * Primary navigation between record sections.
 *
 * Rendered inside the authenticated shell on every record page. `NavLink`
 * marks the current section so the user always knows where they are; the
 * dashboard link returns to the overview.
 *
 * On narrow viewports the bar becomes a slide-over drawer: the shell owns the
 * open state and the hamburger, this component renders the scrim and the
 * panel. Desktop rendering is unchanged -- the drawer attributes are inert
 * above the breakpoint.
 */
import { NavLink } from 'react-router-dom';
import { CountBadge } from './ui';

const SECTIONS = [
 { to: '/dashboard', label: 'Dashboard' },
 { to: '/contacts', label: 'Contacts' },
 { to: '/companies', label: 'Companies' },
 { to: '/leads', label: 'Leads' },
 { to: '/deals', label: 'Projects' },
 { to: '/tasks', label: 'Tasks' },
 { to: '/calendar', label: 'Calendar' },
 { to: '/search', label: 'Search' },
 { to: '/reports', label: 'Reports' },
 { to: '/notifications', label: 'Notifications' },
 { to: '/audit', label: 'Audit log' },
 { to: '/views', label: 'Saved views' },
 { to: '/settings', label: 'Settings' },
] as const;

/**
 * Links a viewer must not see.
 *
 * A viewer is a strictly read-only seat: the RBAC matrix gives them no
 * `reports.read` (earnings), no `saved_views.read` and no `audit.read`, so the
 * server rejects these pages regardless. Hiding the links keeps the nav honest
 * instead of offering doors that only open onto a "you need permission" note.
 * Every other section stays, because a viewer reads records.
 */
const VIEWER_HIDDEN: readonly string[] = ['/reports', '/audit', '/views'];

export function AppNav({
 unreadCount = 0,
 drawerOpen = false,
 onNavigate,
 role,
}: {
 unreadCount?: number;
 drawerOpen?: boolean;
 onNavigate?: () => void;
 /** Current actor role; drives which links are offered. */
 role?: string;
}): JSX.Element {
 const sections = role === 'viewer'
 ? SECTIONS.filter((s) => !VIEWER_HIDDEN.includes(s.to))
 : SECTIONS;
 return (
 <>
 <div
 className="nav-scrim"
 data-open={drawerOpen}
 aria-hidden="true"
 onClick={onNavigate}
 />
 <nav id="primary-nav" className="app-nav" aria-label="Primary" data-open={drawerOpen}>
 {sections.map((s) => (
 <NavLink
 key={s.to}
 to={s.to}
 className={({ isActive }) => (isActive ? 'active' : '')}
 onClick={onNavigate}
 >
 {s.label}
 {s.to === '/notifications' && <CountBadge count={unreadCount} />}
 </NavLink>
 ))}
 </nav>
 </>
 );
}
