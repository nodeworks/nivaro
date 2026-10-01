import { Link } from 'react-router'
import { useTrafficMap } from '../context'
import { fmtRate } from '../EventTicker'
import { register } from '../registry/registry'
import { stripTiles } from '../registry/stripTiles'
import { Sparkline } from '../Sparkline'
import { KIND_ORDER, LANE_ORDER } from '../types'
import { fmtLag, inMapOnly, isObj, LINK, StripCell, useTmRoute } from './ops-common'

/**
 * Group E strip tiles: the API node's event loop and GC (#1142), realtime health — journal lag
 * and who watches which live view (#1101), and headroom with a 15-minute projection (#1123/#1153).
 */

interface HealthFrame {
  at: number
  loop_p99: number
  loop_max: number
  gc_ms: number
  emits: number
  emit_ms_max: number
  watch: Array<{ room: string; tabs: number }>
}
interface HealthWindow {
  loop: { p50: number; p99: number; max: number; series: number[] }
  gc: { count: number; ms: number; max: number; per_min: number }
  journal: { emits: number; p95_ms: number; max_ms: number; unjournaled: number }
  watch: Array<{ room: string; tabs: number }>
}

const ALL = { types: new Set(LANE_ORDER), kinds: new Set(KIND_ORDER), caller: '', win: 60 as const }

/** Slow loop: a p99 above this reads as a CPU-bound node. */
const LOOP_WARN_MS = 100
const LOOP_BAD_MS = 250

function useHealth(): { live: HealthFrame | null; win: HealthWindow | null } {
  const { model, win } = useTrafficMap()
  const { data } = useTmRoute<HealthWindow>(['health', win], `/health?window=${win}`, 15_000)
  const live = model.frameExt['node-health']
  return {
    live: isObj(live) ? (live as unknown as HealthFrame) : null,
    win: isObj(data) && isObj(data.loop) ? data : null
  }
}

function watchLine(watch: Array<{ room: string; tabs: number }> | undefined): string {
  const list = Array.isArray(watch) ? watch : []
  if (!list.length) return 'no live views open'
  return list
    .slice(0, 4)
    .map((w) => `${w.room} ${w.tabs}`)
    .join(' · ')
}

export function EventLoopTile() {
  const { model, win: w } = useTrafficMap()
  const { live, win } = useHealth()
  const p99 = live?.loop_p99 ?? win?.loop.p99 ?? null
  const tone =
    p99 != null && p99 >= LOOP_BAD_MS
      ? 'bad'
      : p99 != null && p99 >= LOOP_WARN_MS
        ? 'warn'
        : undefined
  const rps = model.totals(w, ALL)
  return (
    <StripCell
      label='Event loop'
      value={p99 != null ? fmtLag(p99).replace(/ (ms|s)$/, '') : '—'}
      unit={p99 != null && p99 >= 1000 ? 's p99' : 'ms p99'}
      tone={tone}
      testId='tm-strip-loop'
    >
      <span
        className='truncate tabular-nums'
        title={
          win
            ? `${win.gc.count} GC pauses in the window, ${fmtLag(win.gc.ms)} in all, longest ${fmtLag(win.gc.max)}`
            : undefined
        }
      >
        max {fmtLag(win?.loop.max ?? live?.loop_max)} · GC {win ? `${win.gc.per_min}/min` : '—'}
      </span>
      <span className='flex min-w-0 items-center gap-2'>
        <span className='truncate tabular-nums' title='Requests per second beside the loop lag'>
          at {fmtRate(rps.req / w)} req/s{tone ? ' · CPU-bound if SQL is fast' : ''}
        </span>
        {win?.loop.series.some((v) => v > 0) && (
          <Sparkline
            data={win.loop.series}
            color='var(--tm-update)'
            className='h-[14px] min-w-[36px] flex-1'
          />
        )}
      </span>
    </StripCell>
  )
}

export function RealtimeTile() {
  const { live, win } = useHealth()
  const p95 = win?.journal.p95_ms ?? null
  return (
    <StripCell
      label='Realtime'
      value={
        p95 != null && win && win.journal.emits > 0 ? fmtLag(p95).replace(/ (ms|s)$/, '') : '—'
      }
      unit='ms journal p95'
      tone={win && win.journal.unjournaled > 0 ? 'warn' : undefined}
      testId='tm-strip-realtime'
    >
      <span className='truncate tabular-nums'>
        {win ? `${win.journal.emits.toLocaleString()} emits` : '—'}
        {win && win.journal.unjournaled > 0
          ? ` · ${win.journal.unjournaled} unjournaled (Redis)`
          : win
            ? ' · all journaled'
            : ''}
      </span>
      <span className='flex min-w-0 items-center justify-between gap-2'>
        <span className='truncate' title='Tabs watching each live view on this node'>
          {watchLine(live?.watch ?? win?.watch)}
        </span>
        <Link to='/realtime' className={`${LINK} shrink-0`} id='tm-realtime-link'>
          Realtime
        </Link>
      </span>
    </StripCell>
  )
}

