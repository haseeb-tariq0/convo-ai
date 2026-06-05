import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'

import { getAdminToken } from '@/lib/api'
import { supabase } from '@/lib/supabase'

/**
 * Route guard for `/admin/*`. Allows through if EITHER:
 *   - A Supabase user JWT is present (OAuth signed-in), or
 *   - A legacy admin token is in localStorage (CLI / dev fallback)
 *
 * Auth resolution is ASYNC on first mount: we await
 * `supabase.auth.getSession()` which forces the SDK to parse the
 * `#access_token=...` URL fragment that the OAuth callback drops onto
 * /admin. A sync read would race with the SDK and falsely redirect to
 * /login mid-OAuth — losing the brand-new session and stranding the
 * user.
 *
 * Real authorization happens on the backend via `require_admin`. This
 * is just a client-side gate to decide what to render.
 */
export default function RequireAdmin({ children }: { children: React.ReactNode }) {
  // Three states:
  //   null   — still resolving (show nothing — brief flash is fine)
  //   true   — signed in
  //   false  — redirect to /login
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    // Await the SDK's session resolver. This is the call that triggers
    // URL-fragment parsing (detectSessionInUrl: true in supabase.ts).
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      const hasJwt = !!data.session?.access_token
      const hasToken = !!getAdminToken()
      setAuthed(hasJwt || hasToken)
    })
    // Also subscribe so a later sign-in / sign-out flips the gate
    // without a manual refresh.
    const sub = supabase.auth.onAuthStateChange((_event, session) => {
      const hasJwt = !!session?.access_token
      const hasToken = !!getAdminToken()
      setAuthed(hasJwt || hasToken)
    })
    return () => {
      cancelled = true
      sub.data.subscription.unsubscribe()
    }
  }, [])

  if (authed === null) {
    // Avoid flashing /login during the initial async resolve. Renders
    // a near-invisible placeholder so the layout doesn't jump.
    return <div style={{ minHeight: '100vh' }} />
  }
  if (!authed) return <Navigate to="/login" replace />
  return <>{children}</>
}
