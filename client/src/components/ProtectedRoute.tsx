import { Navigate, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';
import { useAuth } from '../lib/auth';

/**
 * Gate for authenticated routes.
 *
 * While the `GET /auth/me` bootstrap is in flight we render a neutral status
 * instead of redirecting -- bouncing the user to `/login` and then straight back
 * would be a visible flash on every reload. Once the session is known, an
 * unauthenticated visitor is sent to `/login` with the attempted path preserved
 * so they return to it after signing in.
 */
export function ProtectedRoute({ children }: { children: ReactElement }): JSX.Element {
 const { isAuthenticated, isLoading } = useAuth();
 const location = useLocation();

 if (isLoading) {
 return (
 <div className="route-status" role="status" aria-live="polite">
 Loading your workspace...
 </div>
 );
 }

 if (!isAuthenticated) {
 return <Navigate to="/login" replace state={{ from: location.pathname }} />;
 }

 return children;
}