interface Capacity {
  now_rps: number
  ring_best_rps: number
  ceiling: {
    rps: number | null
    source: 'configured' | 'measured' | 'ring' | null
    at: string | null
    measuring: boolean
    error: string | null
  }
  headroom_pct: number | null
  pool: { used: number; pending: number; max: number; saturated_pct: number }
  projection: {
    points: number[]
    trend: 'rising' | 'falling' | 'flat'
    minutes_to_ceiling: number | null
    minutes_to_pool_limit: number | null
  }
}

const SOURCE_PHRASE: Record<string, string> = {
  configured: 'configured (TRAFFIC_CAPACITY_RPS)',
  measured: 'the busiest minute in the request log',
  ring: 'the busiest minute since this node started'
}

function ceilingTitle(c: Capacity): string {
  if (c.ceiling.error) return `Ceiling from this node only: ${c.ceiling.error}`
  if (!c.ceiling.source) return ''
  const at = c.ceiling.at
    ? ` (${new Date(c.ceiling.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})`
    : ''
  return `Ceiling: ${SOURCE_PHRASE[c.ceiling.source]}${at}`
}

function projectionLine(c: Capacity): string {
  const p = c.projection
  if (p.minutes_to_pool_limit != null)
    return `Past the pool limit in ${p.minutes_to_pool_limit} min at this rate`
  if (p.minutes_to_ceiling != null)
    return `Past the ceiling in ${p.minutes_to_ceiling} min at this rate`
  const peak = Math.max(0, ...p.points)
  return p.trend === 'rising'
    ? `Rising — up to ${fmtRate(peak)} req/s in 15 min`
    : p.trend === 'falling'
      ? 'Falling over the next 15 min'
      : 'Steady over the next 15 min'
}

export function HeadroomTile() {
  const { data } = useTmRoute<Capacity>(['capacity'], '/capacity', 10_000)
  const c = isObj(data) && isObj(data.ceiling) && isObj(data.projection) ? data : null
  const pct = c?.headroom_pct ?? null
  const warn =
    c?.projection.minutes_to_pool_limit != null || c?.projection.minutes_to_ceiling != null
  return (
    <StripCell
      label='Headroom'
      value={pct != null ? String(pct) : '—'}
      unit='% of capacity'
      tone={pct != null && pct >= 90 ? 'bad' : pct != null && pct >= 70 ? 'warn' : undefined}
      testId='tm-strip-headroom'
      className='min-[1280px]:col-span-2'
    >
      <span className='truncate tabular-nums' title={c ? ceilingTitle(c) : undefined}>
        {!c
          ? '—'
          : c.ceiling.rps == null
            ? c.ceiling.measuring
              ? 'Measuring the busiest minute from the request log…'
              : 'No ceiling yet'
            : `${fmtRate(c.now_rps)} of ${fmtRate(c.ceiling.rps)} req/s · pool ${c.pool.used}/${c.pool.max || '—'}${c.pool.saturated_pct ? `, full ${c.pool.saturated_pct}%` : ''}`}
      </span>
      <span className='flex min-w-0 items-center gap-2'>
        <span
          className={`truncate ${warn ? 'font-medium text-[var(--tm-update)]' : ''}`}
          data-testid='tm-strip-projection'
        >
          {c ? projectionLine(c) : 'Projection after the first minute'}
        </span>
        {c?.projection.points.some((v) => v > 0) && (
          <Sparkline
            data={c.projection.points}
            color={warn ? 'var(--tm-update)' : 'var(--tm-accent)'}
            className='h-[14px] min-w-[48px] flex-1'
          />
        )}
      </span>
    </StripCell>
  )
}

register(stripTiles, { id: 'ops-event-loop', order: 10, Component: inMapOnly(EventLoopTile) })
register(stripTiles, { id: 'ops-realtime', order: 11, Component: inMapOnly(RealtimeTile) })
register(stripTiles, { id: 'ops-headroom', order: 12, Component: inMapOnly(HeadroomTile) })
