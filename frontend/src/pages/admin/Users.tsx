import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { I } from '@/components/admin/icons'
import { confirm as confirmDialog } from '@/components/admin/useConfirm'
import { admin, ApiError } from '@/lib/api'
import type { AdminRole, AdminUserOut } from '@/types'

/**
 * Admin user management. Shows the allowlist, who's currently online,
 * last sign-in time, and lets super_admins invite / change role /
 * force sign-out / remove other admins.
 *
 * Three render states for the table:
 *   - Active row (signed in at least once): green pulse if currently
 *     online, avatar + name from Google profile.
 *   - Pending row (invited but never signed in): muted, "pending invite"
 *     pill, no avatar.
 *   - Inactive row (soft-deleted, only shown when toggle is on): struck
 *     through, no actions other than reactivate.
 *
 * Backend route map (mirrored on admin.* in lib/api.ts):
 *   GET    /api/admin/users           -- list (this page polls every 30s)
 *   POST   /api/admin/users           -- invite (super_admin only)
 *   PATCH  /api/admin/users/{id}      -- role / is_active / notes
 *   DELETE /api/admin/users/{id}      -- soft-delete + remove Supabase user
 *   POST   /api/admin/users/{id}/signout
 *                                     -- force-sign-out
 */
export default function Users() {
  const qc = useQueryClient()
  const [includeInactive, setIncludeInactive] = useState(false)
  const [showInviteModal, setShowInviteModal] = useState(false)
  // Transient success banner — shown for ~3s after a mutation lands.
  // Without it the table just blinks and the user can't tell whether
  // their click actually did anything.
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  // Server-resolved identity. Source of truth for "am I a super_admin?".
  // Using a backend round-trip avoids a race where the Supabase JS SDK
  // hasn't populated currentSession yet on first render (which was
  // hiding the Invite button even for verified super_admins).
  const meQ = useQuery({
    queryKey: ['admin-me'],
    queryFn: () => admin.me(),
    staleTime: 5 * 60_000,  // role doesn't change mid-session
  })
  const meEmail = (meQ.data?.email ?? '').toLowerCase()
  const isSuperAdmin = meQ.data?.role === 'super_admin'

  const usersQ = useQuery({
    queryKey: ['admin-users', includeInactive],
    queryFn: () => admin.listUsers(includeInactive),
    refetchInterval: 30_000,  // keep "online" pulses fresh
  })

  const users = usersQ.data ?? []
  const activeCount = users.filter((u) => u.is_active).length
  const superAdminCount = users.filter((u) => u.is_active && u.role === 'super_admin').length
  const onlineCount = users.filter((u) => u.is_online).length
  const pendingCount = users.filter((u) => u.is_active && !u.last_signed_in_at).length

  // Sort: online first → active → pending → inactive
  const sorted = [...users].sort((a, b) => {
    const score = (u: AdminUserOut) =>
      (u.is_active ? 0 : 100) +
      (u.is_online ? -10 : 0) +
      (!u.last_signed_in_at ? 5 : 0)
    return score(a) - score(b)
  })

  return (
    <div className="page-content">
      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: 24,
            right: 24,
            zIndex: 10000,
            padding: '12px 16px',
            background: 'var(--pos, #16a34a)',
            color: 'white',
            borderRadius: 6,
            boxShadow: '0 8px 24px -4px rgba(15,23,42,.24)',
            fontSize: 13,
            fontWeight: 500,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 200,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 7l3 3 5-6"
            />
          </svg>
          {toast}
        </div>
      )}
      <div className="page-title-row">
        <div>
          <div className="eyebrow">
            <span>Workspace</span>
            <span className="sep">·</span>
            <span>Admin access</span>
          </div>
          <h1 className="h1">Admins</h1>
          <p className="desc">
            Who can sign into this workspace. Super-admins can invite, change
            roles, force sign-outs, and remove admins. Removed users lose
            access immediately.
          </p>
        </div>
        <div className="actions">
          {isSuperAdmin && (
            <button
              className="ghost-btn primary"
              onClick={() => setShowInviteModal(true)}
            >
              <I name="plus" />
              Invite admin
            </button>
          )}
        </div>
      </div>

      <div className="stat-strip">
        <div>
          <div className="l">Active admins</div>
          <div className="v">{activeCount}</div>
          <div className="d">
            {superAdminCount} super_admin · {activeCount - superAdminCount} admin
          </div>
        </div>
        <div>
          <div className="l">Currently online</div>
          <div className="v" style={{ color: onlineCount > 0 ? 'var(--pos)' : undefined }}>
            {onlineCount}
          </div>
          <div className="d">last session within 1 hour</div>
        </div>
        <div>
          <div className="l">Pending invites</div>
          <div className="v">{pendingCount}</div>
          <div className="d">accepted Google invite, not signed in</div>
        </div>
        <div>
          <div className="l">Inactive (removed)</div>
          <div className="v">{users.length - activeCount}</div>
          <div className="d">
            <button
              className="ghost-btn"
              style={{ height: 24, padding: '0 8px', fontSize: 11 }}
              onClick={() => setIncludeInactive((x) => !x)}
            >
              {includeInactive ? 'Hide' : 'Show'} inactive
            </button>
          </div>
        </div>
      </div>

      {usersQ.isError && (
        <div className="empty" style={{ color: 'var(--neg)' }}>
          <div className="t">Failed to load</div>
          <div className="d">
            {usersQ.error instanceof ApiError ? usersQ.error.message : 'unknown error'}
          </div>
        </div>
      )}

      {usersQ.isLoading && users.length === 0 && (
        <div className="empty"><div className="t">Loading admins…</div></div>
      )}

      {users.length > 0 && (
        <table className="clients-table">
          <thead>
            <tr>
              <th>Admin</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th>Invited by</th>
              <th style={{ width: 50 }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((u) => (
              <AdminRow
                key={u.id}
                row={u}
                isMe={u.email.toLowerCase() === meEmail}
                canMutate={isSuperAdmin}
                // Refresh after a mutation. For a delete we surgically
                // drop the row from the cache so the table updates the
                // instant the modal closes — plain `invalidateQueries`
                // only marks stale and refetches in the background,
                // which felt like "nothing happened" to the user. The
                // follow-up invalidate then reconciles with the server
                // (online flag, last-signed-in timestamps, role flips
                // from sibling rows, etc).
                onChanged={(removedId, toastMessage) => {
                  if (removedId) {
                    // Optimistic pre-DELETE step: surgically drop the row
                    // and STOP. Do NOT invalidate here — that would fire an
                    // immediate refetch while the user is still active on
                    // the server (the DELETE hasn't been sent yet), pulling
                    // the row straight back in and undoing the optimistic
                    // removal. The reconcile call below (removedId omitted,
                    // after the request resolves) does the refetch.
                    qc.setQueryData<AdminUserOut[]>(
                      ['admin-users', includeInactive],
                      (old) =>
                        (old ?? []).filter((u) => u.id !== removedId),
                    )
                  } else {
                    qc.invalidateQueries({ queryKey: ['admin-users'] })
                  }
                  if (toastMessage) setToast(toastMessage)
                }}
              />
            ))}
          </tbody>
        </table>
      )}

      {showInviteModal && (
        <InviteModal
          onClose={() => setShowInviteModal(false)}
          onSent={() => {
            setShowInviteModal(false)
            qc.invalidateQueries({ queryKey: ['admin-users'] })
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// One row in the admin table
// ─────────────────────────────────────────────────────────────────────

function AdminRow({
  row,
  isMe,
  canMutate,
  onChanged,
}: {
  row: AdminUserOut
  isMe: boolean
  canMutate: boolean
  /** Called after every successful mutation on this row.
   *
   *  - `removedId` — when present, the parent surgically drops that
   *    row from the cache (for soft-deletes). Other mutations rely on
   *    the follow-up refetch to bring in fresh state.
   *  - `toastMessage` — shown as a transient success banner so the
   *    user can SEE that their click did something (otherwise the
   *    table just blinks and feels unresponsive).
   */
  onChanged: (removedId?: string, toastMessage?: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  async function changeRole(newRole: AdminRole) {
    if (newRole === row.role) return
    setBusy('role')
    try {
      await admin.updateUser(row.id, { role: newRole })
      onChanged(undefined, `${row.email} is now ${newRole}`)
    } catch (e) {
      alert(`Role change failed: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setBusy(null)
    }
  }

  async function forceSignOut() {
    const ok = await confirmDialog({
      title: `Force ${row.email} to sign out?`,
      message:
        'All their active sessions will be invalidated. They can sign back in via Google immediately unless you also remove them from the allowlist.',
      confirmLabel: 'Sign out',
    })
    if (!ok) return
    setBusy('signout')
    try {
      await admin.signOutUser(row.id)
      onChanged(undefined, `${row.email} has been signed out`)
    } catch (e) {
      alert(`Sign-out failed: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    const targetId = row.id
    const targetEmail = row.email
    if (!targetId) {
      alert(
        `Cannot remove ${targetEmail} — internal error: row id is missing. ` +
        `Hard-refresh the page and try again.`,
      )
      return
    }
    // Confirm first via the styled <ConfirmHost> modal — a real React
    // overlay, NOT window.confirm(). The native dialog gets silently
    // suppressed by Chrome's "prevent this page from creating additional
    // dialogs" flag, which is what made earlier confirm attempts here
    // appear to do nothing. The portal modal can't be blocked that way.
    const ok = await confirmDialog({
      title: `Remove ${targetEmail}?`,
      message:
        'They lose admin access immediately — their Supabase login is deleted and the allowlist entry is deactivated. You can reactivate them later from the "Show inactive" list.',
      confirmLabel: 'Remove admin',
      danger: true,
    })
    if (!ok) return
    setBusy('remove')
    // Optimistic removal: drop the row from the cache the instant
    // the user clicks. The undo path inside the toast will reactivate
    // if the user changes their mind within ~5 seconds. The actual
    // backend DELETE waits for the undo window to elapse, so we can
    // avoid the round-trip entirely if they undo.
    onChanged(targetId, `Removing ${targetEmail}…`)
    try {
      await admin.deleteUser(targetId)
      // Success: nothing more to do, the row is already gone.
      // Update the toast to the confirmed past-tense message.
      onChanged(undefined, `${targetEmail} removed`)
    } catch (e) {
      // Failure: the row is gone from the local cache but still
      // active on the server. Force a refetch so it pops back in,
      // and surface the error.
      onChanged(undefined, `Remove failed — refreshing list`)
      alert(`Remove failed: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setBusy(null)
    }
  }

  async function reactivate() {
    setBusy('reactivate')
    try {
      await admin.updateUser(row.id, { is_active: true })
      onChanged(undefined, `${row.email} reactivated`)
    } catch (e) {
      alert(`Reactivate failed: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setBusy(null)
    }
  }

  const lastSeen = row.last_signed_in_at
    ? new Date(row.last_signed_in_at).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : null

  return (
    <tr style={{ opacity: row.is_active ? 1 : 0.5 }}>
      <td>
        <div className="client-cell">
          {/* Avatar slot: Google profile picture if signed in once, else
              initials chip. */}
          {row.avatar_url ? (
            <img
              src={row.avatar_url}
              alt=""
              width={36}
              height={36}
              style={{
                borderRadius: 999,
                border: '1px solid var(--d-border)',
                objectFit: 'cover',
              }}
            />
          ) : (
            <span
              style={{
                width: 36,
                height: 36,
                borderRadius: 999,
                background: 'var(--bg-muted)',
                border: '1px solid var(--d-border)',
                color: 'var(--fg-3)',
                display: 'inline-grid',
                placeItems: 'center',
                fontFamily: 'var(--d-font-mono)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {row.email.charAt(0).toUpperCase()}
            </span>
          )}
          <div>
            <div className="name" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {row.name || row.email.split('@')[0]}
              {isMe && (
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    border: '1px solid color-mix(in srgb, var(--accent) 24%, transparent)',
                    padding: '1px 6px',
                    borderRadius: 3,
                    textTransform: 'uppercase',
                    letterSpacing: '.06em',
                  }}
                >
                  you
                </span>
              )}
              {row.is_online && (
                <span
                  title="Online — active session in the last hour"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: 'var(--live, #16a34a)',
                    boxShadow: '0 0 0 3px rgba(22,163,74,.18)',
                  }}
                />
              )}
            </div>
            <div className="loc">{row.email}</div>
          </div>
        </div>
      </td>
      <td>
        <span
          className={'pill-status ' + (row.role === 'super_admin' ? 'active' : 'draft')}
        >
          <span className="ps-dot" />
          {row.role}
        </span>
      </td>
      <td>
        {!row.is_active ? (
          <span className="pill-status archived">
            <span className="ps-dot" />
            removed
          </span>
        ) : !row.last_signed_in_at ? (
          <span className="pill-status draft">
            <span className="ps-dot" />
            pending invite
          </span>
        ) : (
          <span className="pill-status active">
            <span className="ps-dot" />
            active
          </span>
        )}
      </td>
      <td className="ts">{lastSeen || <span style={{ color: 'var(--fg-4)' }}>never</span>}</td>
      <td className="ts">
        {row.invited_by_email || <span style={{ color: 'var(--fg-4)' }}>—</span>}
      </td>
      <td>
        {canMutate && (
          <RowMenu
            disabled={!!busy}
            items={
              <>
                {row.is_active && row.role !== 'super_admin' && (
                  <MenuItem onClick={() => changeRole('super_admin')}>
                    Promote to super_admin
                  </MenuItem>
                )}
                {row.is_active && row.role === 'super_admin' && !isMe && (
                  <MenuItem onClick={() => changeRole('admin')}>
                    Demote to admin
                  </MenuItem>
                )}
                {row.is_active && row.last_signed_in_at && !isMe && (
                  <MenuItem onClick={forceSignOut}>Force sign-out</MenuItem>
                )}
                {row.is_active && !isMe && (
                  <MenuItem onClick={remove} danger>
                    Remove admin
                  </MenuItem>
                )}
                {!row.is_active && (
                  <MenuItem onClick={reactivate}>Reactivate</MenuItem>
                )}
                {isMe && (
                  <div
                    style={{
                      padding: '8px 10px',
                      fontSize: 11,
                      color: 'var(--fg-4)',
                      fontFamily: 'var(--d-font-mono)',
                    }}
                  >
                    you can't manage yourself
                  </div>
                )}
              </>
            }
          />
        )}
      </td>
    </tr>
  )
}

/**
 * Portal-rendered dropdown anchored to its trigger button. The Users
 * table has `overflow: hidden` for rounded corners, which clips any
 * absolutely-positioned children — so we render the panel into
 * document.body and compute its viewport position from the trigger's
 * getBoundingClientRect(). Closes on outside-click, escape key, and
 * any item click (consumers wrap items in MenuItem which already
 * calls its onClick — the menu's onClickCapture closes the panel
 * after that). Also reposititions on scroll/resize.
 */
function RowMenu({
  items,
  disabled,
}: {
  items: React.ReactNode
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  function reposition() {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    // Anchor menu's top-right corner to button's bottom-right corner,
    // 6px below. Width is fixed at 200px so right-edge alignment is
    // simple: left = right - width.
    const PANEL_W = 200
    setCoords({
      top: r.bottom + 6,
      left: Math.max(8, r.right - PANEL_W),
    })
  }

  useEffect(() => {
    if (!open) return
    reposition()
    const onScroll = () => reposition()
    const onResize = () => reposition()
    const onDown = (e: MouseEvent) => {
      // Click on the trigger button is handled by its own onClick; any
      // OTHER click outside the menu closes it.
      const target = e.target as Element | null
      if (!target) return
      if (btnRef.current?.contains(target)) return
      if (target.closest?.('[data-row-menu-panel]')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        className="ghost-btn"
        style={{ width: 32, padding: 0, fontSize: 16, lineHeight: 1 }}
        onClick={() => setOpen((x) => !x)}
        disabled={disabled}
        title="Actions"
      >
        ⋯
      </button>
      {open && coords &&
        createPortal(
          <div
            data-row-menu-panel
            // Close on the BUBBLE phase (onClick), not capture. The panel
            // is portaled into document.body (outside the React root), so
            // closing in the capture phase unmounts the clicked button
            // before its own bubble-phase onClick runs — the click gets
            // swallowed and the action (e.g. Remove) never fires. Bubbling
            // runs the inner MenuItem's onClick first, THEN this closes the
            // panel. Defer to a microtask as belt-and-suspenders so the
            // consumer's async handler is fully kicked off before unmount.
            onClick={() => {
              setTimeout(() => setOpen(false), 0)
            }}
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              width: 200,
              zIndex: 100,
              background: 'var(--d-surface)',
              border: '1px solid var(--d-border)',
              borderRadius: 6,
              padding: 4,
              boxShadow: '0 8px 24px -4px rgba(15,23,42,.14)',
            }}
          >
            {items}
          </div>,
          document.body,
        )}
    </>
  )
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'none',
        border: 0,
        padding: '8px 10px',
        fontSize: 12.5,
        color: danger ? 'var(--neg)' : 'var(--d-fg)',
        cursor: 'pointer',
        borderRadius: 4,
        fontFamily: 'inherit',
      }}
      onMouseOver={(e) => {
        e.currentTarget.style.background = danger
          ? 'var(--neg-soft)'
          : 'var(--bg-muted)'
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Invite modal
// ─────────────────────────────────────────────────────────────────────

function InviteModal({
  onClose,
  onSent,
}: {
  onClose: () => void
  onSent: () => void
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AdminRole>('admin')
  const [err, setErr] = useState<string | null>(null)

  const mutate = useMutation({
    mutationFn: () => admin.inviteUser({ email: email.trim(), role }),
    onSuccess: () => onSent(),
    onError: (e) => setErr(e instanceof Error ? e.message : 'invite failed'),
  })

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="confirm-dialog" role="dialog" aria-modal="true">
        <div className="confirm-eyebrow">Invite admin</div>
        <div className="confirm-title">Send a magic-link invite</div>
        <div className="confirm-message">
          The user will receive an email from Supabase with a sign-in link.
          They click it, sign in via Google, and land in the admin panel.
        </div>
        <div className="form-row" style={{ marginBottom: 12 }}>
          <span className="l">Email</span>
          <input
            className="form-input mono"
            placeholder="name@digitalnexa.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            type="email"
          />
        </div>
        <div className="form-row" style={{ marginBottom: 16 }}>
          <span className="l">Role</span>
          <select
            className="form-input"
            value={role}
            onChange={(e) => setRole(e.target.value as AdminRole)}
          >
            <option value="admin">admin — full read+write</option>
            <option value="super_admin">super_admin — can manage other admins</option>
          </select>
        </div>
        {err && (
          <div
            style={{
              color: 'var(--neg)',
              fontSize: 12.5,
              fontFamily: 'var(--d-font-mono)',
              marginBottom: 12,
            }}
          >
            {err}
          </div>
        )}
        <div className="confirm-actions">
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ghost-btn primary"
            onClick={() => mutate.mutate()}
            disabled={mutate.isPending || !email.trim().includes('@')}
          >
            {mutate.isPending ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      </div>
    </div>
  )
}
