import { useQuery } from '@tanstack/react-query'
import { useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

/**
 * #1130 — a compact Traffic Map card for dashboards (admin Command Center, the efp-new admin
 * dashboard canvas): requests per minute, errors and p95 over the window, a sparkline per busy
 * lane and the busiest entities. Reads GET /traffic-map/snapshot (administrators only): for
 * anyone else, or where the map is unavailable, it renders nothing.
 */
interface MiniSnapshotEntity {
  key: string
  lane: string
  label: string
  req: number
  error: number
  series: number[]
}
export interface MiniSnapshot {
  window_s: number
  node_scope?: string
  entities: MiniSnapshotEntity[]
  totals: { req: number; error: number; p95: number }
}
export interface MiniMapSummary {
  rpm: number
  req: number
  errors: number
  errPct: number
  p95: number
  lanes: Array<{ lane: string; label: string; req: number; series: number[] }>
  top: Array<{ key: string; label: string; req: number }>
}

const LANE_LABEL: Record<string, string> = {
  items: 'Collections',
  widgets: 'Widgets',
  pages: 'Pages',
  queries: 'Queries',
  graphql: 'GraphQL',
  inbound: 'Inbound',
  files: 'Files',
  extension: 'Extensions',
  system: 'System',
  other: 'Other'
}

/** The card's figures from a snapshot (pure). */
export function miniMapSummary(snap: MiniSnapshot, lanes = 4, top = 3): MiniMapSummary {
  const byLane = new Map<string, { req: number; series: number[] }>()
  for (const e of snap.entities) {
    let l = byLane.get(e.lane)
    if (!l) {
      l = { req: 0, series: new Array<number>(e.series.length).fill(0) }
      byLane.set(e.lane, l)
    }
    l.req += e.req
    e.series.forEach((v, i) => {
      l.series[i] = (l.series[i] ?? 0) + v
    })
  }
  const req = snap.totals.req
  return {
    rpm: snap.window_s ? (req * 60) / snap.window_s : 0,
    req,
    errors: snap.totals.error,
    errPct: req ? (100 * snap.totals.error) / req : 0,
    p95: snap.totals.p95,
    lanes: [...byLane]
      .filter(([, l]) => l.req > 0)
      .sort((a, b) => b[1].req - a[1].req)
      .slice(0, lanes)
      .map(([lane, l]) => ({
        lane,
        label: LANE_LABEL[lane] ?? lane,
        req: l.req,
        series: l.series
      })),
    top: snap.entities
      .filter((e) => e.req > 0 && !e.key.endsWith('/__other__'))
      .sort((a, b) => b.req - a.req)
      .slice(0, top)
      .map((e) => ({ key: e.key, label: e.label, req: e.req }))
  }
}

function Spark({ data, className }: { data: number[]; className?: string }) {
  const w = 96
  const h = 20
  const max = Math.max(1, ...data)
  const pts = data
    .map(
      (v, i) =>
        `${((i / Math.max(1, data.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`
    )
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      className={className}
      aria-hidden='true'
      preserveAspectRatio='none'
    >
      <polyline
        points={pts}
        fill='none'
        stroke='currentColor'
        strokeWidth='1.5'
        strokeLinejoin='round'
      />
    </svg>
  )
}

