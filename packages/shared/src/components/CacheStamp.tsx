import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLiveStamp } from '../lib/live-data-changed'

/** The cache facts a response carries; the widget render route returns just
 *  these under `cache`, the execute route spreads them at the top level. */
export interface CacheInfo {
  cached?: boolean
  cached_at?: string | null
  age_seconds?: number | null
  expires_in_seconds?: number | null
  cache_ttl?: number | null
  /** Newest write to the tables this figure reads — staleness in business terms. */
  data_changed_at?: string | null
  freshness_sources?: Array<{ table: string; column: string; changed_at: string | null }>
  /** True when the data changed AFTER this cached figure was computed. */
  stale?: boolean
}

/** One line for a tooltip, where a full stamp will not fit. */
export function cacheStampTip(c: CacheInfo): string {
  const age = c.cached_at
    ? Math.max(0, Math.round((Date.now() - Date.parse(c.cached_at)) / 1000))
    : (c.age_seconds ?? null)
  const when = age == null ? 'Cached' : `Updated ${relative(age)}`
  const base =
    c.expires_in_seconds != null
      ? `${when} — refreshes on its own in ${relative(c.expires_in_seconds).replace(' ago', '')}. Click to refresh now.`
      : `${when}. Click to refresh now.`
  return c.stale ? `${base} ${staleText(c)}` : base
}

/** Human name for the table a freshness fact points at. */
const tableLabel = (t: string) => t.replace(/_/g, ' ')

/** "invoices changed 4m ago — newer than this figure" */
export function staleText(c: CacheInfo): string {
  const src = (c.freshness_sources ?? [])
    .filter((s) => s.changed_at && c.cached_at && s.changed_at > c.cached_at)
    .sort((a, b) => (b.changed_at ?? '').localeCompare(a.changed_at ?? ''))[0]
  if (!src?.changed_at) return 'Data changed since this was computed.'
  const age = Math.max(0, Math.round((Date.now() - Date.parse(src.changed_at)) / 1000))
  return `${tableLabel(src.table)} changed ${relative(age)} — newer than this figure.`
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
  data_changed_at?: string | null
  freshness_sources?: Array<{ table: string; column: string; changed_at: string | null }>
  stale?: boolean
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
  className,
  changedLive,
  autoRefresh
}: {
  envelope: CustomQueryEnvelope | undefined
  onRefresh?: () => void
  refreshing?: boolean
  className?: string
  /** A table this figure reads changed since it was computed (see LiveCacheStamp). */
  changedLive?: boolean
  /** The viewer's opt-in to refresh by itself when that happens. */
  autoRefresh?: { on: boolean; onChange: (on: boolean) => void } | null
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

  // An uncached query has no age to show; it only speaks once the data it reads has changed.
  const uncached = !envelope?.cache_ttl
  if (!envelope || (uncached && !changedLive)) return null

  const ageSeconds = cachedAt
    ? Math.max(0, Math.round((Date.now() - cachedAt) / 1000))
    : (envelope.age_seconds ?? null)

  return (
    <div
      className={`flex items-center gap-1.5 text-[11px] text-muted-foreground ${className ?? ''}`}
      data-cache-stamp={envelope.cached ? 'cached' : 'fresh'}
    >
      {!uncached && (
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
      )}
      {envelope.stale ? (
        <span
          data-cache-stale
          className='rounded bg-[#fef3c7] px-1 py-px text-[10.5px] font-medium text-amber-800 dark:bg-[#4a3a10] dark:text-amber-200'
          data-tip={staleText(envelope)}
        >
          {staleText(envelope).replace(/ — newer than this figure\.$/, '')}
        </span>
      ) : changedLive ? (
        <span
          data-cache-changed
          role='status'
          className='rounded bg-[#fef3c7] px-1 py-px text-[10.5px] font-medium text-amber-800 dark:bg-[#4a3a10] dark:text-amber-200'
          data-tip='A record this figure reads was changed after it was computed. Refresh to bring it up to date.'
        >
          Data changed since run
        </span>
      ) : envelope.cached && envelope.data_changed_at ? (
        <span
          data-cache-current
          className='text-[10.5px] text-muted-foreground'
          data-tip={`No write to ${(envelope.freshness_sources ?? []).map((s) => tableLabel(s.table)).join(', ') || 'its sources'} since this was computed`}
        >
          · current
        </span>
      ) : null}
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
      {autoRefresh ? (
        <button
          type='button'
          onClick={() => autoRefresh.onChange(!autoRefresh.on)}
          aria-pressed={autoRefresh.on}
          className={`rounded px-1 py-0.5 hover:bg-muted ${autoRefresh.on ? 'font-medium text-foreground' : ''}`}
          data-cache-auto
          data-tip={
            autoRefresh.on
              ? 'Refreshing on its own when its data changes. Click to stop.'
              : 'Refresh this on its own when its data changes (you can turn it off again)'
          }
        >
          {autoRefresh.on ? 'Auto-refresh on' : 'Auto-refresh'}
        </button>
      ) : null}
    </div>
  )
}

/**
 * CacheStamp that also watches the tables the figure reads (`freshness_sources`): the first
 * write after the run raises "Data changed since run", and the viewer may opt in to refreshing
 * automatically (`scope` keeps that choice, e.g. `widget:7`). Without known tables it is the
 * plain stamp.
 */
export function LiveCacheStamp({
  scope,
  ...stamp
}: Omit<Parameters<typeof CacheStamp>[0], 'changedLive' | 'autoRefresh'> & { scope: string }) {
  const live = useLiveStamp({
    envelope: stamp.envelope,
    scope,
    refresh: () => stamp.onRefresh?.()
  })
  return (
    <CacheStamp
      {...stamp}
      changedLive={live.changed}
      autoRefresh={stamp.onRefresh ? live.autoRefresh : null}
    />
  )
}
