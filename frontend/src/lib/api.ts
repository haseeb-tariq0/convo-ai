// Thin fetch wrapper. Admin endpoints attach a Bearer token chosen in
// this priority:
//   1. Supabase user JWT (from the OAuth-signed-in admin) — preferred.
//   2. Legacy shared admin token from localStorage — for CLI parity /
//      backward compatibility with the old token-pasted login flow.
// Public endpoints (`/api/public/*`) skip auth entirely.

import { ensureSessionLoaded, getAccessToken, refreshAdminSession } from '@/lib/supabase'
import type {
  AdminAuditLogEntry,
  AdminMe,
  AdminUserIn,
  AdminUserOut,
  AdminUserUpdate,
  AIIntegrationIn,
  AIIntegrationOut,
  AITestResult,
  ClientOut,
  DashboardOut,
  FieldConfig,
  GA4ConfigOut,
  PublicDashboardConfig,
  PublicDashboardData,
  SyncLogOut,
  SystemInfo,
} from '@/types'

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const ADMIN_TOKEN_KEY = 'convo-ai-admin-token'

export function getAdminToken(): string | null {
  return localStorage.getItem(ADMIN_TOKEN_KEY)
}

export function setAdminToken(token: string | null) {
  if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token)
  else localStorage.removeItem(ADMIN_TOKEN_KEY)
}

/** Resolve the Bearer token for an admin request. OAuth JWT wins over
 *  the legacy stored token so a signed-in admin doesn't accidentally
 *  fall back to a leaked / shared secret. */
function resolveAdminBearer(): string | null {
  const jwt = getAccessToken()
  if (jwt) return jwt
  return getAdminToken()
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

type Init = RequestInit & { admin?: boolean }

async function request<T>(path: string, init: Init = {}, _retried = false): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json')
  }
  if (init.admin) {
    // Make sure the Supabase SDK has finished its initial session
    // load before we resolve the bearer. Without this, the very first
    // admin request after page boot can fire with `null` as the
    // bearer (sync `getAccessToken()` returns nothing because the
    // module-level cache hasn't been hydrated yet) → backend 401 →
    // session bouncer → flicker / redirect-loop. After the first
    // call, `ensureSessionLoaded` is essentially a no-op (cached).
    await ensureSessionLoaded()
    const t = resolveAdminBearer()
    if (t) headers.set('Authorization', `Bearer ${t}`)
  }
  const res = await fetch(BASE + path, { ...init, headers })
  // Auth recovery: if an admin call comes back 401 (missing/invalid
  // bearer), we're in a stuck-state — typically the user has stale or
  // half-cleared session data. Clear both auth paths and bounce them
  // to /login so they can re-authenticate, instead of showing them an
  // unhelpful "Failed to load — missing bearer token" forever.
  // Skip the redirect for the public app though (no `admin:true`) and
  // for the /admin/me endpoint itself (which the login flow uses to
  // probe whether the user is signed in).
  if (
    init.admin &&
    res.status === 401 &&
    !path.endsWith('/api/admin/me') &&
    typeof window !== 'undefined' &&
    !window.location.pathname.startsWith('/login')
  ) {
    // The Supabase access token most likely just expired (~1h lifetime, and
    // the background auto-refresh can lag when the tab is throttled). Refresh
    // it and retry the request ONCE before giving up — a long admin session
    // shouldn't be bounced to login every time the token rolls over.
    if (!_retried) {
      const fresh = await refreshAdminSession()
      if (fresh) return request<T>(path, init, true)
    }
    // Refresh failed (refresh token expired/revoked) or the retry still 401'd
    // → genuinely signed out. Clear both auth paths and bounce to /login.
    setAdminToken(null)
    // CRITICAL: clear the Supabase session SYNCHRONOUSLY before we
    // redirect. `supabase.auth.signOut()` is async — it wouldn't
    // complete before `window.location.href` fires, leaving the
    // stale session in localStorage. Login.tsx would then read it
    // back via getSession(), navigate to /admin, the API call would
    // 401 again, → infinite redirect loop ("blinking screen" — the
    // exact symptom we hit). Sync removal breaks the loop.
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
          localStorage.removeItem(k)
        }
      }
    } catch {
      // localStorage can throw in private-browsing contexts; the
      // redirect itself is the user-visible behaviour we need.
    }
    window.location.href = '/login?reason=session_expired'
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const detail = (data && data.detail) || res.statusText
    throw new ApiError(res.status, detail)
  }
  return data as T
}

