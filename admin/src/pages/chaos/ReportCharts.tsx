import { useMemo } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { cn } from '@/lib/utils'
import {
  CHART_TICK,
  CHART_TOOLTIP,
  type ChaosColors,
  type RunReport,
  type SamplerSeries,
  useChaosColors
} from './report-api'
import { SAMPLER_LABELS } from './SamplerCharts'

/**
 * Before / during / after charts (#2849): one small chart per sampler, x = time relative to the
 * moment the fault was armed. The fault window is a faint wash, the baseline band a tinted strip,
 * the hypothesis limit a dashed line, and alerts and notes thin markers — so "did it cross, and
 * when did it come back" reads at a glance. Single series per chart: the title names it.
 */

const rel = (s: number) => {
  const sign = s < 0 ? '−' : '+'
  const a = Math.abs(Math.round(s))
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}

const PHASE_WORD = { before: 'before the fault', during: 'during the fault', after: 'after' }

export function ReportCharts({ report }: { report: RunReport }) {
  const colors = useChaosColors()
  const armed = report.armed_at ? new Date(report.armed_at).getTime() : null
  const disarmed = report.disarmed_at ? new Date(report.disarmed_at).getTime() : null
  if (!report.series.length)
    return (
      <p className='rounded-lg border border-slate-200 bg-white px-4 py-5 text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
        No steady-state samples were recorded for this run, so there is nothing to chart. Runs with
        a hypothesis sample their limits every few seconds while the fault is armed.
      </p>
    )
  return (
    <div className='grid gap-4 lg:grid-cols-2'>
      {report.series.map((s) => (
        <SeriesChart
          key={s.key}
          series={s}
          armed={armed}
          disarmed={disarmed}
          markers={report.markers}
          colors={colors}
        />
      ))}
    </div>
  )
}

