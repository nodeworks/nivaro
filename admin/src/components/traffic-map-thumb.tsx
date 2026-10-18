import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '@/lib/api'

/**
 * #2181 — a small picture of the Traffic Map at the moment of an incident-timeline event: the
 * busiest nodes of the nearest stored snapshot as bars (errors in red), linking to the full
 * snapshot. A timeline event with no snapshot within the hour shows nothing.
 */
export interface MapThumb {
  at: string
  id: string | null
  name: string | null
  snapshot_at: string | null
  thumb: {
    at: string
    window_s: number
    req: number
    error: number
    p95: number
    bars: Array<{ label: string; req: number; error: number }>
    environment: string | null
  } | null
}

const W = 96
const H = 32
const MAX_EVENTS = 40

/** The map pictures nearest to a list of moments (one read for the lot). */
export function useMapThumbs(times: string[]): Map<string, MapThumb> {
  const unique = [...new Set(times)].slice(0, MAX_EVENTS)
  const q = useQuery({
    queryKey: ['traffic-map-thumbs', unique.join('|')],
    queryFn: async () => {
      const qs = unique.map((t) => `at=${encodeURIComponent(t)}`).join('&')
      return (await api.get(`/traffic-map/snapshots/near?${qs}`)).data.data as MapThumb[]
    },
    enabled: unique.length > 0,
    staleTime: 5 * 60_000,
    retry: false
  })
  return new Map((q.data ?? []).map((t) => [t.at, t]))
}

/** Bars scaled to the busiest node (pure): width of each bar and the error share of it. */
export function barGeometry(
  bars: Array<{ req: number; error: number }>
): Array<{ h: number; errH: number }> {
  const max = Math.max(1, ...bars.map((b) => b.req))
  return bars.map((b) => {
    const h = Math.max(2, Math.round((b.req / max) * (H - 4)))
    const errH = b.error > 0 && b.req > 0 ? Math.max(1, Math.round((b.error / b.req) * h)) : 0
    return { h, errH }
  })
}

export function MapThumbLink({ t }: { t: MapThumb | undefined }) {
  if (!t?.id || !t.thumb) return null
  const { thumb } = t
  const geo = barGeometry(thumb.bars)
  const gap = 3
  const bw = Math.floor((W - gap * (geo.length + 1)) / Math.max(1, geo.length))
  const when = t.snapshot_at ? new Date(t.snapshot_at).toLocaleString() : ''
  const label = `Map snapshot ${t.name ?? ''} ${when}: ${thumb.req.toLocaleString('en-US')} requests, ${thumb.error.toLocaleString('en-US')} errors`
  return (
    <Link
      to={`/traffic-map?snapshot=${t.id}`}
      className='shrink-0 rounded border border-slate-200 bg-slate-50 p-0.5 hover:border-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-muted/40'
      data-tip={`${t.name ?? 'Map snapshot'} · ${when}`}
      aria-label={label}
      data-map-thumb={t.id}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role='img' aria-hidden='true'>
        {geo.map((g, i) => {
          const x = gap + i * (bw + gap)
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed order bars
            <g key={i}>
              <rect
                x={x}
                y={H - 2 - g.h}
                width={bw}
                height={g.h}
                rx={1}
                className='fill-sky-500/70 dark:fill-sky-400/70'
              />
              {g.errH > 0 && (
                <rect
                  x={x}
                  y={H - 2 - g.h}
                  width={bw}
                  height={g.errH}
                  rx={1}
                  className='fill-red-600 dark:fill-red-400'
                />
              )}
            </g>
          )
        })}
      </svg>
    </Link>
  )
}
