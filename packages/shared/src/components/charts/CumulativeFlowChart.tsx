import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'
import { RechartsGate } from './RechartsGate'

/**
 * #2758 — cumulative flow diagram: records in each pipeline state at the end of
 * every day, stacked into bands. A widening band is work piling up in that
 * state; the vertical gap between the top of the stack and the done bands is
 * work in progress, and its width over throughput is the lead time.
 *
 * Reads GET /pipelines/:id/cumulative-flow (computed as the viewer). The same
 * chart renders the dashboard widget type `cumulative_flow` from the flow
 * object the widget data endpoint returns.
 */

export interface CumulativeFlowState {
  id: string
  key: string
  label: string
  color: string | null
  sort: number
  is_terminal: boolean
}
export interface CumulativeFlowData {
  template: string
  collection: string | null
  from: string
  to: string
  states: CumulativeFlowState[]
  days: Array<{ day: string; counts: Record<string, number>; total: number }>
  summary: {
    arrivals: number
    done: number
    avg_wip: number
    lead_time_days: number | null
  }
  source: 'live' | 'rollup'
}

// Dark mode swaps every band for a desaturated hue: saturated fills on
// charcoal read as foreign, and none of them is teal (the brand accent).
const LIGHT_RAMP = ['#6366f1', '#0ea5e9', '#8b5cf6', '#f59e0b', '#ec4899', '#64748b', '#f97316']
const DARK_RAMP = ['#8fa6c9', '#9a93c4', '#c4a78a', '#b58f9a', '#a3a8b8', '#c9b27f', '#8fb0a3']
const DONE_LIGHT = '#15803d'
const DONE_DARK = '#9fbf8a'