function SeriesChart({
  series,
  armed,
  disarmed,
  markers,
  colors
}: {
  series: SamplerSeries
  armed: number | null
  disarmed: number | null
  markers: RunReport['markers']
  colors: ChaosColors
}) {
  const origin = armed ?? series.points[0]?.t ?? 0
  const data = useMemo(
    () =>
      series.points.map((p) => ({
        x: Math.round((p.t - origin) / 1000),
        v: p.v,
        phase: p.phase
      })),
    [series.points, origin]
  )
  const end = disarmed != null ? Math.round((disarmed - origin) / 1000) : null
  const events = markers.filter(
    (m) => m.kind === 'alert' || m.kind === 'note' || m.kind === 'declared'
  )
  const values = data.map((d) => d.v).filter((v): v is number => v != null)
  const worst = values.length
    ? series.rule && (series.rule.op === '>' || series.rule.op === '>=')
      ? Math.min(...values)
      : Math.max(...values)
    : null
  const label = `${series.key}: ${values.length} samples${worst != null ? `, worst ${worst}` : ''}${series.rule ? `, limit ${series.rule.op} ${series.rule.limit}` : ''}${series.breached ? ', crossed while the fault ran' : ''}`

  return (
    <section className='min-w-0 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <header className='mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
        <h3 className='min-w-0 text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          {SAMPLER_LABELS[series.key]?.label ?? series.key}
          {SAMPLER_LABELS[series.key] && (
            <span className='ml-1.5 font-mono text-[11px] font-normal text-slate-500 dark:text-muted-foreground'>
              {series.key}
            </span>
          )}
        </h3>
        <div className='flex items-center gap-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {series.rule && (
            <span className='font-mono tabular-nums'>
              {series.rule.op} {series.rule.limit}
              {series.rule.tolerance ? ` ± ${series.rule.tolerance}` : ''}
            </span>
          )}
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10.5px] font-medium',
              series.breached
                ? 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300'
                : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
            )}
          >
            {series.breached ? 'Crossed' : 'Held'}
          </span>
        </div>
      </header>
      {data.length === 0 ? (
        <p className='py-8 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
          No samples for this limit.
        </p>
      ) : (
        <div
          role='img'
          aria-label={label}
          className='h-44 text-slate-500 dark:text-muted-foreground'
        >
          <ResponsiveContainer width='100%' height='100%'>
            <LineChart data={data} margin={{ top: 6, right: 10, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke='currentColor' strokeOpacity={0.1} />
              {armed != null && (
                <ReferenceArea
                  x1={0}
                  x2={end ?? data[data.length - 1].x}
                  fill={colors.muted}
                  fillOpacity={0.08}
                  ifOverflow='extendDomain'
                />
              )}
              {series.band && (
                <ReferenceArea
                  y1={series.band.lo}
                  y2={series.band.hi === series.band.lo ? series.band.hi + 1e-9 : series.band.hi}
                  fill={colors.held}
                  fillOpacity={0.12}
                  stroke={colors.held}
                  strokeOpacity={0.25}
                  ifOverflow='extendDomain'
                />
              )}
              {series.rule && (
                <ReferenceLine
                  y={series.rule.limit}
                  stroke={colors.broke}
                  strokeDasharray='4 3'
                  strokeWidth={1.5}
                  ifOverflow='extendDomain'
                />
              )}
              {armed != null && <ReferenceLine x={0} stroke={colors.ink} strokeOpacity={0.5} />}
              {end != null && <ReferenceLine x={end} stroke={colors.ink} strokeOpacity={0.5} />}
              {events.map((m) => (
                <ReferenceLine
                  key={`${m.kind}-${m.t}`}
                  x={Math.round((m.t - origin) / 1000)}
                  stroke={m.kind === 'alert' ? colors.aborted : colors.info}
                  strokeDasharray='2 3'
                  ifOverflow='extendDomain'
                />
              ))}
              <XAxis
                dataKey='x'
                type='number'
                domain={['dataMin', 'dataMax']}
                tickFormatter={rel}
                tick={CHART_TICK}
                tickLine={false}
                axisLine={{ stroke: 'currentColor', strokeOpacity: 0.2 }}
              />
              <YAxis tick={CHART_TICK} tickLine={false} axisLine={false} width={48} allowDecimals />
              <Tooltip
                contentStyle={CHART_TOOLTIP}
                labelFormatter={(x, p) => {
                  const phase = p?.[0]?.payload?.phase as keyof typeof PHASE_WORD | undefined
                  return `${rel(Number(x))}${phase ? ` · ${PHASE_WORD[phase]}` : ''}`
                }}
                formatter={(v) => [v as number, SAMPLER_LABELS[series.key]?.label ?? series.key]}
              />
              <Line
                type='monotone'
                dataKey='v'
                stroke={colors.line}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  )
}

/** The key under the charts: what the wash, band, dashed line and markers mean. */
export function ChartKey() {
  const colors = useChaosColors()
  const item = 'flex items-center gap-1.5'
  return (
    <div className='flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
      <span className={item}>
        <span className='h-3 w-4 rounded-sm' style={{ background: colors.muted, opacity: 0.2 }} />
        Fault armed
      </span>
      <span className={item}>
        <span
          className='h-3 w-4 rounded-sm border'
          style={{ background: colors.held, opacity: 0.35, borderColor: colors.held }}
        />
        Normal range before the drill
      </span>
      <span className={item}>
        <span
          aria-hidden
          className='w-4 border-t-2 border-dashed'
          style={{ borderColor: colors.broke }}
        />
        Limit
      </span>
      <span className={item}>
        <span
          aria-hidden
          className='h-3.5 border-l-2 border-dashed'
          style={{ borderColor: colors.aborted }}
        />
        Alert
      </span>
      <span className={item}>
        <span
          aria-hidden
          className='h-3.5 border-l-2 border-dashed'
          style={{ borderColor: colors.info }}
        />
        Note
      </span>
    </div>
  )
}
