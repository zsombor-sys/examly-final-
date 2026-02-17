import type { ReactNode } from 'react'

type Props = {
  value: unknown
  className?: string
}

function parseIfJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const raw = value.trim()
  if (!raw) return ''
  const looksJson =
    (raw.startsWith('{') && raw.endsWith('}')) ||
    (raw.startsWith('[') && raw.endsWith(']'))
  if (!looksJson) return value
  try {
    return JSON.parse(raw)
  } catch {
    return value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function bulletsFrom(value: unknown): string[] | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value.bullets)) return null
  const bullets = value.bullets
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  return bullets.length > 0 ? bullets : null
}

function renderObject(value: Record<string, unknown>): ReactNode {
  const entries = Object.entries(value).filter(([, v]) => v != null && v !== '')
  if (entries.length === 0) return null
  const scalarOnly = entries.every(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
  if (scalarOnly) {
    return (
      <div className="space-y-2">
        {entries.map(([k, v]) => (
          <div key={k} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/80">
            <span className="text-white/55">{k}:</span> {String(v)}
          </div>
        ))}
      </div>
    )
  }

  return (
    <pre className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-x-auto whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

export default function StructuredText({ value, className }: Props) {
  const parsed = parseIfJsonString(value)

  if (parsed == null || parsed === '') return null

  const bullets = bulletsFrom(parsed)
  if (bullets) {
    return (
      <ul className={className ? className : 'list-disc space-y-1 pl-5 text-sm text-white/80'}>
        {bullets.map((item, i) => (
          <li key={`${item}-${i}`}>{item}</li>
        ))}
      </ul>
    )
  }

  if (typeof parsed === 'string') {
    return <div className={className ? className : 'text-sm text-white/80 whitespace-pre-wrap'}>{parsed}</div>
  }

  if (Array.isArray(parsed)) {
    if (parsed.every((x) => typeof x === 'string')) {
      return (
        <ul className={className ? className : 'list-disc space-y-1 pl-5 text-sm text-white/80'}>
          {parsed.map((item, i) => (
            <li key={`${item}-${i}`}>{item}</li>
          ))}
        </ul>
      )
    }
    return (
      <pre className={className ? className : 'rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/75 overflow-x-auto whitespace-pre-wrap'}>
        {JSON.stringify(parsed, null, 2)}
      </pre>
    )
  }

  if (isRecord(parsed)) return renderObject(parsed)

  return <div className={className ? className : 'text-sm text-white/80'}>{String(parsed)}</div>
}

