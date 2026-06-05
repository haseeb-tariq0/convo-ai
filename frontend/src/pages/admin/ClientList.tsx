import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import BrandLogo, { brandKeyFor, type BrandKey } from '@/components/admin/BrandLogo'
import { I } from '@/components/admin/icons'
import { admin } from '@/lib/api'
import type { ClientOut } from '@/types'

type Filter = 'all' | 'active' | 'archived'

export default function ClientList() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['clients'],
    queryFn: admin.listClients,
  })

  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')

  const createMutation = useMutation({
    mutationFn: (body: { name: string; contact_email: string }) =>
      admin.createClient({ name: body.name, contact_email: body.contact_email || null }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['clients'] })
      setCreating(false)
      navigate(`/admin/clients/${created.id}`)
    },
  })

  const filtered = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return data.filter((c) => {
      if (filter === 'active' && !c.is_active) return false
      if (filter === 'archived' && c.is_active) return false
      if (q && !c.name.toLowerCase().includes(q) && !(c.contact_email ?? '').toLowerCase().includes(q)) return false
      return true
    })
  }, [data, filter, search])

  const counts = useMemo(() => {
    const all = data?.length ?? 0
    const active = data?.filter((c) => c.is_active).length ?? 0
    const archived = all - active
    return { all, active, archived }
  }, [data])

  return (
    <div className="page-content">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">
            <span>Nexa Digital</span>
            <span className="sep">·</span>
            <span>Workspace</span>
          </div>
          <h1 className="h1">Clients</h1>
          <p className="desc">
            Every client gets a shareable dashboard at{' '}
            <span className="mono">/d/&lt;token&gt;</span>. Add a new client, then attach a Google Sheet to start syncing.
          </p>
        </div>
        <div className="actions">
          <button className="ghost-btn primary" onClick={() => setCreating(true)}>
            <I name="plus" />
            New client
          </button>
        </div>
      </div>

      {/* Workspace stats */}
      <div className="stat-strip">
        <div>
          <div className="l">Active clients</div>
          <div className="v num">{counts.active}</div>
          <div className="d">of {counts.all} total</div>
        </div>
        <div>
          <div className="l">Archived</div>
          <div className="v num">{counts.archived}</div>
          <div className="d">no public dashboards</div>
        </div>
        <div>
          <div className="l">Search</div>
          <div className="v" style={{ fontSize: 16, fontWeight: 500, color: 'var(--fg-3)', paddingTop: 6 }}>
            ⌘K
          </div>
          <div className="d">search clients by name or email</div>
        </div>
        <div>
          <div className="l">Pending</div>
          <div className="v num">0</div>
          <div className="d">awaiting Sheet wire-up</div>
        </div>
      </div>

      {/* Filters + search */}
      <div className="search-row">
        <div className="search-input">
          <I name="search" size={13} />
          <input placeholder="Search clients…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="key">⌘K</span>
        </div>
        <div className="filter-pills">
          {(['all', 'active', 'archived'] as Filter[]).map((f) => (
            <button
              key={f}
              className={'filter-pill' + (filter === f ? ' active' : '')}
              onClick={() => setFilter(f)}
            >
              <span style={{ textTransform: 'capitalize' }}>{f}</span>
              <span className="n">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      {creating && (
        <NewClientForm
          onCancel={() => setCreating(false)}
          onSubmit={(b) => createMutation.mutate(b)}
          busy={createMutation.isPending}
        />
      )}

      {isLoading && <div className="info-card" style={{ padding: 32, color: 'var(--fg-3)' }}>Loading clients…</div>}
      {isError && (
        <div className="info-card" style={{ padding: 18, color: 'var(--neg)' }}>
          {error instanceof Error ? error.message : 'Failed to load clients'}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="empty">
          <div className="t">No clients match</div>
          <div className="d">{search ? 'Try a different search.' : 'Add a client to get started.'}</div>
          {!search && (
            <button className="ghost-btn primary" onClick={() => setCreating(true)}>
              <I name="plus" />
              New client
            </button>
          )}
        </div>
      )}

      {filtered.length > 0 && (
        <table className="clients-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Created</th>
              <th>Status</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <ClientRow key={c.id} client={c} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function ClientRow({ client }: { client: ClientOut }) {
  const navigate = useNavigate()
  const brand = brandKeyFor(client.name) as BrandKey
  return (
    <tr
      onClick={() => navigate(`/admin/clients/${client.id}`)}
      style={{
        // per-row accent so the integration chips + future inline marks
        // pick up the brand color stably
        ['--accent' as string]: `var(--accent-${brand}, var(--accent))`,
      } as React.CSSProperties}
    >
      <td>
        <div className="client-cell">
          <BrandLogo brand={brand} size="md" />
          <div>
            <div className="name">{client.name}</div>
            <div className="loc">{client.contact_email ?? '—'}</div>
          </div>
        </div>
      </td>
      <td className="ts">
        {new Date(client.created_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })}
      </td>
      <td>
        <span className={'pill-status ' + (client.is_active ? 'active' : 'archived')}>
          <span className="ps-dot" />
          {client.is_active ? 'active' : 'archived'}
        </span>
      </td>
      <td className="actions-cell" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Configure">
          <I name="settings" />
        </button>
      </td>
    </tr>
  )
}

function NewClientForm({
  onCancel,
  onSubmit,
  busy,
}: {
  onCancel: () => void
  onSubmit: (b: { name: string; contact_email: string }) => void
  busy: boolean
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ name: name.trim(), contact_email: email.trim() })
      }}
      className="info-card"
      style={{ marginBottom: 18 }}
    >
      <div className="info-card-head">
        <span className="t">New client</span>
        <button type="button" className="icon-btn" onClick={onCancel} style={{ marginLeft: 'auto' }}>
          <I name="x" />
        </button>
      </div>
      <div className="editor-body">
        <div className="form-row">
          <span className="l">Name</span>
          <input className="form-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nest Hotel" />
        </div>
        <div className="form-row">
          <span className="l">Contact email</span>
          <input className="form-input mono" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ops@example.com" />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="ghost-btn primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create client'}
          </button>
          <button type="button" className="ghost-btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </form>
  )
}
