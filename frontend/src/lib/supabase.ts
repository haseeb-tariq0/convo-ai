import { createClient, type Session } from '@supabase/supabase-js'

/**
 * Browser-side Supabase client. Used ONLY for the admin OAuth flow —
 * the public dashboard never touches Supabase directly (data flows
 * through the backend `publicApi`).
 *
 * The anon key here is publishable + RLS-scoped, so shipping it to the
 * browser is the documented Supabase pattern. The service-role key
 * stays server-only.
 *
 * Auth persists in `localStorage` (Supabase's default), so refreshing
 * keeps the admin signed in until they explicitly sign out or the
 * token expires (~1 hour, auto-refreshed by the SDK).
 */
const URL = import.meta.env.VITE_SUPABASE_URL || ''
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || ''

export const supabase = createClient(URL, ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,  // handles the #access_token=… on redirect-back
  },
})

// Module-level session cache.
//
// Why: supabase-js v2 doesn't expose `currentSession` reliably on the
// client instance (it lives behind the async `auth.getSession()` API).
// `lib/api.ts` needs the JWT SYNCHRONOUSLY when building the
// Authorization header for every admin request — reading the async
// API per-request would either require making the whole request layer
// async-only (cascading API change) OR returning stale/null values.
//
// So we keep a module-level mirror, primed once on module load and
// then updated by the auth-state listener. After ~1 round-trip on app
// boot, `_session` is in sync with the SDK's internal state and every
// sync read is correct.
let _session: Session | null = null
let _sessionLoaded = false
let _sessionLoadPromise: Promise<Session | null> | null = null

/** Force-load the session asynchronously. Used by `lib/api.ts` on the
 *  first admin request to make sure the bearer is available even if
 *  the module just booted. Subsequent calls hit the cache. */
export function ensureSessionLoaded(): Promise<Session | null> {
  if (_sessionLoaded) return Promise.resolve(_session)
  if (_sessionLoadPromise) return _sessionLoadPromise
  _sessionLoadPromise = supabase.auth
    .getSession()
    .then(({ data }) => {
      _session = data.session
      _sessionLoaded = true
      return _session
    })
    .catch(() => {
      _sessionLoaded = true  // don't retry forever on a broken SDK
      return null
    })
  return _sessionLoadPromise
}

// Prime the cache as soon as this module loads + keep it updated.
ensureSessionLoaded()
supabase.auth.onAuthStateChange((_event, session) => {
  _session = session
  _sessionLoaded = true
})

/** Returns the current Supabase session synchronously from the cache.
 *  `null` if not signed in OR if the SDK hasn't finished its initial
 *  load yet. Callers that need to wait for the SDK to be ready should
 *  await `ensureSessionLoaded()` first. */
export function getSession(): Session | null {
  return _session
}

/** Returns the current Supabase JWT (access token) if the user is
 *  signed in, otherwise null. Backend admin endpoints accept this as
 *  the Bearer token. */
export function getAccessToken(): string | null {
  return getSession()?.access_token ?? null
}

/** Force a token refresh via the Supabase SDK and update the module cache.
 *  Returns the fresh access token, or null if the refresh failed (e.g. the
 *  refresh token itself is expired/revoked → genuinely signed out). Used by
 *  the API layer to recover from a 401 (an expired ~1h access token) without
 *  bouncing the user to the login screen mid-session. */
export async function refreshAdminSession(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.refreshSession()
    if (error || !data.session) return null
    _session = data.session
    _sessionLoaded = true
    return data.session.access_token ?? null
  } catch {
    return null
  }
}

/** Convenience: who's signed in? Returns null if not. */
export function getUserEmail(): string | null {
  return getSession()?.user?.email ?? null
}

/** Return the full signed-in user object: id, email, name + avatar
 *  from Google OAuth metadata. Used by the sidebar pill + Users page
 *  to show "you are signed in as X". Null when not signed in. */
export function getUser(): {
  id: string
  email: string | null
  name: string | null
  avatar_url: string | null
} | null {
  const u = getSession()?.user
  if (!u) return null
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>
  return {
    id: u.id,
    email: u.email ?? null,
    name: (meta.full_name as string) || (meta.name as string) || null,
    avatar_url: (meta.avatar_url as string) || null,
  }
}

/** Sign in via Google. On success Supabase redirects back to the same
 *  origin with `#access_token=…` in the URL; the SDK detects it on
 *  page load and persists the session. */
export async function signInWithGoogle(redirectTo?: string) {
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: redirectTo ?? `${window.location.origin}/admin`,
    },
  })
}

export async function signOut() {
  await supabase.auth.signOut()
}
