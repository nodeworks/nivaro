/**
 * #2137 — Hour × weekday heatmap: for the selected entity, caller or partner, requests (or
 * errors, or p95) by hour of day and day of week over the last four weeks of hourly roll-ups, in
 * the viewer's time zone — when it is busy and when it is quiet. Opens on request (one read).
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import { fmtMs } from '../../EventTicker'
import type { InspectorData } from '../../Inspector'
import { Section } from '../../Inspector'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import { BTN, ReadEmpty, Segmented } from '../shared'
import { fmtNum } from './ui'

type HeatMetric = 'req' | 'errors' | 'p95'
interface Heatmap {
  cells: Array<Array<number | null>>
  max: number
  hours_known: number
  hours_wanted: number
  tz: string
}
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const METRICS: Array<{ v: HeatMetric; label: string }> = [
  { v: 'req', label: 'Requests' },
  { v: 'errors', label: 'Errors' },
  { v: 'p95', label: 'p95' }
]

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Cell text for the tip (pure). */
export function heatTip(day: number, hour: number, v: number | null, metric: HeatMetric): string {
  const when = `${DAYS[day]} ${String(hour).padStart(2, '0')}:00`
  if (v == null) return `${when} · no history yet`
  if (metric === 'p95') return `${when} · p95 ${fmtMs(v)}`
  return `${when} · ${fmtNum(v)} ${metric === 'req' ? 'requests' : 'errors'} an hour on average`
}

function Grid({ data, metric }: { data: Heatmap; metric: HeatMetric }) {
  const color =
    metric === 'errors'
      ? 'var(--tm-error)'
      : metric === 'p95'
        ? 'var(--tm-update)'
        : 'var(--tm-accent)'
  return (
    <div className='grid gap-[2px]' role='img' aria-label='Busy hours by weekday' id='tm-heatmap'>
      {data.cells.map((row, d) => (
        <div
          key={DAYS[d]}
          className='grid grid-cols-[28px_repeat(24,minmax(0,1fr))] items-center gap-[2px]'
        >
          <span className='text-[10.5px] text-[var(--tm-muted)]'>{DAYS[d]}</span>
          {row.map((v, h) => {
            const share = v == null || data.max <= 0 ? 0 : Math.max(0.06, v / data.max)
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the 24 hours are fixed positions
                key={h}
                data-tip={heatTip(d, h, v, metric)}
                data-tm-heat={v ?? ''}
                className='block h-3 rounded-[2px]'
                style={{
                  background:
                    v == null
                      ? 'var(--tm-card-2)'
                      : v === 0
                        ? 'var(--tm-line-2)'
                        : `color-mix(in srgb, ${color} ${Math.round(share * 90)}%, var(--tm-card))`
                }}
              />
            )
          })}
        </div>
      ))}
      <div className='grid grid-cols-[28px_repeat(24,minmax(0,1fr))] text-[10px] text-[var(--tm-muted)]'>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed hour axis
          <span key={h} className='text-center'>
            {h % 6 === 0 ? h : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

function idOf(sel: Selection): { kind: string; id: string } | null {
  if (sel.kind === 'entity' && !sel.id.includes('/__')) return { kind: 'entity', id: sel.id }
  if (sel.kind === 'caller' && /^(k\d+|u[0-9A-F-]{36}|anon|cron)$/.test(sel.id))
    return { kind: 'caller', id: sel.id }
  if (sel.kind === 'down' && sel.id.startsWith('ext:')) return { kind: 'down', id: sel.id }
  return null
}

function HeatmapPanel({ sel }: { sel: Selection; d: InspectorData }) {
  const [open, setOpen] = useState(false)
  const [metric, setMetric] = useState<HeatMetric>('req')
  const node = idOf(sel)
  const q = useQuery({
    queryKey: ['traffic-map', 'heatmap', node?.kind, node?.id, metric],
    queryFn: async () => {
      const res = await api.get('/traffic-map/heatmap', {
        params: { kind: node?.kind, id: node?.id, metric, tz: tz() }
      })
      return (res.data as { data: Heatmap }).data
    },
    enabled: open && !!node,
    staleTime: 10 * 60_000
  })
  if (!node) return null
  return (
    <Section title='Busy hours, last four weeks'>
      {!open ? (
        <button type='button' className={BTN} id='tm-heatmap-open' onClick={() => setOpen(true)}>
          Show when it is busy
        </button>
      ) : (
        <div className='grid gap-2'>
          <Segmented
            label='Heatmap figure'
            value={metric}
            options={METRICS.map((m): [HeatMetric, string] => [m.v, m.label])}
            onChange={setMetric}
          />
          {q.isLoading ? (
            <div
              aria-hidden='true'
              className='h-24 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
            />
          ) : q.isError || !q.data ? (
            <ReadEmpty error errorText='Could not read the hourly history.' />
          ) : (
            <>
              <Grid data={q.data} metric={metric} />
              <p className='text-[11.5px] text-[var(--tm-muted)]'>
                {q.data.hours_known >= q.data.hours_wanted
                  ? `Four weeks of hourly roll-ups, ${q.data.tz} time.`
                  : `${Math.round((100 * q.data.hours_known) / Math.max(1, q.data.hours_wanted))}% of the four weeks known so far (the request log keeps 14 days; older weeks fill in as hours are rolled up). ${q.data.tz} time.`}
              </p>
            </>
          )}
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'heatmap',
  order: 60,
  history: true,
  applies: (sel) => idOf(sel) != null,
  Component: HeatmapPanel
})
