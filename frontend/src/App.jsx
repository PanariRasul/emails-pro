import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './store/auth.js';
import Layout, { ConnectionBanner } from './components/Layout.jsx';
import { Loading, Toasts } from './components/ui.jsx';

// Route-level code splitting: each page is its own chunk.
const P = {
  Home: lazy(() => import('./pages/public/Home.jsx')),
  Features: lazy(() => import('./pages/public/Features.jsx')),
  HowTo: lazy(() => import('./pages/public/HowTo.jsx')),
  Why: lazy(() => import('./pages/public/Why.jsx')),
  Login: lazy(() => import('./pages/Login.jsx')),
};
const S = {
  Help: lazy(() => import('./pages/shared/Help.jsx')),
  Profile: lazy(() => import('./pages/shared/Profile.jsx')),
};
const E = {
  Dashboard: lazy(() => import('./pages/employee/Dashboard.jsx')),
  Accounts: lazy(() => import('./pages/employee/Accounts.jsx')),
  Campaigns: lazy(() => import('./pages/employee/Campaigns.jsx')),
  CampaignNew: lazy(() => import('./pages/employee/CampaignNew.jsx')),
  CampaignDetail: lazy(() => import('./pages/employee/CampaignDetail.jsx')),
  Pitches: lazy(() => import('./pages/employee/Pitches.jsx')),
  Lists: lazy(() => import('./pages/employee/Lists.jsx')),
  Inbox: lazy(() => import('./pages/employee/Inbox.jsx')),
  Analytics: lazy(() => import('./pages/employee/Analytics.jsx')),
  History: lazy(() => import('./pages/employee/History.jsx')),
  Suppressions: lazy(() => import('./pages/employee/Suppressions.jsx')),
  Settings: lazy(() => import('./pages/employee/Settings.jsx')),
};
const A = {
  Dashboard: lazy(() => import('./pages/admin/Dashboard.jsx')),
  Employees: lazy(() => import('./pages/admin/Employees.jsx')),
  EmployeeDetail: lazy(() => import('./pages/admin/EmployeeDetail.jsx')),
  Accounts: lazy(() => import('./pages/admin/Accounts.jsx')),
  Campaigns: lazy(() => import('./pages/admin/Campaigns.jsx')),
  Deliverability: lazy(() => import('./pages/admin/Deliverability.jsx')),
  Reports: lazy(() => import('./pages/admin/Reports.jsx')),
  Health: lazy(() => import('./pages/admin/Health.jsx')),
  Audit: lazy(() => import('./pages/admin/Audit.jsx')),
  Settings: lazy(() => import('./pages/admin/Settings.jsx')),
};

function Splash() {
  return (
    <div className="flex min-h-screen flex-col">
      <ConnectionBanner />
      <div className="flex flex-1 items-center justify-center"><Loading label="Connecting to Emails Pro…" /></div>
    </div>
  );
}

/** Guards app routes: waits for session restore, sends anonymous users to /login, enforces role. */
function Protected({ role }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Splash />;
  if (status !== 'authenticated') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (user.role !== role) return <Navigate to={user.role === 'ADMIN' ? '/admin' : '/app'} replace />;
  return <Layout />;
}

export default function App() {
  const bootstrap = useAuth((s) => s.bootstrap);
  useEffect(() => { bootstrap(); }, [bootstrap]);

  return (
    <>
      <Suspense fallback={<Loading />}>
        <Routes>
          {/* Public site */}
          <Route path="/" element={<P.Home />} />
          <Route path="/features" element={<P.Features />} />
          <Route path="/how-to-use" element={<P.HowTo />} />
          <Route path="/why-emails-pro" element={<P.Why />} />
          <Route path="/login" element={<P.Login />} />
          <Route path="/forgot-password" element={<P.Login mode="forgot" />} />

          {/* Employee workspace */}
          <Route path="/app" element={<Protected role="EMPLOYEE" />}>
            <Route index element={<E.Dashboard />} />
            <Route path="accounts" element={<E.Accounts />} />
            <Route path="campaigns" element={<E.Campaigns />} />
            <Route path="campaigns/new" element={<E.CampaignNew />} />
            <Route path="campaigns/:id" element={<E.CampaignDetail />} />
            <Route path="pitches" element={<E.Pitches />} />
            <Route path="lists" element={<E.Lists />} />
            <Route path="inbox" element={<E.Inbox />} />
            <Route path="analytics" element={<E.Analytics />} />
            <Route path="history" element={<E.History />} />
            <Route path="suppressions" element={<E.Suppressions />} />
            <Route path="settings" element={<E.Settings />} />
            <Route path="profile" element={<S.Profile />} />
            <Route path="help" element={<S.Help />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Route>

          {/* Admin console (no campaign creation/sending screens) */}
          <Route path="/admin" element={<Protected role="ADMIN" />}>
            <Route index element={<A.Dashboard />} />
            <Route path="employees" element={<A.Employees />} />
            <Route path="employees/:id" element={<A.EmployeeDetail />} />
            <Route path="accounts" element={<A.Accounts />} />
            <Route path="campaigns" element={<A.Campaigns />} />
            <Route path="deliverability" element={<A.Deliverability />} />
            <Route path="reports" element={<A.Reports />} />
            <Route path="health" element={<A.Health />} />
            <Route path="audit" element={<A.Audit />} />
            <Route path="settings" element={<A.Settings />} />
            <Route path="profile" element={<S.Profile />} />
            <Route path="help" element={<S.Help />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Route>

          {/* Old links (before the /app prefix) */}
          <Route path="/accounts" element={<Navigate to="/app/accounts" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Toasts />
    </>
  );
}