function useIsDark(): boolean {
  const read = () =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const [dark, setDark] = useState(read)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const obs = new MutationObserver(() => setDark(read()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

export function bandColor(state: CumulativeFlowState, index: number, dark: boolean): string {
  if (state.is_terminal) return dark ? DONE_DARK : DONE_LIGHT
  if (dark) return DARK_RAMP[index % DARK_RAMP.length]
  return state.color && /^#[0-9a-f]{3,8}$/i.test(state.color)
    ? state.color
    : LIGHT_RAMP[index % LIGHT_RAMP.length]
}

export function CumulativeFlowChart({
  flow,
  height = 260,
  compact = false
}: {
  flow: CumulativeFlowData
  height?: number
  /** Widget size: no legend, no axis labels beyond the dates. */
  compact?: boolean
}) {
  const dark = useIsDark()
  // Stack bottom-up: done at the base, earliest state at the top, so the
  // widest-moving band (work waiting) rides the top edge.
  const ordered = useMemo(
    () =>
      [...flow.states].sort((a, b) =>
        a.is_terminal === b.is_terminal ? b.sort - a.sort : a.is_terminal ? -1 : 1
      ),
    [flow.states]
  )
  const rows = useMemo(() => flow.days.map((d) => ({ day: d.day, ...d.counts })), [flow.days])
  if (flow.days.length === 0 || flow.days.every((d) => d.total === 0))
    return (
      <p
        className='py-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'
        style={{ minHeight: height / 2 }}
      >
        No records moved through this pipeline in the range.
      </p>
    )
  const axis = dark ? '#94a3b8' : '#64748b'
  return (
    <div data-nvr-cfd>
      <div style={{ height }} role='img' aria-label='Cumulative flow diagram'>
        <RechartsGate fallback={<Skeleton className='h-full w-full' aria-busy='true' />}>
          {(r) => (
            <r.ResponsiveContainer width='100%' height='100%'>
              <r.AreaChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                <r.CartesianGrid
                  strokeDasharray='3 3'
                  stroke={dark ? '#334155' : '#e2e8f0'}
                  vertical={false}
                />
                <r.XAxis
                  dataKey='day'
                  tick={{ fontSize: 10, fill: axis }}
                  tickFormatter={(v: string) => v.slice(5)}
                  minTickGap={28}
                  stroke={axis}
                />
                <r.YAxis
                  tick={{ fontSize: 10, fill: axis }}
                  tickFormatter={(v: number) => COMPACT.format(v)}
                  width={40}
                  stroke={axis}
                />
                <r.Tooltip
                  contentStyle={{
                    fontSize: 11,
                    borderRadius: 6,
                    background: dark ? '#0f172a' : '#ffffff',
                    border: `1px solid ${dark ? '#334155' : '#e2e8f0'}`
                  }}
                  itemSorter={(item) => -(item.value as number)}
                />
                {ordered.map((s) => {
                  const color = bandColor(s, flow.states.indexOf(s), dark)
                  return (
                    <r.Area
                      key={s.id}
                      type='monotone'
                      dataKey={s.id}
                      name={s.label}
                      stackId='cfd'
                      stroke={color}
                      fill={color}
                      fillOpacity={dark ? 0.55 : 0.6}
                      isAnimationActive={false}
                    />
                  )
                })}
              </r.AreaChart>
            </r.ResponsiveContainer>
          )}
        </RechartsGate>
      </div>
      {!compact && (
        <ul className='mt-2 flex flex-wrap gap-x-4 gap-y-1'>
          {[...flow.states]
            .sort((a, b) => a.sort - b.sort)
            .map((s) => (
              <li
                key={s.id}
                className='flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-muted-foreground'
              >
                <span
                  className='h-2 w-2 rounded-sm'
                  style={{ background: bandColor(s, flow.states.indexOf(s), dark) }}
                />
                {s.label}
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}

const RANGES = [30, 90, 365] as const
const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

/** Pipeline page section: the chart with a range switch and the lead-time figures. */
export function PipelineCumulativeFlowCard({ templateId }: { templateId: string }) {
  const client = useNivaroClient()
  const [days, setDays] = useState<(typeof RANGES)[number]>(90)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['pipeline-cumulative-flow', templateId, days],
    queryFn: () =>
      client
        .request<{ data: CumulativeFlowData }>(
          get(`/pipelines/${templateId}/cumulative-flow`, { days })
        )
        .then((r) => r.data),
    staleTime: 60_000,
    retry: false
  })
  const s = data?.summary
  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-border dark:bg-card'>
      <div className='flex items-start justify-between gap-3'>
        <div>
          <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            Cumulative flow
          </h2>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Records in each state at the end of every day, for the records you can see. A widening
            band is work piling up there.
          </p>
        </div>
        <div className='flex shrink-0 items-center rounded-lg border border-slate-200 p-0.5 dark:border-border'>
          {RANGES.map((d) => (
            <button
              key={d}
              type='button'
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              aria-label={`Last ${d} days`}
              className={cn(
                'h-6 rounded-md px-2 text-[11px] font-medium',
                days === d
                  ? 'bg-slate-900 text-white dark:bg-nvr-cyan dark:text-[#172940]'
                  : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>
      <div className='mt-3'>
        {isLoading && <Skeleton className='h-[260px] w-full' aria-busy='true' />}
        {isError && (
          <p className='py-6 text-center text-[12px] text-amber-700 dark:text-amber-400'>
            Could not load the diagram.
          </p>
        )}
        {data && <CumulativeFlowChart flow={data} />}
      </div>
      {s && (
        <dl className='mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border sm:grid-cols-4'>
          {[
            ['Arrived', s.arrivals],
            ['Finished', s.done],
            ['Average in progress', s.avg_wip],
            ['Lead time', s.lead_time_days == null ? '—' : `${s.lead_time_days} days`]
          ].map(([label, value]) => (
            <div key={String(label)} className='bg-white px-3 py-2 dark:bg-card'>
              <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</dt>
              <dd className='text-[15px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                {typeof value === 'number' ? value.toLocaleString() : value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {data?.source === 'rollup' && (
        <p className='mt-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
          Long range read from last night's rollup.
        </p>
      )}
    </div>
  )
}
