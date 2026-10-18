/**
 * #2148 — What changed, automatically. When an entity's errors or latency are above its normal
 * (#2145; without a normal yet: an error rate of 5%+ on 10+ requests), the inspector shows what
 * explains the rise: the server finds the minute it began and compares the 15 minutes before with
 * the minutes since — callers, routes, screens, response sizes and client builds ranked by their
 * share of the rise, plus deploys, restarts and config writes around that minute. No windows to
 * pick. This API process's traffic only.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../../context'
import { callerLabel, fmtMs } from '../../EventTicker'
import type { InspectorData } from '../../Inspector'
import { Empty, Section } from '../../Inspector'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import { judgeNode, type Level } from './score'
import { useBaselines } from './store'
import { entityLive, isEntity, ToneChip } from './ui'

type Dim = 'caller' | 'route' | 'screen' | 'build' | 'size'
interface Factor {
  dim: Dim
  value: string
  share: number
  contribution: number
  before: { n: number; bad: number }
  after: { n: number; bad: number }
  is_new: boolean
}
interface WhatChanged {
  key: string
  metric: 'errors' | 'latency'
  rose: boolean
  pivot_at: number | null
  before: { n: number; rate: number }
  after: { n: number; rate: number }
  delta: number
  factors: Factor[]
  markers: Array<{ kind: string; at: number; label: string; near: boolean }>
}

const DIM_LABEL: Record<Dim, string> = {
  caller: 'Caller',
  route: 'Route',
  screen: 'Screen',
  build: 'Client build',
  size: 'Response size'
}
const risen = (l: Level) => l === 'elevated' || l === 'high'

/** Which rise to explain right now, or null when nothing is above normal (pure). */
export function riseMetric(
  live: { req: number; errors: number; windowS: number; p95: number },
  bands: Parameters<typeof judgeNode>[1]
): 'errors' | 'latency' | null {
  const j = judgeNode(live, bands)
  if (risen(j.errors.level)) return 'errors'
  if (risen(j.p95.level)) return 'latency'
  if (!bands?.err_pct && live.req >= 10 && (100 * live.errors) / live.req >= 5) return 'errors'
  return null
}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

function WhatChangedPanel({ sel }: { sel: Selection; d: InspectorData }) {
  const { model, win, tick, catalog } = useTrafficMap()
  useBaselines()
  void tick
  const live = entityLive(model, sel.id, win)
  const metric = riseMetric(live, live.bands)
  const q = useQuery({
    queryKey: ['traffic-map', 'what-changed', sel.id, metric],
    queryFn: async () => {
      const res = await api.get('/traffic-map/what-changed', { params: { key: sel.id, metric } })
      return (res.data as { data: WhatChanged }).data
    },
    enabled: !!metric,
    staleTime: 20_000,
    refetchInterval: 30_000
  })
  if (!metric) return null
  const w = q.data
  const fmtRate = (v: number) => (metric === 'errors' ? `${v.toFixed(1)}%` : fmtMs(v))
  const valueText = (f: Factor) => (f.dim === 'caller' ? callerLabel(catalog, f.value) : f.value)
  const near = (w?.markers ?? []).filter((m) => m.near)
  return (
    <Section title='What changed'>
      <div className='grid gap-2 text-[12px]' id='tm-what-changed' data-tm-metric={metric}>
        {q.isLoading ? (
          <div
            aria-hidden='true'
            className='h-10 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
          />
        ) : q.isError ? (
          <Empty>Could not read what changed.</Empty>
        ) : !w?.rose ? (
          <Empty>
            {metric === 'errors' ? 'Errors are' : 'Latency is'} above normal, but no rise in the
            last 15 minutes stands out: it has been this way for a while.
          </Empty>
        ) : (
          <>
            <p className='text-[var(--tm-fg-2)]'>
              {metric === 'errors' ? 'Errors' : 'Mean latency'} rose from{' '}
              <span className='tabular-nums text-[var(--tm-fg)]'>{fmtRate(w.before.rate)}</span> to{' '}
              <span className='tabular-nums text-[var(--tm-fg)]'>{fmtRate(w.after.rate)}</span>
              {w.pivot_at ? ` at ${hhmm(w.pivot_at)}` : ''}. Against the 15 minutes before:
            </p>
            {near.map((m) => (
              <p
                key={`${m.kind}:${m.at}`}
                className='rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] px-2 py-1 text-[11.5px]'
                data-tm-change-marker={m.kind}
              >
                <span className='font-medium'>{hhmm(m.at)}</span> {m.label} — right before the rise
              </p>
            ))}
            {w.factors.length ? (
              <ul className='grid gap-1'>
                {w.factors.slice(0, 8).map((f) => {
                  const pct = Math.max(0, Math.min(100, Math.round(f.share * 100)))
                  return (
                    <li key={`${f.dim}:${f.value}`} className='grid gap-0.5' data-tm-factor={f.dim}>
                      <div className='grid grid-cols-[92px_minmax(0,1fr)_auto] items-baseline gap-2'>
                        <span className='text-[11.5px] text-[var(--tm-muted)]'>
                          {DIM_LABEL[f.dim]}
                        </span>
                        <span
                          className={cn(
                            'min-w-0 truncate',
                            f.dim === 'route' || f.dim === 'build' ? 'font-mono text-[11px]' : ''
                          )}
                          data-tip={valueText(f)}
                        >
                          {valueText(f)}
                        </span>
                        <span className='flex items-center gap-1 tabular-nums'>
                          {f.is_new && <ToneChip tone='warn'>new</ToneChip>}
                          {pct}%
                        </span>
                      </div>
                      <div className='h-1 rounded-full bg-[var(--tm-line-2)]'>
                        <div
                          className='h-1 rounded-full bg-[var(--tm-error)]'
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <Empty>No single caller, route, screen, size or build explains it.</Empty>
            )}
            <p className='text-[11.5px] text-[var(--tm-muted)]'>
              Share of the rise each one explains · {w.before.n} requests before, {w.after.n} since
              · this API process
            </p>
          </>
        )}
      </div>
    </Section>
  )
}

register(inspectorPanels, {
  id: 'what-changed',
  order: 4,
  applies: (sel) => isEntity(sel),
  Component: WhatChangedPanel
})
