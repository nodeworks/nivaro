import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import type { OpsKpiMeta, OpsTrendPoint } from '../../lib/ops-report-types'
import { OPS_KPI_META } from '../../lib/ops-report-types'
import { cn } from '../../lib/utils'
import { RechartsGate } from '../charts/RechartsGate'
import { QueryErrorState } from '../QueryErrorState'
import { Skeleton } from '../ui/skeleton'
import { formatKpi, kpiMeta, NO_VERDICT_DOT, shortDay, VERDICT } from './format'
import { Pick } from './ui'

const GROUPS: Array<{ key: OpsKpiMeta['group']; title: string }> = [
  { key: 'people', title: 'People' },
  { key: 'traffic', title: 'Traffic and deploys' },
  { key: 'speed', title: 'Speed' },
  { key: 'errors', title: 'Errors and bugs' },
  { key: 'integrations', title: 'Partners and mail' },
  { key: 'work', title: 'Work' },
  { key: 'security', title: 'Security' },
  { key: 'business', title: 'Business' }
]

const RANGES = [
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' }
]

function Spark({
  points,
  k,
  onPick
}: {
  points: OpsTrendPoint[]
  k: string
  onPick: (p: OpsTrendPoint) => void
}) {
  const meta = kpiMeta(k)
  const data = points.map((p) => ({ i: p.id, day: shortDay(p.day), v: p.kpis?.[k] ?? null }))
  return (
    <RechartsGate fallback={<Skeleton className='h-12 w-full' aria-busy='true' />}>
      {({ Line, LineChart, ResponsiveContainer, Tooltip, YAxis }) => (
        <ResponsiveContainer width='100%' height='100%'>
          <LineChart
            data={data}
            margin={{ top: 4, right: 4, left: 4, bottom: 2 }}
            onClick={(s: { activeTooltipIndex?: number | string | null }) => {
              const idx = Number(s?.activeTooltipIndex)
              const p = Number.isInteger(idx) ? points[idx] : undefined
              if (p) onPick(p)
            }}
          >
            <YAxis hide domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{
                fontSize: 11,
                padding: '4px 8px',
                backgroundColor: '#0f172a',
                border: '1px solid #334155',
                borderRadius: 6,
                color: '#f1f5f9'
              }}
              labelStyle={{ color: '#f1f5f9' }}
              itemStyle={{ color: '#e2e8f0' }}
              labelFormatter={(_l, items) => (items?.[0]?.payload as { day?: string })?.day ?? ''}
              formatter={(v) => [formatKpi(v as number, meta.unit), '']}
            />
            <Line
              type='monotone'
              dataKey='v'
              stroke='#4f7cac'
              strokeWidth={1.75}
              dot={false}
              activeDot={{ r: 3 }}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </RechartsGate>
  )
}

export function TrendsTab({ onOpenDay }: { onOpenDay: (id: number) => void }) {
  const client = useNivaroClient()
  const [days, setDays] = useState('30')
  const q = useQuery({
    queryKey: ['ops-trends', days],
    queryFn: () =>
      client
        .request<{ data: OpsTrendPoint[] }>(get('/ops-reports/trends', { days: Number(days) }))
        .then((r) => r.data)
  })
  const points = useMemo(() => q.data ?? [], [q.data])
  const groups = useMemo(() => {
    const keys = new Set<string>()
    for (const p of points)
      for (const [k, v] of Object.entries(p.kpis ?? {})) if (v != null) keys.add(k)
    const known = new Set(OPS_KPI_META.map((m) => m.key))
    const byGroup = new Map<OpsKpiMeta['group'], string[]>()
    const add = (g: OpsKpiMeta['group'], k: string) =>
      byGroup.set(g, [...(byGroup.get(g) ?? []), k])
    for (const m of OPS_KPI_META)
      if (keys.has(m.key) && m.key !== 'health_score') add(m.group, m.key)
    for (const k of [...keys].filter((k) => !known.has(k) && k.includes('.')))
      add(kpiMeta(k).group, k)
    return GROUPS.map((g) => ({ ...g, keys: byGroup.get(g.key) ?? [] })).filter(
      (g) => g.keys.length
    )
  }, [points])

  return (
    <div
      className='min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 dark:bg-background'
      data-ops-trends=''
    >
      <div className='mx-auto max-w-[1200px] space-y-4'>
        <div className='flex items-center gap-3'>
          <Pick
            ariaLabel='Days to show'
            value={days}
            onChange={setDays}
            options={RANGES}
            className='w-[150px]'
          />
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            One line per day. Click a day or a point to open that report.
          </p>
        </div>

        {q.isLoading ? (
          <div className='space-y-3' aria-busy='true'>
            <Skeleton className='h-14 w-full' />
            <Skeleton className='h-40 w-full' />
          </div>
        ) : q.error ? (
          <QueryErrorState error={q.error} what='the trends' onRetry={() => void q.refetch()} />
        ) : points.length === 0 ? (
          <p className='py-10 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            No reports in this range yet.
          </p>
        ) : (
          <>
            <section className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
              <h3 className='mb-2 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
                How each day went
              </h3>
              <div className='flex flex-wrap gap-1' data-ops-verdict-strip=''>
                {points.map((p) => (
                  <button
                    key={p.id}
                    type='button'
                    onClick={() => onOpenDay(p.id)}
                    data-tip={`${shortDay(p.day)} · ${p.verdict ? VERDICT[p.verdict].label : 'no verdict'}${
                      p.score != null ? ` · ${p.score}` : ''
                    }`}
                    aria-label={`Open ${shortDay(p.day)}`}
                    className={cn(
                      'h-7 w-3.5 rounded-sm transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                      p.verdict ? VERDICT[p.verdict].dot : NO_VERDICT_DOT
                    )}
                  />
                ))}
              </div>
              <div className='mt-1.5 flex justify-between text-[10.5px] text-slate-500 dark:text-muted-foreground'>
                <span>{shortDay(points[0]?.day ?? '')}</span>
                <span>{shortDay(points[points.length - 1]?.day ?? '')}</span>
              </div>
            </section>

            {points.some((p) => p.kpis?.health_score != null) && (
              <section
                data-ops-trend-group='score'
                className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
              >
                <div className='flex items-baseline justify-between'>
                  <h3 className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
                    Health score
                  </h3>
                  <span className='text-[12px] font-semibold tabular-nums'>
                    {formatKpi(points[points.length - 1]?.kpis?.health_score, 'count')}
                  </span>
                </div>
                <div className='h-24' data-ops-trend='health_score'>
                  <Spark points={points} k='health_score' onPick={(p) => onOpenDay(p.id)} />
                </div>
              </section>
            )}

            {groups.map((g) => (
              <section
                key={g.key}
                data-ops-trend-group={g.key}
                className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
              >
                <h3 className='mb-2 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
                  {g.title}
                </h3>
                <div className='grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-x-4 gap-y-3'>
                  {g.keys.map((k) => {
                    const m = kpiMeta(k)
                    const last = points[points.length - 1]?.kpis?.[k]
                    return (
                      <div key={k} data-ops-trend={k}>
                        <div className='flex items-baseline justify-between gap-2'>
                          <span className='truncate text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                            {m.label}
                          </span>
                          <span className='text-[12px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                            {formatKpi(last, m.unit)}
                          </span>
                        </div>
                        <div className='h-12'>
                          <Spark points={points} k={k} onPick={(p) => onOpenDay(p.id)} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