const n0 = (n: number) => Math.round(n).toLocaleString()
const rate = (n: number) => (n < 10 ? n.toFixed(1) : n0(n))
const ms = (n: number) =>
  !n ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`

const TONES = {
  // always dark (Command Center)
  dark: {
    card: 'rounded-lg border border-white/10 bg-[#101828] text-[#e2e8f0]',
    head: 'border-b border-white/10',
    muted: 'text-[#94a3b8]',
    spark: 'text-[#38cfe9]',
    error: 'text-[#f59595]',
    link: 'text-[#67e8f9] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#67e8f9]'
  },
  // follows the host theme
  auto: {
    card: 'rounded-lg border border-slate-200 bg-white text-slate-900 dark:border-[#3c4049] dark:bg-[#1b1e24] dark:text-[#edf0f3]',
    head: 'border-b border-slate-100 dark:border-[#30343c]',
    muted: 'text-slate-500 dark:text-[#949ca8]',
    spark: 'text-[#0891b2] dark:text-[#38cfe9]',
    error: 'text-[#b91c1c] dark:text-[#f59595]',
    link: 'text-[#0e7490] hover:underline dark:text-[#67e8f9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0891b2]'
  }
} as const

export function TrafficMiniMap({
  window: win = 300,
  tone = 'auto',
  href,
  refreshMs = 15_000,
  className
}: {
  window?: 60 | 300 | 900
  tone?: 'auto' | 'dark'
  /** Where "Open" goes. An absolute URL (another app's admin) opens in a new tab; default /traffic-map. */
  href?: string
  refreshMs?: number
  className?: string
}) {
  const client = useNivaroClient()
  const { navigate } = useNavigation()
  const t = TONES[tone]
  const q = useQuery<MiniSnapshot | null>({
    queryKey: ['traffic-mini-map', win],
    queryFn: () =>
      client
        .request<{ data: MiniSnapshot }>(get('/traffic-map/snapshot', { window: win }))
        .then((r) => r.data)
        .catch(() => null), // not an administrator, or no map here: render nothing
    refetchInterval: refreshMs,
    staleTime: refreshMs / 2
  })
  if (!q.data) return null
  const s = miniMapSummary(q.data)
  const target = href ?? '/traffic-map'
  const external = /^https?:\/\//.test(target)
  const span = win === 60 ? 'last minute' : `last ${win / 60} min`
  return (
    <section
      className={`${t.card} ${className ?? ''}`}
      aria-label='Traffic'
      data-traffic-mini-map=''
    >
      <div className={`flex items-center justify-between gap-2 px-3 py-2 ${t.head}`}>
        <h3 className='text-[12.5px] font-semibold'>
          Traffic <span className={`font-normal ${t.muted}`}>· {span}</span>
        </h3>
        <a
          href={target}
          target={external ? '_blank' : undefined}
          rel={external ? 'noreferrer' : undefined}
          className={`rounded text-[12px] font-medium ${t.link}`}
          onClick={(e) => {
            if (external || e.metaKey || e.ctrlKey) return
            e.preventDefault()
            navigate(target)
          }}
          data-traffic-mini-open=''
        >
          Open map
        </a>
      </div>
      <div className='grid grid-cols-3 gap-2 px-3 pt-2.5 text-[12px] tabular-nums'>
        <div>
          <p className='text-[18px] font-semibold leading-tight' data-traffic-mini-rpm=''>
            {rate(s.rpm)}
          </p>
          <p className={t.muted}>requests/min</p>
        </div>
        <div>
          <p className={`text-[18px] font-semibold leading-tight ${s.errors ? t.error : ''}`}>
            {n0(s.errors)}
          </p>
          <p className={t.muted}>errors{s.req ? ` · ${s.errPct.toFixed(1)}%` : ''}</p>
        </div>
        <div>
          <p className='text-[18px] font-semibold leading-tight'>{ms(s.p95)}</p>
          <p className={t.muted}>p95</p>
        </div>
      </div>
      {s.lanes.length === 0 ? (
        <p className={`px-3 py-2.5 text-[12px] ${t.muted}`}>No API traffic in the window.</p>
      ) : (
        <ul className='space-y-1 px-3 pb-1 pt-2.5 text-[12px]'>
          {s.lanes.map((l) => (
            <li key={l.lane} className='flex items-center gap-2' data-traffic-mini-lane={l.lane}>
              <span className='w-[84px] shrink-0 truncate'>{l.label}</span>
              <Spark data={l.series} className={`min-w-0 flex-1 ${t.spark}`} />
              <span className={`w-[52px] shrink-0 text-right tabular-nums ${t.muted}`}>
                {n0(l.req)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {s.top.length > 0 && (
        <p className={`truncate px-3 pb-2.5 pt-1 text-[11.5px] ${t.muted}`}>
          Busiest: {s.top.map((e) => `${e.label} (${n0(e.req)})`).join(', ')}
        </p>
      )}
    </section>
  )
}
