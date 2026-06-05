import { useEffect, useState } from 'react'

/**
 * Promise-style confirmation dialog — drop-in replacement for the
 * native `window.confirm()` with a styled modal that matches the
 * design register.
 *
 * Usage:
 *
 *   import { confirm } from '@/components/admin/useConfirm'
 *
 *   async function onDelete() {
 *     const ok = await confirm({
 *       title: `Delete "${name}"?`,
 *       message: 'This cannot be undone.',
 *       danger: true,
 *     })
 *     if (ok) actuallyDelete()
 *   }
 *
 * `<ConfirmHost />` must be mounted once at the app root (App.tsx
 * does that). The `confirm()` function is callable from anywhere
 * after that — it talks to the host via module-scoped state.
 */

export type ConfirmOptions = {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

// Module-scoped channel between the imperative `confirm()` and the
// React-side <ConfirmHost />. There's only ever one dialog at a time
// (matches native confirm() semantics + keeps the UX predictable).
type State = (ConfirmOptions & { _resolve: (v: boolean) => void }) | null
let setState: ((s: State) => void) | null = null
let pending: ConfirmOptions | null = null  // queued options if host not mounted yet

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setState) {
      // Host hasn't mounted yet — extremely unlikely (App.tsx mounts it
      // immediately), but fall back to native confirm so we never hang.
      const ok = window.confirm(
        opts.title + (opts.message ? '\n\n' + opts.message : ''),
      )
      resolve(ok)
      return
    }
    pending = opts
    setState({ ...opts, _resolve: resolve })
  })
}

export function ConfirmHost() {
  const [state, _setState] = useState<State>(null)

  // Wire the module-scoped channel exactly once on mount.
  useEffect(() => {
    setState = _setState
    if (pending) {
      // Flush a pre-mount call (rare race condition).
      _setState({ ...pending, _resolve: () => {} })
      pending = null
    }
    return () => {
      setState = null
    }
  }, [])

  // Escape closes the dialog with "cancel".
  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        state._resolve(false)
        _setState(null)
      } else if (e.key === 'Enter') {
        state._resolve(true)
        _setState(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [state])

  if (!state) return null

  const finish = (ok: boolean) => {
    state._resolve(ok)
    _setState(null)
  }

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => {
        // Click on the overlay backdrop (not the dialog itself) cancels.
        if (e.target === e.currentTarget) finish(false)
      }}
    >
      <div className="confirm-dialog" role="dialog" aria-modal="true">
        <div className="confirm-eyebrow">
          {state.danger ? 'Destructive action' : 'Confirm'}
        </div>
        <div className="confirm-title">{state.title}</div>
        {state.message && (
          <div className="confirm-message">{state.message}</div>
        )}
        <div className="confirm-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => finish(false)}
          >
            {state.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={state.danger ? 'btn-danger' : 'ghost-btn primary'}
            onClick={() => finish(true)}
            // Focus the confirm button by default so the keyboard flow
            // matches OS confirms ([Enter] = primary, [Esc] = cancel).
            autoFocus
          >
            {state.confirmLabel ?? (state.danger ? 'Delete' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
