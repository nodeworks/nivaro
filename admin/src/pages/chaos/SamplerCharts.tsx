import { cn } from '@/lib/utils'
import type { ChaosRun, ChaosRunEvent, HypothesisRule } from './api'
import { NoteMarkers } from './Scribe'

/**
 * Cockpit sparklines (#2845): one small chart per sampler, drawn from the run's `sample`
 * events against the pre-run baseline (dashed) with the hypothesis limit (red) and its
 * tolerance band on it. Pure SVG, no library — the series are at most a few hundred points.
 */

/** Labels and units for the built-in samplers (api/src/services/chaos/steady-state.ts). */
export const SAMPLER_LABELS: Record<string, { label: string; unit: string }> = {
  'http.p95_ms': { label: 'Request p95', unit: 'ms' },
  'http.5xx_pct': { label: 'Server errors', unit: '%' },
  'http.rps': { label: 'Requests', unit: 'req/s' },
  'records.save_failures': { label: 'Record saves failed', unit: '/min' },
  'pool.main_wait_p95_ms': { label: 'Main pool wait p95', unit: 'ms' },
  'pool.background_wait_p95_ms': { label: 'Background pool wait p95', unit: 'ms' },
  'loop.lag_ms': { label: 'Event-loop lag', unit: 'ms' },
  'gate.queue': { label: 'Heavy reads waiting', unit: '' },
  'socket.reconnects': { label: 'Socket reconnects', unit: '' }
}

export interface SamplerSeries {
  key: string
  label: string
  unit: string
  points: Array<{ at: number; value: number | null }>
  baseline: number | null
  rule: HypothesisRule | null
  breached: boolean
}

/** The per-sampler series from a run's events (pure). */
export function seriesFrom(run: ChaosRun, events: ChaosRunEvent[]): SamplerSeries[] {
  const samples = events.filter((e) => e.kind === 'sample')
  const keys = new Set<string>()
  for (const r of run.hypothesis) keys.add(r.sampler)
  for (const e of samples)
    for (const k of Object.keys((e.data.s as Record<string, unknown>) ?? {})) keys.add(k)
  const baseline = (run.baseline?.samplers ?? {}) as Record<string, { value?: number | null }>
  return [...keys].map((key) => {
    const meta = SAMPLER_LABELS[key] ?? { label: key, unit: '' }
    const rule = run.hypothesis.find((r) => r.sampler === key) ?? null
    return {
      key,
      label: meta.label,
      unit: meta.unit,
      points: samples.map((e) => {
        const v = (e.data.s as Record<string, unknown> | undefined)?.[key]
        return { at: new Date(e.at).getTime(), value: typeof v === 'number' ? v : null }
      }),
      baseline: typeof baseline[key]?.value === 'number' ? (baseline[key].value as number) : null,
      rule,
      breached: samples.some(
        (e) => (e.data.breach as { sampler?: string } | undefined)?.sampler === key
      )
    }
  })
}

const fmt = (v: number | null, unit: string) =>
  v == null
    ? '—'
    : `${Number.isInteger(v) ? v : v.toFixed(v < 10 ? 2 : 1)}${unit ? ` ${unit}` : ''}`

export function SamplerCharts({
  run,
  events,
  notes = []
}: {
  run: ChaosRun
  events: ChaosRunEvent[]
  /** Scribe marks (#2853) drawn over every chart at their time. */
  notes?: ChaosRunEvent[]
}) {
  const series = seriesFrom(run, events)
  if (series.length === 0)
    return (
      <p className='rounded-lg border border-slate-200 bg-white px-3 py-4 text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
        Waiting for the first sample. The watcher reads every 5 seconds on the replica that armed
        the fault.
      </p>
    )
  // Hypothesis samplers first, then the rest in a stable order.
  const ordered = [...series].sort(
    (a, b) => Number(!!b.rule) - Number(!!a.rule) || a.key.localeCompare(b.key)
  )
  return (
    <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
      {ordered.map((s) => (
        <Sparkline key={s.key} s={s} notes={notes} />
      ))}
    </div>
  )
}

