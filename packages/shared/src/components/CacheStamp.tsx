import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

/** The cache facts a response carries; the widget render route returns just
 *  these under `cache`, the execute route spreads them at the top level. */
export interface CacheInfo {
  cached?: boolean
  cached_at?: string | null
  age_seconds?: number | null
  expires_in_seconds?: number | null
  cache_ttl?: number | null
}

/** One line for a tooltip, where a full stamp will not fit. */
export function cacheStampTip(c: CacheInfo): string {
  const age = c.cached_at
    ? Math.max(0, Math.round((Date.now() - Date.parse(c.cached_at)) / 1000))
    : (c.age_seconds ?? null)
  const when = age == null ? 'Cached' : `Updated ${relative(age)}`
  return c.expires_in_seconds != null
    ? `${when} — refreshes on its own in ${relative(c.expires_in_seconds).replace(' ago', '')}. Click to refresh now.`
    : `${when}. Click to refresh now.`
}

/**
 * The envelope `POST /custom-queries/:slug/execute` returns. Older servers
 * answer with `data`/`cached` only, so every cache field is optional and the
 * stamp simply renders nothing when they are absent.
 */
export interface CustomQueryEnvelope {
  data: Array<Record<string, unknown>>
  cached?: boolean
  cached_at?: string | null
  age_seconds?: number | null
  expires_in_seconds?: number | null
  cache_ttl?: number | null
  executed_at?: string | null
}

const relative = (seconds: number): string => {
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * "Updated 3m ago · Refresh" for a cached figure.
 *
 * A cache the viewer cannot see is a number they cannot trust: without this
 * a report served from Redis is indistinguishable from one just computed.
 * Renders nothing for an uncached query — there is nothing to disclose.
 */
export function CacheStamp({
  envelope,
  onRefresh,
  refreshing,
  className
}: {
  envelope: CustomQueryEnvelope | undefined
  onRefresh?: () => void
  refreshing?: boolean
  className?: string
}) {
  // Age is counted from the stamp, not from render, so the label keeps moving
  // while the widget sits open.
  const [, setTick] = useState(0)
  const cachedAt = envelope?.cached_at ? Date.parse(envelope.cached_at) : null
  useEffect(() => {
    if (!cachedAt) return
    const id = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [cachedAt])

  if (!envelope || !envelope.cache_ttl) return null

  const ageSeconds = cachedAt
    ? Math.max(0, Math.round((Date.now() - cachedAt) / 1000))
    : (envelope.age_seconds ?? null)

  return (
    <div
      className={`flex items-center gap-1.5 text-[11px] text-muted-foreground ${className ?? ''}`}
      data-cache-stamp={envelope.cached ? 'cached' : 'fresh'}
    >
      <span
        data-tip={
          envelope.expires_in_seconds != null
            ? `Cached result — refreshes on its own in ${relative(envelope.expires_in_seconds).replace(' ago', '')}`
            : 'Computed for this request'
        }
      >
        {ageSeconds == null
          ? envelope.cached
            ? 'Cached'
            : 'Updated just now'
          : `Updated ${relative(ageSeconds)}`}
      </span>
      {onRefresh ? (
        <button
          type='button'
          onClick={onRefresh}
          disabled={refreshing}
          className='inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted disabled:opacity-50'
          data-cache-refresh
          aria-label='Refresh this data'
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      ) : null}
    </div>
  )
}
