import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import BrandLogo, { brandKeyFor } from '@/components/admin/BrandLogo'
import { I } from '@/components/admin/icons'
import { admin, ApiError } from '@/lib/api'
import type { ClientOut, GA4ConfigOut } from '@/types'

/**
 * Cross-client GA4 health view. For each client, fetches their GA4
 * config (or marks "not configured" when the GET returns 404). Lets
 * the operator see at a glance which clients have GA4 wired and when
 * each was last synced.
 */
export default function GA4Integrations() {
  const clientsQ = useQuery({
    queryKey: ['admin-clients'],
    queryFn: () => admin.listClients(),
  })
  const clients = clientsQ.data ?? []

  const ga4Queries = useQueries({
    queries: clients.map((c) => ({
      queryKey: ['client-ga4', c.id],
      queryFn: () => admin.getGA4(c.id),
      enabled: !!c.id,
      retry: false,  // 404 = "not configured", treat as a fast non-error result
    })),
  })

  type Row = {
    client: ClientOut
    ga4: GA4ConfigOut | null
    isConfigured: boolean
  }
  const rows: Row[] = clients.map((c, i) => {
    const q = ga4Queries[i]
    const ga4 = q?.data ?? null
    const notFound = q?.error instanceof ApiError && q.error.status === 404
    return { client: c, ga4, isConfigured: !!ga4 && !notFound }
  })

  const configuredCount = rows.filter((r) => r.isConfigured).length
  const loading = clientsQ.isLoading || ga4Queries.some((q) => q.isLoading)

  // "Stale" = configured but last_synced_at older than 25 hours (the
  // scheduler ticks GA4 every hour, so 25h means something is wrong).
  const STALE_THRESHOLD_MS = 25 * 60 * 60 * 1000
  const now = Date.now()
  const staleCount = rows.filter((r) => {
    if (!r.isConfigured || !r.ga4?.last_synced_at) return false
    return now - new Date(r.ga4.last_synced_at).getTime() > STALE_THRESHOLD_MS
  }).length

  return (
    <div className="page-content">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">
            <span>Workspace</span>
            <span className="sep">·</span>
            <span>GA4 integrations</span>
          </div>
          <h1 className="h1">GA4 integrations</h1>
          <p className="desc">
            Connection state for each client's Google Analytics 4 property.
            Configure per-client from the client detail page.
          </p>
        </div>
      </div>

      <div className="stat-strip">
        <div>
          <div className="l">Connected</div>
          <div className="v">{configuredCount} <span style={{ fontSize: 14, color: 'var(--fg-4)', fontWeight: 500 }}>/ {clients.length}</span></div>
          <div className="d">clients with GA4 wired</div>
        </div>
        <div>
          <div className="l">Not configured</div>
          <div className="v">{clients.length - configuredCount}</div>
          <div className="d">awaiting setup</div>
        </div>
        <div>
          <div className="l">Stale syncs</div>
          <div className="v" style={{ color: staleCount > 0 ? 'var(--warn)' : undefined }}>
            {staleCount}
          </div>
          <div className="d">no sync in last 25 hours</div>
        </div>
        <div>
          <div className="l">Sync cadence</div>
          <div className="v" style={{ fontFamily: 'var(--d-font-mono)', fontSize: 18 }}>1h</div>
          <div className="d">every active integration</div>
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className="empty"><div className="t">Loading workspace…</div></div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="t">No clients yet</div>
          <Link className="ghost-btn primary" to="/admin">Open clients</Link>
        </div>
      ) : (
        <table className="clients-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Property ID</th>
              <th>Conversion event</th>
              <th>Lookback</th>
              <th>Status</th>
              <th>Last sync</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ client, ga4, isConfigured }) => {
              const brand = brandKeyFor(client.name)
              const last = ga4?.last_synced_at
              const stale = last && now - new Date(last).getTime() > STALE_THRESHOLD_MS
              return (
                <tr key={client.id}>
                  <td>
                    <Link
                      to={`/admin/clients/${client.id}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                    >
                      <div className="client-cell">
                        <BrandLogo brand={brand} size="md" />
                        <div>
                          <div className="name">{client.name}</div>
                          <div className="loc">
                            {client.contact_email || '—'}
                          </div>
                        </div>
                      </div>
                    </Link>
                  </td>
                  <td>
                    {ga4 ? (
                      <span
                        style={{
                          fontFamily: 'var(--d-font-mono)',
                          fontSize: 12,
                          color: 'var(--d-fg)',
                        }}
                      >
                        {ga4.property_id}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--fg-4)' }}>—</span>
                    )}
                  </td>
                  <td>
                    {ga4 ? (
                      <span style={{ fontFamily: 'var(--d-font-mono)', fontSize: 12 }}>
                        {ga4.conversion_event_name}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--fg-4)' }}>—</span>
                    )}
                  </td>
                  <td className="num-col">
                    {ga4 ? `${ga4.lookback_days}d` : '—'}
                  </td>
                  <td>
                    {isConfigured ? (
                      <span className={'pill-status ' + (stale ? 'draft' : 'active')}>
                        <span className="ps-dot" />
                        {stale ? 'stale' : 'connected'}
                      </span>
                    ) : (
                      <span className="pill-status archived">
                        <span className="ps-dot" />
                        not configured
                      </span>
                    )}
                  </td>
                  <td className="ts">
                    {last
                      ? new Date(last).toLocaleString('en-US', {
                          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                        })
                      : <span style={{ color: 'var(--fg-4)' }}>never</span>}
                  </td>
                  <td className="actions-cell">
                    <Link
                      className="ghost-btn"
                      to={`/admin/clients/${client.id}`}
                      title="Open client detail"
                    >
                      <I name="ext" />
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
