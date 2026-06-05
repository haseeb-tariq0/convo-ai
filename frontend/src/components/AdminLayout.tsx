import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useMatch } from 'react-router-dom'

import { setAdminToken } from '@/lib/api'
import { signOut } from '@/lib/supabase'

import { getUser } from '@/lib/supabase'

import AdminIconSprite, { I } from './admin/icons'
import { confirm as confirmDialog } from './admin/useConfirm'

/**
 * Admin shell — premium-fintech register ported from the Claude Design
 * bundle (admin-shell.jsx). Dark sidebar with brand mark + workspace
 * badge + nav links + status block + user pill; sticky breadcrumb bar
 * with theme toggle; main content area on `--canvas`.
 *
 * Mounted at `/admin/*`. Child pages render through the <Outlet />.
 * Each child can swap the breadcrumb trail by setting a route-level
 * context — for now we just render the route names.
 */
export default function AdminLayout() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = localStorage.getItem('convo-ai-theme')
    return stored === 'dark' ? 'dark' : 'light'
  })

  // Apply theme to <html> so the design's [data-theme] selectors kick in.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.setAttribute('data-density', 'cozy')
    localStorage.setItem('convo-ai-theme', theme)
    return () => {
      // Don't unset on unmount — the public dashboard inherits the same
      // theme, so we want it to persist across nav.
    }
  }, [theme])

  return (
    <div className="admin-root admin">
      <AdminIconSprite />
      <Sidebar />
      <main className="main">
        <CrumbBar theme={theme} setTheme={setTheme} />
        <Outlet />
      </main>
    </div>
  )
}

function Sidebar() {
  return (
    <aside className="rail">
      <div className="rail-brand">
        {/* Nexa "N" mark — the parent brand. White-on-transparent PNG
            (~470 bytes, /public/brand/nexa-mark.png). The sidebar's
            near-black background acts as the visual chip; no extra
            wrapper or border. */}
        <img
          src="/brand/nexa-mark.png"
          alt="Nexa"
          className="mk-img"
          width={28}
          height={28}
        />
        <span className="nm">Convo AI</span>
        <span className="role">admin</span>
      </div>

      <div className="rail-section">Workspace</div>
      <nav className="rail-nav">
        <RailLink to="/admin" end iconId="clients" label="Clients" />
        <RailLink to="/admin/dashboards" iconId="grid" label="Dashboards" />
        <RailLink to="/admin/ga4" iconId="ga4" label="GA4 integrations" />
        <RailLink to="/admin/users" iconId="clients" label="Admins" />
        <RailLink to="/admin/activity" iconId="activity" label="Activity log" />
        <RailLink to="/admin/settings" iconId="settings" label="Settings" />
      </nav>

      <div className="rail-status">
        <div className="ws">Nexa Digital</div>
        <div className="meta">
          <span className="ok">All systems green</span>
        </div>
        <div className="meta" style={{ marginTop: 8, color: 'var(--rail-fg-mute)' }}>
          live · syncing every 30s
        </div>
      </div>

      <SidebarUserPill />
    </aside>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Sidebar user pill — shows the live signed-in user (name + email +
// Google avatar from Supabase user_metadata). Falls back to a neutral
// "Admin" label when the legacy ADMIN_TOKEN path is in use (no
// identity attached). Clicking the avatar signs out both paths.
// ─────────────────────────────────────────────────────────────────────
function SidebarUserPill() {
  const user = getUser()
  // First letter of name OR email for the avatar fallback.
  const initial = (user?.name || user?.email || 'A').charAt(0).toUpperCase()
  const displayName = user?.name || user?.email?.split('@')[0] || 'Admin'
  const subtitle = user?.email || 'token session'

  async function onSignOut() {
    const ok = await confirmDialog({
      title: 'Sign out?',
      message:
        'You will need to sign in with Google (or paste the admin token) to come back in.',
      confirmLabel: 'Sign out',
    })
    if (ok) {
      // Clear BOTH paths — Supabase session for OAuth users, legacy
      // localStorage token for token-paste users.
      await signOut()
      setAdminToken(null)
      window.location.href = '/login'
    }
  }

  return (
    <div className="rail-user">
      <button
        type="button"
        className="av"
        title="Sign out"
        onClick={onSignOut}
        style={{
          // Reset user-agent button defaults that fight the .av chip style.
          background: 'none',
          padding: 0,
          border: 'none',
          overflow: 'hidden',
          cursor: 'pointer',
        }}
      >
        {user?.avatar_url ? (
          <img
            src={user.avatar_url}
            alt=""
            width={26}
            height={26}
            // pointer-events: none — defensive against the case where the
            // browser treats the img as the click target and skips bubbling
            // to the button. Click on the img always becomes a click on
            // the button.
            style={{
              borderRadius: 999,
              display: 'block',
              objectFit: 'cover',
              pointerEvents: 'none',
            }}
          />
        ) : (
          initial
        )}
      </button>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          className="nm"
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={displayName}
        >
          {displayName}
        </div>
        <div
          className="sub"
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={subtitle}
        >
          {subtitle}
        </div>
      </div>
    </div>
  )
}

function RailLink({ to, end, iconId, label }: { to: string; end?: boolean; iconId: string; label: string }) {
  // Match nested routes — e.g. /admin/clients/:id should keep "Clients" active.
  const dashboardMatch = useMatch('/admin/dashboards/:id')
  const clientMatch = useMatch('/admin/clients/:id')
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => {
        // Force "Clients" active when on a client-detail or dashboard-config sub-page.
        const onSubpage = (to === '/admin' && (clientMatch || dashboardMatch)) ? true : false
        return `adm-rail-link${isActive || onSubpage ? ' active' : ''}`
      }}
    >
      <I name={iconId} size={14} />
      <span>{label}</span>
    </NavLink>
  )
}

function CrumbBar({ theme, setTheme }: { theme: 'light' | 'dark'; setTheme: (t: 'light' | 'dark') => void }) {
  return (
    <div className="crumb-bar">
      <div className="crumb">
        <Link to="/admin">Convo AI</Link>
        <span className="sep">/</span>
        <span className="cur">Workspace</span>
      </div>
      <div className="spacer" />
      <div className="right">
        <button className="icon-btn" title="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          <I name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>
    </div>
  )
}
