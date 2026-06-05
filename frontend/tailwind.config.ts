import type { Config } from 'tailwindcss'

// Two design registers live side-by-side in this codebase:
//
// 1. Editorial cream-and-ink (legacy) — used by admin pages + login. These
//    keep working because the original tokens (paper / ink / hairline /
//    muted / accent / positive / neutral / negative) are still defined.
// 2. Modern SaaS public dashboard (current) — surface / canvas / ink2 /
//    line / line2 / ok / warn / danger, plus a per-client brand variable
//    system (--b-primary, --b-accent, etc.) set on a wrapper element.
//
// Per-client branding resolves at runtime from CSS variables set on the
// public Dashboard wrapper. Tailwind only references the variable names.
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── editorial (legacy, still used by admin + login) ──────────────
        paper: '#FBF8F1',
        ink: '#1A1A1A',
        muted: '#6B6B6B',
        hairline: '#E4DFD2',
        accent: '#B5341A',
        positive: '#4F7A5A',
        neutral: '#9A8B6E',
        negative: '#B5341A',
        // ── modern SaaS palette (public dashboard) ───────────────────────
        surface: '#FFFFFF',
        canvas: '#F7F8FA',
        ink2: '#1E293B',
        subtle: '#94A3B8',
        line: '#E5E7EB',
        line2: '#F1F5F9',
        ok: '#16A34A',
        okSoft: '#DCFCE7',
        warn: '#D97706',
        warnSoft: '#FEF3C7',
        danger: '#DC2626',
        dangerSoft: '#FEE2E2',
        // ── per-dashboard brand (resolves at runtime from CSS variables;
        // wrapper sets --b-primary etc. from PublicDashboardConfig) ──────
        brand: 'var(--b-primary)',
        'brand-accent': 'var(--b-accent)',
        'brand-soft': 'var(--b-primary-50)',
        'brand-fg': 'var(--b-fg-on)',
      },
      fontFamily: {
        display: ['"Fraunces"', 'Georgia', 'serif'],
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        // Editorial mono kept for admin pages that pin to it.
        'mono-plex': ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Editorial number ramp (legacy admin pages still reference these).
        'mono-xs': ['11px', { letterSpacing: '-0.01em' }],
        'mono-sm': ['13px', { letterSpacing: '-0.01em' }],
        'mono-base': ['15px', { letterSpacing: '-0.01em' }],
        'mono-xl': ['28px', { letterSpacing: '-0.02em', lineHeight: '1.1' }],
        'mono-2xl': ['44px', { letterSpacing: '-0.03em', lineHeight: '1.05' }],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.05)',
        pop: '0 12px 28px -8px rgba(15,23,42,0.12), 0 4px 10px -4px rgba(15,23,42,0.06)',
        ring: '0 0 0 1px rgba(15,23,42,0.06)',
        lift: '0 6px 18px -6px rgba(15,23,42,0.14)',
      },
      borderRadius: {
        card: '12px',
      },
      // The public dashboard packs the KPI row into a 24-col grid (so
      // Total Chats + Revenue can sit at 3/24 = ~147px and Engagement can
      // stretch to 13/24 = ~690px). Tailwind ships col-span-1..12 by
      // default; the extras here cover the full 24-col range so any
      // future layout tweak doesn't need an inline style escape hatch.
      gridColumn: {
        'span-13': 'span 13 / span 13',
        'span-14': 'span 14 / span 14',
        'span-15': 'span 15 / span 15',
        'span-16': 'span 16 / span 16',
        'span-17': 'span 17 / span 17',
        'span-18': 'span 18 / span 18',
        'span-19': 'span 19 / span 19',
        'span-20': 'span 20 / span 20',
        'span-21': 'span 21 / span 21',
        'span-22': 'span 22 / span 22',
        'span-23': 'span 23 / span 23',
        'span-24': 'span 24 / span 24',
      },
    },
  },
  plugins: [],
}

export default config
