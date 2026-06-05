import { useQueries, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { admin } from '@/lib/api'
import type { AdminAuditLogEntry, ClientOut, DashboardOut, SyncLogOut } from '@/types'

/**
 * Cross-client activity log — fans out to every dashboard's `/logs`
 * endpoint, merges + sorts by occurred_at desc. The source pill is
 * color-coded to match the existing per-dashboard activity table
 * (sheets=green, ga4=orange, ai/openai=indigo). Filter chips let the
 * operator narrow to a single source or status.
 */
export default function ActivityLog() {
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const clientsQ = useQuery({
    queryKey: ['admin-clients'],
    queryFn: () => admin.listClients(),
  })
  const clients = clientsQ.data ?? []

  // First fan-out: every client's dashboards (so we know which IDs to
  // pull logs for).
  const dashboardQueries = useQueries({
    queries: clients.map((c) => ({
      queryKey: ['client-dashboards', c.id],
      queryFn: () => admin.listDashboards(c.id),
      enabled: !!c.id,
    })),
  })

  type DashRef = { client: ClientOut; dash: DashboardOut }
  const allDashboards: DashRef[] = []
  clients.forEach((c, i) => {
    (dashboardQueries[i]?.data ?? []).forEach((d) =>
      allDashboards.push({ client: c, dash: d }),
    )
  })

  // Second fan-out: each dashboard's recent logs.
  const logQueries = useQueries({
    queries: allDashboards.map((ref) => ({
      queryKey: ['dashboard-logs', ref.dash.id],
      queryFn: () => admin.recentLogs(ref.dash.id, 30),
      enabled: !!ref.dash.id,
    })),
  })

  // Third query: admin audit log (one row per mutating admin action —
  // client.create, dashboard.delete, ga4.upsert, admin.invite, etc.)
  const auditQ = useQuery({
    queryKey: ['admin-audit-log'],
    queryFn: () => admin.auditLog({ limit: 200 }),
  })

  // Merge sync_logs and audit_log into a single row type. Audit entries
  // get synthesized client/dash fields so the existing table renders
  // them in the same columns. `_kind` distinguishes the two so we can
  // render audit-specific cells (action name, details JSON) inline.
  type Row =
    | (SyncLogOut & { _kind: 'sync'; client: ClientOut; dash: DashboardOut })
    | (AdminAuditLogEntry & {
        _kind: 'audit'
        source: 'admin'
        status: 'success' | 'error'
        client: null
        dash: null
        // Synthesized so existing column accessors keep working:
        rows_processed: null
        duration_ms: null
        message: string
      })
  const rows: Row[] = []
  allDashboards.forEach((ref, i) => {
    const logs = logQueries[i]?.data ?? []
    logs.forEach((l) =>
      rows.push({ ...l, _kind: 'sync', client: ref.client, dash: ref.dash }),
    )
  })
  ;(auditQ.data ?? []).forEach((a) => {
    rows.push({
      ...a,
      _kind: 'audit',
      source: 'admin',
      // Audit entries are never "errors" themselves — that's a sync
      // concept. Mark as success so the existing status pill shows green.
      status: 'success',
      client: null,
      dash: null,
      rows_processed: null,
      duration_ms: null,
      // Synthesize a readable summary: "admin@email · client.create →
      // target_type/target_id"
      message: `${a.actor_email} · ${a.action}${
        a.target_id ? ` → ${a.target_type ?? 'target'}/${a.target_id.slice(0, 8)}` : ''
      }`,
    })
  })
  rows.sort(
    (a, b) =>
      new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
  )

  // Bucket counts BEFORE applying filters so the chips show totals.
  const bySource = {
    sheets: rows.filter((r) => r.source === 'sheets').length,
    ai: rows.filter((r) => r.source === 'ai').length,
    ga4: rows.filter((r) => r.source === 'ga4').length,
    admin: rows.filter((r) => r.source === 'admin').length,
  }
  const errorCount = rows.filter((r) => r.status === 'error').length

  const filteredRows = rows.filter((r) => {
    if (sourceFilter !== 'all' && r.source !== sourceFilter) return false
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    return true
  })

  const loading =
    clientsQ.isLoading ||
    dashboardQueries.some((q) => q.isLoading) ||
    logQueries.some((q) => q.isLoading)

  return (
    <div className="page-content">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">
            <span>Workspace</span>
            <span className="sep">·</span>
            <span>Activity</span>
          </div>
          <h1 className="h1">Activity log</h1>
          <p className="desc">
            Every sync event across every dashboard plus every mutating
            admin action. Sheets sync ticks every 30s, AI labels every
            60s, GA4 every hour. Admin actions land as they happen.
          </p>
        </div>
      </div>

      <div className="stat-strip">
        <div>
          <div className="l">Total events</div>
          <div className="v">{rows.length}</div>
          <div className="d">across {allDashboards.length} dashboards</div>
        </div>
        <div>
          <div className="l">Sheets syncs</div>
          <div className="v">{bySource.sheets}</div>
          <div className="d">30s cadence</div>
        </div>
        <div>
          <div className="l">AI labels</div>
          <div className="v">{bySource.ai}</div>
          <div className="d">60s cadence · up to 50/tick</div>
        </div>
        <div>
          <div className="l">Errors</div>
          <div className="v" style={{ color: errorCount > 0 ? 'var(--neg)' : undefined }}>
            {errorCount}
          </div>
          <div className="d">
            {errorCount > 0 ? 'tap to filter' : 'last 30 events / dashboard'}
          </div>
        </div>
      </div>

      <div className="search-row">
        <div className="filter-pills">
          {([
            ['all', 'All', rows.length],
            ['sheets', 'Sheets', bySource.sheets],
            ['ai', 'AI', bySource.ai],
            ['ga4', 'GA4', bySource.ga4],
            ['admin', 'Admin', bySource.admin],
          ] as const).map(([k, label, n]) => (
            <button
              key={k}
              className={'filter-pill' + (sourceFilter === k ? ' active' : '')}
              onClick={() => setSourceFilter(k)}
            >
              {label} <span className="n">{n}</span>
            </button>
          ))}
        </div>
        <div className="filter-pills" style={{ marginLeft: 'auto' }}>
          {(['all', 'success', 'error'] as const).map((k) => (
            <button
              key={k}
              className={'filter-pill' + (statusFilter === k ? ' active' : '')}
              onClick={() => setStatusFilter(k)}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      {loading && rows.length === 0 ? (
        <div className="empty"><div className="t">Loading activity…</div></div>
      ) : filteredRows.length === 0 ? (
        <div className="empty">
          <div className="t">No matching events</div>
          <div className="d">Try widening the filter, or wait for the next scheduler tick.</div>
        </div>
      ) : (
        <div
          style={{
            background: 'var(--d-surface)',
            border: '1px solid var(--d-border)',
            borderRadius: 'var(--d-radius-lg)',
            overflow: 'hidden',
          }}
        >
          <table className="activity-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Client / dashboard</th>
                <th>Source</th>
                <th>Status</th>
                <th>Rows</th>
                <th>Duration</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.slice(0, 200).map((r) => {
                const sourceCls =
                  r.source === 'sheets' ? 'sheets' :
                  r.source === 'ga4'    ? 'ga4'    :
                  r.source === 'ai'     ? 'openai' :
                  // NB: must NOT be 'admin' — that collides with the global
                  // app-shell `.admin` rule (min-height:100vh; display:flex),
                  // which would stretch this pill to a full screen tall.
                  r.source === 'admin'  ? 'audit'  : ''
                const isAudit = r._kind === 'audit'
                return (
                  <tr key={r.id}>
                    <td className="ts">
                      {new Date(r.occurred_at).toLocaleString('en-US', {
                        month: 'short', day: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit',
                      })}
                    </td>
                    <td>
                      {/* Audit rows have no client/dashboard — show the
                          actor email + action name instead. Sync rows
                          link to their dashboard config page. */}
                      {isAudit ? (
                        <div>
                          <div style={{ fontWeight: 500, color: 'var(--d-fg)' }}>
                            {r.actor_email}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 1, fontFamily: 'var(--d-font-mono)' }}>
                            {r.actor_role || 'token'}
                          </div>
                        </div>
                      ) : (
                        <Link
                          to={`/admin/dashboards/${r.dash!.id}`}
                          style={{
                            textDecoration: 'none',
                            color: 'inherit',
                            display: 'inline-block',
                          }}
                        >
                          <div style={{ fontWeight: 500, color: 'var(--d-fg)' }}>
                            {r.dash!.name}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 1 }}>
                            {r.client!.name}
                          </div>
                        </Link>
                      )}
                    </td>
                    <td>
                      <span className={'src ' + sourceCls}>{r.source}</span>
                    </td>
                    <td>
                      <span className={'status-cell ' + (r.status === 'success' ? 'success' : 'error')}>
                        <span className="pip" />
                        {r.status}
                      </span>
                    </td>
                    <td className="num-col">
                      {r.rows_processed != null ? r.rows_processed : '—'}
                    </td>
                    <td className="num-col">
                      {r.duration_ms != null
                        ? r.duration_ms >= 1000
                          ? `${(r.duration_ms / 1000).toFixed(1)}s`
                          : `${r.duration_ms}ms`
                        : '—'}
                    </td>
                    <td
                      style={{
                        fontSize: 12,
                        color: r.status === 'error' ? 'var(--neg)' : 'var(--fg-3)',
                        maxWidth: 460,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={r.message}
                    >
                      {r.message || <span style={{ color: 'var(--fg-4)' }}>—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
