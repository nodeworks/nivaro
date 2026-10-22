import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  CHART_TICK,
  CHART_TOOLTIP,
  fetchTrends,
  fmtSeconds,
  type PeriodTrend,
  reportKeys,
  type Trends,
  useChaosColors
} from './report-api'

/**
 * Trends (#2859): are drills getting found faster and fixed faster? Median time to detect and to
 * recover per month or quarter, a calendar of the days drills ran, each dependency's verdicts
 * month by month, and the claims nothing has proven yet. The recovery strip on top is the same
 * feed `GET /api/chaos/trends` serves for an RPO / RTO panel (#2802).
 */

const RANGES = [6, 12, 24] as const
type Grain = 'month' | 'quarter'

export function TrendsTab() {
  const [months, setMonths] = useState<number>(12)
  const [grain, setGrain] = useState<Grain>('month')
  const { data, isLoading, isError } = useQuery<Trends>({
    queryKey: reportKeys.trends(months),
    queryFn: () => fetchTrends(months),
    refetchInterval: (q) => ((q.state.data?.pending ?? 0) > 0 ? 15_000 : false)
  })

  return (
    <div className='flex-1 overflow-y-auto px-4 py-5 sm:p-6'>
      <div className='mb-4 flex flex-wrap items-end justify-between gap-3'>
        <div className='min-w-0'>
          <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>Trends</h2>
          <p className='mt-0.5 max-w-[75ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            How fast drills get noticed and how fast things come back, over time.
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Segmented
            label='Group by'
            value={grain}
            options={[
              ['month', 'Month'],
              ['quarter', 'Quarter']
            ]}
            onChange={(v) => setGrain(v as Grain)}
          />
          <Segmented
            label='Range'
            value={String(months)}
            options={RANGES.map((n) => [String(n), `${n} months`] as [string, string])}
            onChange={(v) => setMonths(Number(v))}
          />
        </div>
      </div>

      {isLoading ? (
        <div className='space-y-4'>
          <Skeleton className='h-16 w-full' />
          <div className='grid gap-4 xl:grid-cols-2'>
            <Skeleton className='h-60' />
            <Skeleton className='h-60' />
          </div>
          <Skeleton className='h-36 w-full' />
        </div>
      ) : isError || !data ? (
        <p className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
          The trends did not load. Reload the page to try again.
        </p>
      ) : (
        <TrendsBody data={data} grain={grain} months={months} />
      )}
    </div>
  )
}

function Segmented({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: Array<[string, string]>
  onChange: (v: string) => void
}) {
  return (
    <fieldset className='inline-flex rounded-md border border-slate-200 bg-white p-0.5 dark:border-border dark:bg-card'>
      <legend className='sr-only'>{label}</legend>
      {options.map(([v, text]) => (
        <button
          key={v}
          type='button'
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'h-7 rounded px-2.5 text-[12px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
            value === v
              ? 'bg-accent text-slate-900 dark:text-foreground'
              : 'text-slate-500 hover:bg-muted hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
          )}
        >
          {text}
        </button>
      ))}
    </fieldset>
  )
}

function TrendsBody({ data, grain, months }: { data: Trends; grain: Grain; months: number }) {
  const periods = grain === 'month' ? data.months : data.quarters
  const total = data.months.reduce((a, m) => a + m.runs, 0)
  const r = data.recovery
  return (
    <div className='space-y-6'>
      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 xl:grid-cols-5 dark:border-border dark:bg-border'>
        <Stat label={`Drills, last ${r.window_days} days`} value={String(r.runs)} />
        <Stat label='Median time to detect' value={fmtSeconds(r.ttd_median_s)} />
        <Stat label='Median time to recover' value={fmtSeconds(r.ttr_median_s)} />
        <Stat label='Slowest 10% recover in' value={fmtSeconds(r.ttr_p90_s)} />
        <Stat
          label='Did not recover while watched'
          value={String(r.not_recovered)}
          warn={r.not_recovered > 0}
        />
      </div>
      {data.pending > 0 && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Timings for {data.pending} older run{data.pending === 1 ? '' : 's'} are still being worked
          out; this page refreshes by itself.
        </p>
      )}

      {total === 0 ? (
        <p className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
          No drill finished in the last {months} months. Run one from the Faults or Matrix tab; its
          timings land here once it ends.
        </p>
      ) : (
        <div className='grid gap-4 xl:grid-cols-2'>
          <TimingChart
            title='Time to detect'
            hint='Median from arming the fault to the first alert or "noticed" note'
            periods={periods}
            pick={(p) => [p.ttd_median_s, p.ttd_n]}
          />
          <TimingChart
            title='Time to recover'
            hint='Median from the end of the fault until every limit was back in its normal range'
            periods={periods}
            pick={(p) => [p.ttr_median_s, p.ttr_n]}
          />
        </div>
      )}

      <Calendar days={data.days} />
      <DependencyVerdicts deps={data.dependencies} />
      <NeverProven list={data.never_proven} />
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className='min-w-0 bg-white px-3 py-2.5 dark:bg-card'>
      <div className='truncate text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 text-[17px] font-semibold tabular-nums',
          warn ? 'text-amber-800 dark:text-amber-300' : 'text-slate-900 dark:text-foreground'
        )}
      >
        {value}
      </div>
    </div>
  )
}

