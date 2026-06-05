import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import AdminIconSprite, { ConvoMark } from '@/components/admin/icons'
import { admin, ApiError, setAdminToken } from '@/lib/api'
import { signInWithGoogle, supabase } from '@/lib/supabase'

/**
 * Admin login. Two paths offered:
 *   1. "Sign in with Google" — Supabase Auth + Google OAuth. Primary
 *      path for browser users. Email must be in the backend's
 *      ADMIN_EMAILS allowlist.
 *   2. Paste a bearer token — kept for CLI parity / dev fallback. Hidden
 *      behind a disclosure so the OAuth button is the obvious choice.
 *
 * If we're already signed in (either via Supabase session or stored
 * legacy token), we auto-redirect to /admin.
 */
export default function Login() {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showTokenFallback, setShowTokenFallback] = useState(false)
  const navigate = useNavigate()
  const [search] = useSearchParams()
  // Banner cause — set when api.ts bounced the user here because of a
  // 401 mid-session, so they don't think the redirect was random.
  const reason = search.get('reason')

  // If a Supabase session is in localStorage OR we just landed back
  // with the #access_token fragment, auto-bounce into /admin — BUT
  // only after the backend confirms the session is actually accepted
  // (via /api/admin/me). A stale / expired JWT can still be present
  // in localStorage; redirecting on its mere presence would cause an
  // infinite loop with api.ts's 401 → /login bouncer.
  useEffect(() => {
    let cancelled = false

    async function verifyAndRedirect() {
      const { data } = await supabase.auth.getSession()
      if (cancelled || !data.session?.access_token) return
      // Round-trip /me with the JWT. If the backend accepts it we're
      // good to navigate. If it 401s the SDK's auto-recovery in
      // api.ts will clear the stale session and surface the
      // session_expired banner — no auto-redirect from here.
      try {
        await admin.me()
        if (!cancelled) navigate('/admin', { replace: true })
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // Clear the stale session in-place; user can re-sign in.
          await supabase.auth.signOut().catch(() => {})
        }
      }
    }
    verifyAndRedirect()

    const sub = supabase.auth.onAuthStateChange((event) => {
      // On a fresh SIGNED_IN event (just completed OAuth), re-verify
      // and bounce. TOKEN_REFRESHED is also a good signal — fresh JWT.
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        verifyAndRedirect()
      }
    })
    return () => {
      cancelled = true
      sub.data.subscription.unsubscribe()
    }
  }, [navigate])

  async function submitToken(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setAdminToken(token.trim())
    try {
      await admin.listClients()
      navigate('/admin', { replace: true })
    } catch (err) {
      setAdminToken(null)
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  async function startGoogle() {
    setBusy(true)
    setError(null)
    try {
      await signInWithGoogle()
      // signInWithOAuth triggers a full-page redirect — code after this
      // line only runs if the redirect failed for some reason.
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Could not start Google sign-in')
    }
  }

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-6">
      <AdminIconSprite />
      <div
        className="ux-card w-[420px] p-10"
        style={{ background: 'linear-gradient(180deg,#FAFBFC,#fff)' }}
      >
        <div className="flex items-center gap-2 mb-7">
          <ConvoMark size={22} />
          <span className="font-semibold text-[15px]">Convo AI</span>
        </div>
        <h1 className="text-[26px] font-semibold tracking-tight mb-1.5">
          Sign in to admin
        </h1>
        <p className="text-muted text-[13.5px] mb-7">
          Use your Nexa Google account. Only emails on the admin allowlist
          can access the workspace.
        </p>

        {/* Bounced-back banner — api.ts redirects here when an admin
            request comes back 401 mid-session. Better than the user
            seeing "missing bearer token" on a half-rendered page. */}
        {reason === 'session_expired' && (
          <div
            style={{
              padding: '10px 12px',
              marginBottom: 18,
              borderRadius: 6,
              background: 'var(--warn-soft, #FEF3C7)',
              border: '1px solid color-mix(in srgb, var(--warn, #B45309) 30%, transparent)',
              color: 'var(--warn, #B45309)',
              fontSize: 12.5,
              fontFamily: 'var(--d-font-mono, monospace)',
            }}
          >
            Your session expired. Sign back in to continue.
          </div>
        )}

        {/* Primary path: Google OAuth via Supabase Auth */}
        <button
          type="button"
          className="ux-btn-primary w-full"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            height: 42,
          }}
          onClick={startGoogle}
          disabled={busy}
        >
          {/* Inline Google "G" mark. Multi-color SVG so the button reads
              as a real Google sign-in affordance, not a generic OAuth
              button. Same paths as the official Google branding kit. */}
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <path
              fill="#FFFFFF"
              d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
            />
            <path
              fill="#FFFFFF"
              d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.836.86-3.048.86-2.344 0-4.328-1.584-5.036-3.71H.957v2.332A8.997 8.997 0 009 18z"
              opacity="0.85"
            />
            <path
              fill="#FFFFFF"
              d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
              opacity="0.7"
            />
            <path
              fill="#FFFFFF"
              d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
              opacity="0.55"
            />
          </svg>
          {busy ? 'Redirecting…' : 'Sign in with Google'}
        </button>

        {error && (
          <div
            className="mt-3 text-[12.5px] flex items-center gap-1.5"
            style={{ color: '#B91C1C' }}
          >
            <svg className="ux-ic" style={{ width: 13, height: 13 }}>
              <use href="#i-alert" />
            </svg>
            {error}
          </div>
        )}

        {/* Disclosure: token fallback. Surface kept tiny so it doesn't
            steal focus from the OAuth path. */}
        <div className="mt-6 pt-5 border-t border-gray-100">
          {!showTokenFallback ? (
            <button
              type="button"
              className="text-[11.5px] text-muted hover:text-fg"
              style={{
                background: 'none',
                border: 0,
                padding: 0,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 2,
              }}
              onClick={() => setShowTokenFallback(true)}
            >
              Sign in with admin token instead
            </button>
          ) : (
            <form onSubmit={submitToken}>
              <label
                className="ux-label-form"
                style={{ fontSize: 11, marginBottom: 6 }}
              >
                Admin token (legacy / CLI)
              </label>
              <div className="relative">
                <input
                  type="password"
                  className="ux-input pl-9 mono"
                  style={{ height: 38 }}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="paste the admin bearer token"
                />
                <svg className="ux-ic absolute left-3 top-1/2 -translate-y-1/2 text-muted">
                  <use href="#i-key" />
                </svg>
              </div>
              <button
                type="submit"
                className="ux-btn-secondary w-full mt-3"
                disabled={busy || !token}
                style={{ height: 36 }}
              >
                {busy ? 'Verifying…' : 'Sign in with token'}
              </button>
              <button
                type="button"
                className="text-[11.5px] text-muted mt-3"
                style={{
                  background: 'none',
                  border: 0,
                  padding: 0,
                  cursor: 'pointer',
                  display: 'block',
                  margin: '12px auto 0',
                }}
                onClick={() => setShowTokenFallback(false)}
              >
                ← Back to Google sign-in
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
