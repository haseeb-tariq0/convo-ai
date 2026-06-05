/**
 * Per-client SVG brand mark. Ported from the Claude Design bundle's
 * components.jsx — each client maps to a distinct geometric mark (the
 * "nest" stack, faceted gem, hex medallion, abstract flame).
 *
 * In production, when a client has uploaded a real logo via the Branding
 * tab, the dashboard's <img src={brand_logo_url}> takes precedence. This
 * SVG is the fallback so every client always has a visual identity, even
 * before they've uploaded artwork.
 */
export type BrandKey = 'nest' | 'emerald' | 'bronze' | 'crimson' | 'default'

const ALLOWED: ReadonlySet<BrandKey> = new Set<BrandKey>([
  'nest',
  'emerald',
  'bronze',
  'crimson',
  'default',
])

/** Pick a brand key for a client name. Tries keyword matches first (so
 *  "Nest Hotel" maps to nest, "Emerald Spa" to emerald, etc.), then falls
 *  back to a deterministic hash so unrecognized names still get a stable
 *  mark across renders. */
export function brandKeyFor(seed: string): BrandKey {
  const s = seed.toLowerCase()
  // Keyword shortcuts — match the brand-preset names so the obvious case
  // ("Nest Hotel" → nest mark) doesn't depend on the hash landing right.
  if (/\bnest\b/.test(s)) return 'nest'
  if (/\bemerald\b/.test(s)) return 'emerald'
  if (/\bbronze\b/.test(s)) return 'bronze'
  if (/\bcrimson\b/.test(s)) return 'crimson'
  // Fallback: deterministic hash so unknown names still get a stable mark.
  const keys: BrandKey[] = ['nest', 'emerald', 'bronze', 'crimson']
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return keys[h % keys.length]
}

/** Resolve any incoming string to one of the allowed brand keys. Tolerant
 *  of arbitrary client names — falls through to brandKeyFor() so unknown
 *  brand strings still get a stable mark per name. */
export function resolveBrand(input: string | null | undefined, seedName: string): BrandKey {
  const v = (input || '').toLowerCase() as BrandKey
  if (ALLOWED.has(v)) return v
  return brandKeyFor(seedName)
}

export default function BrandLogo({
  brand,
  size = 'lg',
}: {
  brand: BrandKey
  size?: 'sm' | 'md' | 'lg'
}) {
  const dims = { sm: 22, md: 40, lg: 56 }[size]
  const fg = 'var(--accent)'
  const accentFg = 'var(--accent-fg)'
  // The SVG draws its own filled, stroked rect (matches the Claude Design v3
  // BrandLogo). The .brand-logo wrapper deliberately has no border/background
  // — adding one would double-up over this rect.
  return (
    <span className={`brand-logo size-${size}`} style={{ width: dims, height: dims }}>
      <svg viewBox="0 0 56 56" width={dims} height={dims} aria-hidden="true">
        <rect x="0.5" y="0.5" width="55" height="55" rx="8" fill="var(--accent-soft)" stroke="var(--d-border)" />
        {brand === 'nest' && (
          <g fill={fg}>
            <path d="M28 12 L42 30 L36 30 L28 20 L20 30 L14 30 Z" />
            <path d="M28 24 L40 38 L34 38 L28 31 L22 38 L16 38 Z" opacity="0.65" />
            <rect x="24" y="40" width="8" height="4" rx="1" opacity="0.5" />
          </g>
        )}
        {brand === 'emerald' && (
          <g fill={fg}>
            <path d="M28 12 L40 22 L36 38 L28 44 L20 38 L16 22 Z" />
            <path d="M28 12 L36 38 L20 38 Z" fill={accentFg} opacity="0.18" />
            <path d="M16 22 L40 22" stroke={accentFg} strokeOpacity="0.18" strokeWidth="1.5" />
          </g>
        )}
        {brand === 'bronze' && (
          <g fill={fg}>
            <path d="M28 10 L42 19 L42 37 L28 46 L14 37 L14 19 Z" />
            <path d="M28 18 L36 23 L36 33 L28 38 L20 33 L20 23 Z" fill={accentFg} opacity="0.18" />
            <circle cx="28" cy="28" r="3" fill={accentFg} opacity="0.5" />
          </g>
        )}
        {brand === 'crimson' && (
          <g fill={fg}>
            <path d="M28 10 C32 18, 38 22, 38 32 C38 40, 33 46, 28 46 C23 46, 18 40, 18 32 C18 26, 22 22, 24 16 C25 21, 27 24, 28 10 Z" />
            <path
              d="M28 22 C30 27, 33 30, 33 35 C33 40, 30 43, 28 43 C26 43, 23 40, 23 35 C23 31, 25 29, 26 25 C26.5 28, 27.5 30, 28 22 Z"
              fill={accentFg}
              opacity="0.22"
            />
          </g>
        )}
        {brand === 'default' && (
          <g fill={fg}>
            <rect x="14" y="14" width="12" height="12" rx="2" />
            <rect x="30" y="14" width="12" height="12" rx="2" opacity="0.45" />
            <rect x="14" y="30" width="12" height="12" rx="2" opacity="0.45" />
            <rect x="30" y="30" width="12" height="12" rx="2" />
          </g>
        )}
      </svg>
    </span>
  )
}

/** Brand presets — primary + accent colors per mark. Same palette as the
 *  Claude Design bundle (data.js → brand_presets). The admin uses these
 *  as fallbacks when a dashboard's `brand_primary_color` isn't set. */
export const BRAND_PRESETS: Record<BrandKey, { primary: string; fg_on: string; label: string }> = {
  nest:     { primary: '#1e293b', fg_on: '#fff', label: 'Nest Hotel' },
  emerald:  { primary: '#047857', fg_on: '#fff', label: 'Emerald Resort' },
  bronze:   { primary: '#92400e', fg_on: '#fff', label: 'Bronze Collection' },
  crimson:  { primary: '#9f1239', fg_on: '#fff', label: 'Crimson Hotels' },
  default:  { primary: '#1e293b', fg_on: '#fff', label: 'Convo AI' },
}