function Sparkline({ s, notes }: { s: SamplerSeries; notes: ChaosRunEvent[] }) {
  const W = 260
  const H = 64
  const padX = 2
  const padY = 6
  const values = s.points.map((p) => p.value).filter((v): v is number => v != null)
  const last = values.length ? values[values.length - 1] : null
  const tol = s.rule?.tolerance ?? 0
  const bandLo = s.rule
    ? s.rule.op === '<' || s.rule.op === '<='
      ? s.rule.limit
      : s.rule.limit - tol
    : null
  const bandHi = s.rule
    ? s.rule.op === '<' || s.rule.op === '<='
      ? s.rule.limit + tol
      : s.rule.limit
    : null
  const domain = [...values]
  if (s.baseline != null) domain.push(s.baseline)
  if (bandLo != null) domain.push(bandLo)
  if (bandHi != null) domain.push(bandHi)
  if (domain.length === 0) domain.push(0, 1)
  let lo = Math.min(...domain, 0)
  let hi = Math.max(...domain)
  if (hi === lo) hi = lo + 1
  const span = hi - lo
  lo -= span * 0.05
  hi += span * 0.05
  const y = (v: number) => padY + (H - padY * 2) * (1 - (v - lo) / (hi - lo))
  const n = Math.max(1, s.points.length - 1)
  const x = (i: number) => padX + ((W - padX * 2) * i) / n
  const path = s.points
    .map((p, i) =>
      p.value == null
        ? null
        : `${i === 0 || s.points[i - 1].value == null ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`
    )
    .filter(Boolean)
    .join(' ')
  const limitY = s.rule ? y(s.rule.limit) : null
  return (
    <figure
      className={cn(
        'rounded-lg border bg-white p-3 dark:bg-card',
        s.breached ? 'border-red-300 dark:border-red-900/60' : 'border-slate-200 dark:border-border'
      )}
    >
      <figcaption className='flex items-baseline justify-between gap-2'>
        <span className='min-w-0 truncate text-[12px] font-medium text-slate-700 dark:text-foreground'>
          {s.label}
          {!s.rule && (
            <span className='ml-1 text-[10.5px] font-normal text-slate-400 dark:text-muted-foreground/70'>
              watched
            </span>
          )}
        </span>
        <span
          className={cn(
            'shrink-0 font-mono text-[12px] tabular-nums',
            s.breached ? 'text-red-700 dark:text-red-300' : 'text-slate-900 dark:text-foreground'
          )}
        >
          {fmt(last, s.unit)}
        </span>
      </figcaption>
      <div className='relative mt-1'>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className='h-16 w-full'
          role='img'
          aria-label={`${s.label}: now ${fmt(last, s.unit)}, baseline ${fmt(s.baseline, s.unit)}${s.rule ? `, limit ${s.rule.op} ${s.rule.limit}` : ''}`}
        >
          {bandLo != null && bandHi != null && bandHi > bandLo && (
            <rect
              x={0}
              y={y(bandHi)}
              width={W}
              height={Math.max(1, y(bandLo) - y(bandHi))}
              className='fill-red-500/10'
            />
          )}
          {limitY != null && (
            <line
              x1={0}
              x2={W}
              y1={limitY}
              y2={limitY}
              className='stroke-red-500'
              strokeWidth={1}
            />
          )}
          {s.baseline != null && (
            <line
              x1={0}
              x2={W}
              y1={y(s.baseline)}
              y2={y(s.baseline)}
              className='stroke-slate-400 dark:stroke-slate-500'
              strokeWidth={1}
              strokeDasharray='3 3'
            />
          )}
          {path && (
            <path
              d={path}
              fill='none'
              className={cn(s.breached ? 'stroke-red-600 dark:stroke-red-400' : 'stroke-nvr-cyan')}
              strokeWidth={1.5}
              strokeLinejoin='round'
              strokeLinecap='round'
            />
          )}
          {last != null && s.points.length > 0 && (
            <circle
              cx={x(s.points.length - 1)}
              cy={y(last)}
              r={2.5}
              className={cn(s.breached ? 'fill-red-600 dark:fill-red-400' : 'fill-nvr-cyan')}
            />
          )}
        </svg>
        {s.points.length > 1 && (
          // Samples are evenly spaced (5 s), so time maps onto the index axis.
          <NoteMarkers notes={notes} from={s.points[0].at} to={s.points[s.points.length - 1].at} />
        )}
      </div>
      <div className='mt-1 flex flex-wrap items-center gap-x-3 text-[10.5px] text-slate-500 dark:text-muted-foreground'>
        <span>
          <span
            className='inline-block w-3 border-t border-dashed border-slate-400 align-middle'
            aria-hidden
          />{' '}
          baseline {fmt(s.baseline, s.unit)}
        </span>
        {s.rule && (
          <span>
            <span className='inline-block w-3 border-t border-red-500 align-middle' aria-hidden />{' '}
            abort {s.rule.op} {s.rule.limit}
            {tol ? ` ± ${tol}` : ''}
          </span>
        )}
      </div>
    </figure>
  )
}
