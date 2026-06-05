import { I } from '@/components/admin/icons'

/**
 * Generic "coming soon" page for sidebar items that haven't been wired
 * to real backend endpoints yet (Dashboards index, GA4 integrations
 * cross-client view, Activity log cross-client, workspace Settings).
 *
 * Renders inside the admin shell so the sidebar / crumb-bar / theme
 * toggle all stay live. The empty state matches the design system
 * (.empty class — hairline-dashed border, mono eyebrow).
 */
export default function Placeholder({
  title,
  subtitle,
  icon = 'grid',
  cta,
}: {
  title: string
  subtitle: string
  icon?: string
  cta?: { label: string; href: string }
}) {
  return (
    <div className="page-content">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">
            <span>Workspace</span>
            <span className="sep">·</span>
            <span>Coming soon</span>
          </div>
          <h1 className="h1">{title}</h1>
          <p className="desc">{subtitle}</p>
        </div>
      </div>

      <div className="empty">
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            display: 'inline-grid',
            placeItems: 'center',
            margin: '0 auto 14px',
          }}
        >
          <I name={icon} size={22} />
        </div>
        <div className="t">{title}</div>
        <div className="d">{subtitle}</div>
        {cta && (
          <a className="ghost-btn primary" href={cta.href}>
            {cta.label}
          </a>
        )}
      </div>
    </div>
  )
}