// ---- admin -----------------------------------------------------------------

export const admin = {
  health: () => request<{ status: string; db: string; scheduler: string }>(`/api/health`),
  // clients
  listClients: () => request<ClientOut[]>(`/api/admin/clients`, { admin: true }),
  getClient: (id: string) => request<ClientOut>(`/api/admin/clients/${id}`, { admin: true }),
  createClient: (body: { name: string; contact_email?: string | null }) =>
    request<ClientOut>(`/api/admin/clients`, { admin: true, method: 'POST', body: JSON.stringify(body) }),
  updateClient: (id: string, body: Partial<ClientOut>) =>
    request<ClientOut>(`/api/admin/clients/${id}`, { admin: true, method: 'PATCH', body: JSON.stringify(body) }),
  deleteClient: (id: string) =>
    request<void>(`/api/admin/clients/${id}`, { admin: true, method: 'DELETE' }),

  // dashboards
  /** The default dashboard template (detailed widget set + standard column
   *  map). Used by Layout → Reset to restore the default dashboard. */
  defaultTemplate: () =>
    request<{ field_config: FieldConfig[]; sheet_column_map: Record<string, string>; sheet_tab_name: string }>(
      `/api/admin/default-template`,
      { admin: true },
    ),
  listDashboards: (clientId: string) =>
    request<DashboardOut[]>(`/api/admin/clients/${clientId}/dashboards`, { admin: true }),
  createDashboard: (clientId: string, body: Partial<DashboardOut>) =>
    request<DashboardOut>(`/api/admin/clients/${clientId}/dashboards`, {
      admin: true,
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getDashboard: (id: string) =>
    request<DashboardOut>(`/api/admin/dashboards/${id}`, { admin: true }),
  updateDashboard: (id: string, body: Partial<DashboardOut>) =>
    request<DashboardOut>(`/api/admin/dashboards/${id}`, {
      admin: true,
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteDashboard: (id: string) =>
    request<void>(`/api/admin/dashboards/${id}`, { admin: true, method: 'DELETE' }),
  manualSync: (id: string) =>
    request<{ rows_added: number }>(`/api/admin/dashboards/${id}/sync`, { admin: true, method: 'POST' }),
  /** AI Widget Builder: plain-English request → a ready-to-add field_config
   *  widget. The caller appends it to the dashboard's field_config and saves. */
  aiWidget: (id: string, prompt: string) =>
    request<FieldConfig>(`/api/admin/dashboards/${id}/ai-widget`, {
      admin: true,
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  /** Admin AI assistant for a dashboard: answers data questions + can add a
   *  widget. Returns the reply and an optional field_config to append. */
  assistant: (id: string, messages: { role: string; content: string }[]) =>
    request<{ reply: string; widget: FieldConfig | null }>(
      `/api/admin/dashboards/${id}/assistant`,
      { admin: true, method: 'POST', body: JSON.stringify({ messages }) },
    ),
  rotateToken: (id: string) =>
    request<DashboardOut>(`/api/admin/dashboards/${id}/rotate-token`, { admin: true, method: 'POST' }),
  recentLogs: (id: string, limit = 50) =>
    request<SyncLogOut[]>(`/api/admin/dashboards/${id}/logs?limit=${limit}`, { admin: true }),

  // ga4
  getGA4: (clientId: string) =>
    request<GA4ConfigOut>(`/api/admin/clients/${clientId}/ga4`, { admin: true }),
  upsertGA4: (clientId: string, body: Record<string, unknown>) =>
    request<GA4ConfigOut>(`/api/admin/clients/${clientId}/ga4`, {
      admin: true,
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteGA4: (clientId: string) =>
    request<void>(`/api/admin/clients/${clientId}/ga4`, { admin: true, method: 'DELETE' }),
  syncGA4: (clientId: string) =>
    request<{ status: string }>(`/api/admin/clients/${clientId}/ga4/sync`, {
      admin: true,
      method: 'POST',
    }),

  // ai integrations
  getAI: (clientId: string) =>
    request<AIIntegrationOut>(`/api/admin/clients/${clientId}/ai`, { admin: true }),
  upsertAI: (clientId: string, body: AIIntegrationIn) =>
    request<AIIntegrationOut>(`/api/admin/clients/${clientId}/ai`, {
      admin: true,
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteAI: (clientId: string) =>
    request<void>(`/api/admin/clients/${clientId}/ai`, { admin: true, method: 'DELETE' }),
  testAI: (clientId: string) =>
    request<AITestResult>(`/api/admin/clients/${clientId}/ai/test`, {
      admin: true,
      method: 'POST',
    }),

  // workspace system info
  system: () => request<SystemInfo>(`/api/admin/system`, { admin: true }),

  // admin user management (the allowlist + role + audit log)
  /** Server's view of the current signed-in admin: kind, email, role.
   *  Source-of-truth for "am I a super_admin?" — more reliable than
   *  reading the Supabase session synchronously on the client. */
  me: () => request<AdminMe>(`/api/admin/me`, { admin: true }),
  listUsers: (includeInactive = false) =>
    request<AdminUserOut[]>(
      `/api/admin/users${includeInactive ? '?include_inactive=true' : ''}`,
      { admin: true },
    ),
  inviteUser: (body: AdminUserIn) =>
    request<AdminUserOut>(`/api/admin/users`, {
      admin: true,
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateUser: (id: string, body: AdminUserUpdate) =>
    request<AdminUserOut>(`/api/admin/users/${id}`, {
      admin: true,
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteUser: (id: string) =>
    request<void>(`/api/admin/users/${id}`, { admin: true, method: 'DELETE' }),
  signOutUser: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}/signout`, {
      admin: true,
      method: 'POST',
    }),
  auditLog: (opts: {
    limit?: number
    actor?: string
    actionPrefix?: string
    since?: string
  } = {}) => {
    const q = new URLSearchParams()
    if (opts.limit) q.set('limit', String(opts.limit))
    if (opts.actor) q.set('actor', opts.actor)
    if (opts.actionPrefix) q.set('action_prefix', opts.actionPrefix)
    if (opts.since) q.set('since', opts.since)
    const qs = q.toString()
    return request<AdminAuditLogEntry[]>(
      `/api/admin/audit-log${qs ? `?${qs}` : ''}`,
      { admin: true },
    )
  },
}

// ---- public ----------------------------------------------------------------

export const publicApi = {
  config: (token: string) =>
    request<PublicDashboardConfig>(`/api/public/dashboard/${token}`),
  data: (
    token: string,
    opts: { rangeDays?: number; from?: string; to?: string } = {},
  ) => {
    const q = new URLSearchParams()
    // from/to take precedence over rangeDays — backend respects same order,
    // but only send the params we mean to avoid query-string clutter.
    if (opts.from && opts.to) {
      q.set('from_date', opts.from)
      q.set('to_date', opts.to)
    } else if (opts.rangeDays) {
      q.set('range_days', String(opts.rangeDays))
    }
    const qs = q.toString()
    return request<PublicDashboardData>(
      `/api/public/dashboard/${token}/data${qs ? `?${qs}` : ''}`,
    )
  },
}
