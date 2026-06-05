import { Navigate, Route, Routes } from 'react-router-dom'

import AdminLayout from './components/AdminLayout'
import RequireAdmin from './components/RequireAdmin'
import { ConfirmHost } from './components/admin/useConfirm'
import ActivityLog from './pages/admin/ActivityLog'
import AllDashboards from './pages/admin/AllDashboards'
import ClientDetail from './pages/admin/ClientDetail'
import ClientList from './pages/admin/ClientList'
import DashboardConfig from './pages/admin/DashboardConfig'
import GA4Integrations from './pages/admin/GA4Integrations'
import Settings from './pages/admin/Settings'
import Users from './pages/admin/Users'
import Login from './pages/Login'
import PublicDashboard from './pages/public/Dashboard'

export default function App() {
  return (
    <>
    {/* Promise-style confirmation modal — replaces window.confirm()
        everywhere. Mounted once here so the imperative confirm()
        helper has a host to talk to. */}
    <ConfirmHost />
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/login" element={<Login />} />
      <Route
        path="/admin"
        element={
          <RequireAdmin>
            <AdminLayout />
          </RequireAdmin>
        }
      >
        <Route index element={<ClientList />} />
        <Route path="clients/:clientId" element={<ClientDetail />} />
        <Route path="dashboards/:dashboardId" element={<DashboardConfig />} />

        {/* Workspace-wide pages — each fans out across clients. */}
        <Route path="dashboards" element={<AllDashboards />} />
        <Route path="ga4" element={<GA4Integrations />} />
        <Route path="users" element={<Users />} />
        <Route path="activity" element={<ActivityLog />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="/d/:shareToken" element={<PublicDashboard />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
    </>
  )
}

function NotFound() {
  return (
    <div
      className="admin-root"
      style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}
    >
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <div
          className="eyebrow"
          style={{ justifyContent: 'center', marginBottom: 12 }}
        >
          404
        </div>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: '-0.025em',
            margin: '0 0 8px',
          }}
        >
          Page not found.
        </h1>
        <p style={{ fontSize: 13, color: 'var(--fg-3)', margin: '0 0 16px' }}>
          The path you tried doesn't exist. If you followed a share link, ask the
          client to send a new one.
        </p>
        <a className="ghost-btn primary" href="/admin">
          Back to admin
        </a>
      </div>
    </div>
  )
}
