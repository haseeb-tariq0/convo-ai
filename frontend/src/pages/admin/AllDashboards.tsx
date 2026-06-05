import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import BrandLogo, { brandKeyFor } from '@/components/admin/BrandLogo'
import { I } from '@/components/admin/icons'
import { admin } from '@/lib/api'
import type { ClientOut, DashboardOut } from '@/types'

/**
 * Cross-client "All dashboards" workspace view. Fan-outs to every
 * client's dashboards endpoint and presents a flat sortable table with
 * the bits an operator needs at a glance: brand mark, client name,
 * dashboard name, share-link state, field count, last update.
 *
 * Implemented as a flat fan-out (one query per client) rather than a
 * dedicated cross-client endpoint because the admin workspace is
 * always small (under ~50 clients in any realistic scenario) and the
 * fan-out reuses cached per-client queries already populated by
 * ClientDetail. If this scales past that, add
 * `GET /api/admin/dashboards` server-side and swap the impl.
 */
export default function AllDashboards() {
  const clientsQ = useQuery({
    queryKey: ['admin-clients'],
    queryFn: () => admin.listClients(),
  })
  const clients = clientsQ.data ?? []

  const dashboardQueries = useQueries({
    queries: clients.map((c) => ({
      queryKey: ['client-dashboards', c.id],
      queryFn: () => admin.listDashboards(c.id),
      enabled: !!c.id,
    })),
  })

  // Flatten + index dashboards by client for the table.
  const rows: { client: ClientOut; dash: DashboardOut }[] = []
  clients.forEach((c, i) => {
    const dd = dashboardQueries[i]?.data ?? []
    dd.forEach((d) => rows.push({ client: c, dash: d }))
  })
  rows.sort(
    (a, b) =>
      new Date(b.dash.updated_at).getTime() -
      new Date(a.dash.updated_at).getTime(),
  )

  const loading = clientsQ.isLoading || dashboardQueries.some((q) => q.isLoading)
  const activeCount = rows.filter((r) => r.dash.is_active).length
  const totalFields = rows.reduce((s, r) => s + r.dash.field_config.length, 0)

  return (
    <div className="page-content">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">
            <span>Workspace</span>
            <span className="sep">·</span>
            <span>Cross-client view</span>
          </div>
          <h1 className="h1">All dashboards</h1>
          <p className="desc">
            Every dashboard across every client in this workspace.
            Click a row to open its configuration.
          </p>
        </div>
      </div>

      <div className="stat-strip">
        <div>
          <div className="l">Total dashboards</div>
          <div className="v">{rows.length}</div>
          <div className="d">across {clients.length} {clients.length === 1 ? 'client' : 'clients'}</div>
        </div>
        <div>
          <div className="l">Active</div>
          <div className="v">{activeCount}</div>
          <div className="d">{rows.length - activeCount} archived</div>
        </div>
        <div>
          <div className="l">Configured widgets</div>
          <div className="v">{totalFields}</div>
          <div className="d">summed across all dashboards</div>
        </div>
        <div>
          <div className="l">Last update</div>
          <div className="v" style={{ fontSize: 18, fontFamily: 'var(--d-font-mono)' }}>
            {rows[0]
              ? new Date(rows[0].dash.updated_at).toLocaleString('en-US', {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })
              : '—'}
          </div>
          <div className="d">most recently edited</div>
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className="empty">
          <div className="t">Loading workspace…</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="t">No dashboards yet</div>
          <div className="d">
            Create a client first, then add their first dashboard.
          </div>
          <Link className="ghost-btn primary" to="/admin">Open clients</Link>
        </div>
      ) : (
        <table className="clients-table">
          <thead>
            <tr>
              <th>Client / dashboard</th>
              <th>Share link</th>
              <th>Widgets</th>
              <th>Status</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ client, dash }) => {
              const brand = brandKeyFor(dash.brand_name || client.name)
              return (
                <tr key={dash.id}>
                  <td>
                    <Link
                      to={`/admin/dashboards/${dash.id}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                    >
                      <div className="client-cell">
                        <BrandLogo brand={brand} size="md" />
                        <div>
                          <div className="name">{dash.name}</div>
                          <div className="loc">{client.name}</div>
                        </div>
                      </div>
                    </Link>
                  </td>
                  <td>
                    <code
                      style={{
                        fontFamily: 'var(--d-font-mono)',
                        fontSize: 11.5,
                        color: 'var(--fg-3)',
                        background: 'var(--bg-muted)',
                        padding: '3px 7px',
                        borderRadius: 4,
                        border: '1px solid var(--d-border)',
                      }}
                    >
                      /d/{dash.share_token.slice(0, 10)}…
                    </code>
                  </td>
                  <td className="num-col">{dash.field_config.length}</td>
                  <td>
                    <span
                      className={
                        'pill-status ' + (dash.is_active ? 'active' : 'archived')
                      }
                    >
                      <span className="ps-dot" />
                      {dash.is_active ? 'active' : 'archived'}
                    </span>
                  </td>
                  <td className="ts">
                    {new Date(dash.updated_at).toLocaleString('en-US', {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td className="actions-cell">
                    <a
                      className="ghost-btn"
                      href={`/d/${dash.share_token}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Open public view in a new tab"
                    >
                      <I name="ext" />
                    </a>
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
