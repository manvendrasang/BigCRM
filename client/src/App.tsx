import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AuthenticatedShell } from './components/AuthenticatedShell';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { Dashboard } from './pages/Dashboard';
import { RecordList } from './pages/records/RecordList';
import { RecordDetail } from './pages/records/RecordDetail';
import { ProjectDetail } from './pages/records/ProjectDetail';
import { RecordCreate } from './pages/records/RecordCreate';
import { GlobalSearch } from './pages/Search';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Notifications } from './pages/Notifications';
import { AuditLogs } from './pages/AuditLogs';
import { SavedViews } from './pages/SavedViews';
import { Calendar } from './pages/Calendar';
import { DealBoard } from './pages/DealBoard';

/**
 * Route table. `/` is a redirect rather than a route of its own so that an
 * unauthenticated visitor always lands somewhere that explains itself.
 *
 * Record sections share one shell (header, nav, content) and one generic page
 * per action. List, create and detail are separate routes so each is
 * deep-linkable and the browser back button behaves as users expect.
 */
function shelled(element: JSX.Element): JSX.Element {
  return (
    <ProtectedRoute>
      <AuthenticatedShell>{element}</AuthenticatedShell>
    </ProtectedRoute>
  );
}

type RecordPath = 'contacts' | 'companies' | 'leads' | 'deals' | 'tasks';

function recordRoutes(path: string, type: RecordPath): JSX.Element {
  // Deals open the dedicated project window; every other type shares the
  // generic detail page. The URL stays `/deals/:id` so existing links keep
  // working — only what renders behind it changes.
  const detail = type === 'deals' ? <ProjectDetail /> : <RecordDetail type={type} />;
  return (
    <>
      <Route path={path} element={shelled(<RecordList type={type} />)} />
      <Route path={`${path}/new`} element={shelled(<RecordCreate type={type} />)} />
      <Route path={`${path}/:id`} element={shelled(detail)} />
    </>
  );
}

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/dashboard" element={shelled(<Dashboard />)} />
      <Route path="/search" element={shelled(<GlobalSearch />)} />
      <Route path="/reports" element={shelled(<Reports />)} />
      <Route path="/notifications" element={shelled(<Notifications />)} />
      <Route path="/audit" element={shelled(<AuditLogs />)} />
      <Route path="/views" element={shelled(<SavedViews />)} />
      <Route path="/calendar" element={shelled(<Calendar />)} />
      <Route path="/deals/board" element={shelled(<DealBoard />)} />
      <Route path="/settings" element={shelled(<Settings />)} />
      {recordRoutes('/contacts', 'contacts')}
      {recordRoutes('/companies', 'companies')}
      {recordRoutes('/leads', 'leads')}
      {recordRoutes('/deals', 'deals')}
      {recordRoutes('/tasks', 'tasks')}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default App;