const periodLabel = (p: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(p)
  if (!m) return p.replace('-', ' ')
  return new Date(Number(m[1]), Number(m[2]) - 1, 15).toLocaleDateString([], {
    month: 'short',
    year: '2-digit'
  })
}

function TimingChart({
  title,
  hint,
  periods,
  pick
}: {
  title: string
  hint: string
  periods: PeriodTrend[]
  pick: (p: PeriodTrend) => [number | null, number]
}) {
  const colors = useChaosColors()
  const rows = periods.map((p) => {
    const [v, n] = pick(p)
    return { period: periodLabel(p.period), v, n, runs: p.runs }
  })
  const measured = rows.filter((r) => r.v != null)
  const ticks = timeTicks(Math.max(0, ...measured.map((r) => r.v as number)))
  const label = `${title} by period: ${measured.map((r) => `${r.period} ${fmtSeconds(r.v)}`).join(', ') || 'no timings yet'}`
  return (
    <section className='min-w-0 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>{title}</h3>
      <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
      {measured.length === 0 ? (
        <p className='py-12 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
          No run in this range recorded the moments this needs.
        </p>
      ) : (
        <div
          role='img'
          aria-label={label}
          className='mt-3 h-48 text-slate-500 dark:text-muted-foreground'
        >
          <ResponsiveContainer width='100%' height='100%'>
            <BarChart data={rows} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke='currentColor' strokeOpacity={0.1} />
              <XAxis
                dataKey='period'
                tick={CHART_TICK}
                tickLine={false}
                axisLine={{ stroke: 'currentColor', strokeOpacity: 0.2 }}
                interval='preserveStartEnd'
              />
              <YAxis
                tick={CHART_TICK}
                tickLine={false}
                axisLine={false}
                width={44}
                ticks={ticks}
                domain={[0, ticks[ticks.length - 1]]}
                tickFormatter={(v) => axisTime(Number(v))}
              />
              <Tooltip
                cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
                contentStyle={CHART_TOOLTIP}
                formatter={(v, _n, item) => [
                  v == null
                    ? 'not measured'
                    : `${fmtSeconds(Number(v))} median of ${(item?.payload as { n: number }).n} run${(item?.payload as { n: number }).n === 1 ? '' : 's'}`,
                  title
                ]}
              />
              <Bar
                dataKey='v'
                fill={colors.line}
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  )
}

/** Round time steps (seconds) so the axis reads 0, 30s, 1m, 1m 30s… instead of 65s, 130s. */
const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400]
function timeTicks(max: number): number[] {
  const step = STEPS.find((st) => max / st <= 4) ?? Math.ceil(max / 4 / 3600) * 3600
  const out: number[] = []
  for (let v = 0; v < max + step; v += step) out.push(v)
  return out.length > 1 ? out : [0, step]
}
const axisTime = (s: number) =>
  s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`
      : `${Math.round((s / 3600) * 10) / 10}h`

// ─── Calendar heatmap ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000
const etDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d)

/** Cyan steps, light to dark: one hue, magnitude only. */
const HEAT = [
  'bg-slate-100 dark:bg-muted/60',
  'bg-nvr-cyan/25',
  'bg-nvr-cyan/50',
  'bg-nvr-cyan/75',
  'bg-nvr-cyan'
]
const heatStep = (n: number) => (n <= 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4)

function Calendar({ days }: { days: Trends['days'] }) {
  const weeks = useMemo(() => {
    const by = new Map(days.map((d) => [d.date, d]))
    const today = new Date()
    // 53 columns ending with this week; each column runs Sunday → Saturday.
    const end = new Date(today.getTime() + (6 - today.getDay()) * DAY_MS)
    const cols: Array<Array<{ date: string; runs: number; broke: number; future: boolean }>> = []
    for (let w = 52; w >= 0; w--) {
      const col = []
      for (let d = 6; d >= 0; d--) {
        const at = new Date(end.getTime() - (w * 7 + d) * DAY_MS)
        const date = etDay(at)
        const hit = by.get(date)
        col.push({ date, runs: hit?.runs ?? 0, broke: hit?.broke ?? 0, future: at > today })
      }
      cols.push(col)
    }
    return cols
  }, [days])
  const total = weeks.flat().reduce((a, c) => a + c.runs, 0)
  const fmt = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  return (
    <section className='min-w-0 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Drills run
        </h3>
        <span className='text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
          {total} in the last year · Eastern dates
        </span>
      </div>
      <div className='mt-3 overflow-x-auto pb-1'>
        <div
          role='img'
          aria-label={`Calendar of drills run: ${total} drills over the last year`}
          className='inline-grid grid-flow-col gap-[3px]'
          style={{ gridTemplateRows: 'repeat(7, 11px)' }}
        >
          {weeks.flat().map((c) => (
            <span
              key={c.date}
              data-tip={
                c.future
                  ? undefined
                  : `${fmt(c.date)}: ${c.runs ? `${c.runs} drill${c.runs === 1 ? '' : 's'}${c.broke ? `, ${c.broke} did not hold` : ''}` : 'no drills'}`
              }
              className={cn(
                'h-[11px] w-[11px] rounded-[2px]',
                c.future ? 'bg-transparent' : HEAT[heatStep(c.runs)],
                c.broke > 0 && 'ring-1 ring-inset ring-red-500/70'
              )}
            />
          ))}
        </div>
      </div>
      <div className='mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
        <span className='flex items-center gap-1'>
          Fewer
          {HEAT.map((cls) => (
            <span key={cls} className={cn('h-[11px] w-[11px] rounded-[2px]', cls)} />
          ))}
          More
        </span>
        <span className='flex items-center gap-1.5'>
          <span className='h-[11px] w-[11px] rounded-[2px] ring-1 ring-inset ring-red-500/70' />A
          drill that day did not hold
        </span>
      </div>
    </section>
  )
}

// ─── Verdicts per dependency ──────────────────────────────────────────────────

/** Two states, validated for colour-vision deficiency in both themes (blue held, red did not). */
const HELD_CLS = 'bg-sky-600 dark:bg-[#3b9fd1]'
const FAILED_CLS = 'bg-red-600 dark:bg-[#e5484d]'

function DependencyVerdicts({ deps }: { deps: Trends['dependencies'] }) {
  const periods = deps[0]?.months.map((m) => m.period) ?? []
  const any = deps.some((d) => d.months.some((m) => m.held + m.broke + m.aborted > 0))
  return (
    <section className='min-w-0 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Verdicts by dependency
        </h3>
        <div className='flex flex-wrap items-center gap-x-3 text-[11px] text-slate-500 dark:text-muted-foreground'>
          <span className='flex items-center gap-1.5'>
            <span className={cn('h-2 w-3 rounded-sm', HELD_CLS)} />
            Held
          </span>
          <span className='flex items-center gap-1.5'>
            <span className={cn('h-2 w-3 rounded-sm', FAILED_CLS)} />
            Broke or aborted
          </span>
        </div>
      </div>
      {!any ? (
        <p className='mt-3 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          No drill in this range touched a dependency yet.
        </p>
      ) : (
        <div className='mt-3 overflow-x-auto'>
          <table className='w-full min-w-[560px] border-separate border-spacing-x-[3px] border-spacing-y-1 text-[12px]'>
            <thead>
              <tr>
                <th className='w-[120px]' />
                {periods.map((p) => (
                  <th
                    key={p}
                    scope='col'
                    className='px-0.5 text-left text-[10.5px] font-medium text-slate-500 dark:text-muted-foreground'
                  >
                    {periodLabel(p)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {deps.map((d) => (
                <tr key={d.dependency}>
                  <th
                    scope='row'
                    className='pr-2 text-left font-medium text-slate-800 dark:text-foreground'
                  >
                    {d.label}
                  </th>
                  {d.months.map((m) => {
                    const failed = m.broke + m.aborted
                    const n = m.held + failed
                    const tip = n
                      ? `${d.label}, ${periodLabel(m.period)}: ${m.held} held, ${m.broke} broke, ${m.aborted} aborted`
                      : `${d.label}, ${periodLabel(m.period)}: no drills`
                    return (
                      <td key={m.period} className='p-0'>
                        <div
                          data-tip={tip}
                          className='flex h-4 min-w-[22px] gap-[2px] overflow-hidden rounded-[3px] bg-slate-100 dark:bg-muted/60'
                        >
                          <span className='sr-only'>{tip}</span>
                          {m.held > 0 && (
                            <span style={{ flexGrow: m.held }} className={cn('h-full', HELD_CLS)} />
                          )}
                          {failed > 0 && (
                            <span
                              style={{ flexGrow: failed }}
                              className={cn('h-full', FAILED_CLS)}
                            />
                          )}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function NeverProven({ list }: { list: Trends['never_proven'] }) {
  return (
    <section className='min-w-0'>
      <h3 className='mb-2 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
        Claims never proven
      </h3>
      {list.length === 0 ? (
        <p className='rounded-lg border border-slate-200 bg-white px-3 py-4 text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
          Every claim has been proven by at least one drill.
        </p>
      ) : (
        <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
          {list.map((c) => (
            <li
              key={c.key}
              className='flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2'
            >
              <div className='min-w-0 flex-1 basis-72'>
                <p className='text-[12.5px] text-slate-900 dark:text-foreground'>{c.statement}</p>
                <p className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                  {c.key}
                </p>
              </div>
              <span className='shrink-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                {c.provable ? 'A drill can prove it' : 'No fault for it here yet'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
