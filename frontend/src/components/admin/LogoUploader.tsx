import { useRef, useState } from 'react'

import { I } from './icons'

/**
 * Logo input with two ways to set a value:
 *   1. **Upload** — click "Choose file" → file picker → image is read
 *      as a base64 `data:image/...` URI and passed to `onChange`.
 *      Self-contained: no upload endpoint required, the URI is stored
 *      directly in `brand_logo_url` (Postgres TEXT, JSONB-friendly).
 *      Capped at ~250KB raw file size — most real hotel logos are
 *      5–60KB so this is generous; reject anything bigger with a clear
 *      error rather than silently storing a 2MB string.
 *   2. **Paste URL** — keep the original https://… input as a fallback
 *      for clients hosting their logo on a CDN.
 *
 * Renders a live preview at the top + a "Remove" affordance when a
 * value is present, so the admin can see exactly what gets shipped to
 * the public dashboard.
 *
 * The component is purely presentational — parent owns the value +
 * onChange. It does NOT call the API; the parent's save button does.
 */
const MAX_BYTES = 250 * 1024  // 250 KB — generous for any reasonable logo

export default function LogoUploader({
  value,
  onChange,
  fallbackPreview,
  helpText,
}: {
  value: string
  onChange: (next: string) => void
  // What to render in the preview slot when there's no value yet
  // (e.g. the brand-mark SVG with the client's initial). Caller
  // passes JSX so we don't have to know about brand presets here.
  fallbackPreview?: React.ReactNode
  // Custom help text below the URL field; defaults to a sensible
  // explanation when omitted.
  helpText?: React.ReactNode
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [err, setErr] = useState<string | null>(null)

  function pickFile(file: File) {
    setErr(null)
    if (!file.type.startsWith('image/')) {
      setErr(`Not an image (got ${file.type || 'unknown type'})`)
      return
    }
    if (file.size > MAX_BYTES) {
      const kb = Math.round(file.size / 1024)
      setErr(`File is ${kb} KB — must be under ${Math.round(MAX_BYTES / 1024)} KB`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') {
        onChange(result)
      }
    }
    reader.onerror = () => setErr('Could not read the file')
    reader.readAsDataURL(file)
  }

  const isDataUri = value.startsWith('data:')
  const sizeHint =
    isDataUri && value.length > 0
      ? `${Math.round((value.length * 0.75) / 1024)} KB`  // base64 → bytes
      : null

  return (
    <div className="form-row">
      {/* Preview row — current logo (if any) + remove + replace buttons */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: 14,
          background: 'var(--bg-muted)',
          border: '1px solid var(--d-border)',
          borderRadius: 'var(--d-radius-lg)',
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 8,
            background: 'var(--d-surface)',
            border: '1px solid var(--d-border)',
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {value ? (
            <img
              src={value}
              alt=""
              style={{ maxWidth: '88%', maxHeight: '88%', objectFit: 'contain' }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none'
              }}
            />
          ) : (
            fallbackPreview ?? (
              <span
                style={{
                  fontFamily: 'var(--d-font-mono)',
                  fontSize: 10.5,
                  color: 'var(--fg-4)',
                  textAlign: 'center',
                  padding: '0 6px',
                }}
              >
                no logo
              </span>
            )
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--d-fg)' }}>
            {value ? (isDataUri ? 'Uploaded image' : 'External URL') : 'No logo set'}
          </div>
          <div
            style={{
              fontFamily: 'var(--d-font-mono)',
              fontSize: 11,
              color: 'var(--fg-3)',
              marginTop: 3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={value || ''}
          >
            {!value
              ? '—'
              : isDataUri
                ? `data:image/… · ${sizeHint}`
                : value.length > 60
                  ? value.slice(0, 60) + '…'
                  : value}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => fileRef.current?.click()}
          >
            <I name="plus" />
            {value ? 'Replace' : 'Upload'}
          </button>
          {value && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => onChange('')}
              title="Remove logo"
            >
              Remove
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) pickFile(f)
            // Reset so the same file can be picked again after a remove.
            e.target.value = ''
          }}
        />
      </div>

      {err && (
        <div
          style={{
            color: 'var(--neg)',
            fontSize: 12,
            fontFamily: 'var(--d-font-mono)',
            marginTop: 6,
          }}
        >
          {err}
        </div>
      )}

      {/* URL fallback for CDN-hosted logos */}
      <div style={{ marginTop: 10 }}>
        <span className="l" style={{ fontSize: 10.5, marginBottom: 6, display: 'block' }}>
          Or paste a URL
        </span>
        <input
          className="form-input mono"
          placeholder="https://example.com/logo.png"
          value={isDataUri ? '' : value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="help">
          {helpText ??
            'PNG, JPEG, SVG, or WebP. Square + transparent reads best. Uploads up to 250 KB are embedded inline; bigger logos need a hosted URL.'}
        </span>
      </div>
    </div>
  )
}
