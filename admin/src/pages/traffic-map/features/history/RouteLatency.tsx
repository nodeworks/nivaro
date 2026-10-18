/**
 * Inspector, per route of the selected node (from the request log):
 * #2193 — the distribution of request durations as a log histogram, its modes marked, so a route
 * split between fast and slow requests is visible where a single p95 hides it;
 * #2252 — which query parameters and filter values go with the slow requests (limit=5000, a
 * two-year date range, a filter on one field), ranked by how much of the slowness each explains.
 * Loads when opened.
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { fmtMs } from '../../EventTicker'
import { Empty, type InspectorData, Section } from '../../Inspector'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import { BTN, entityOf, errorOf, Note } from '../shared'

interface Dist {
  total: number
  bins: Array<{ lo: number; hi: number; n: number }>
  p50: number
  p95: number
  p99: number
  max: number
  modes: Array<{ lo: number; hi: number; n: number; share: number; median: number }>
  bimodal: boolean
  hours: number
  truncated: boolean
}
interface SlowParams {
  total: number
  slow: number
  threshold_ms: number
  with_query: number
  features: Array<{
    feature: string
    label: string
    n: number
    slow: number
    slow_share: number
    lift: number
    explains: number
    median_with: number
    median_without: number
  }>
  hours: number
  truncated: boolean
}
const HOURS = [
  { value: '1', label: '1 h' },
  { value: '6', label: '6 h' },
  { value: '24', label: '24 h' },
  { value: '168', label: '7 days' }
]

function useRouteRead<T>(
  path: string,
  key: string | null,
  route: string,
  hours: string,
  on: boolean
) {
  return useQuery({
    queryKey: ['traffic-map', 'history', path, key, route, hours],
    queryFn: async () =>
      ((await api.get(`/traffic-map/history/${path}`, { params: { key, route, hours } }))?.data
        ?.data ?? null) as T | null,
    enabled: on && !!key && !!route,
    staleTime: 60_000
  })
}

export function Histogram({ d }: { d: Dist }) {
  const max = Math.max(1, ...d.bins.map((b) => b.n))
  const inMode = (b: { lo: number; hi: number }) =>
    d.modes.findIndex((m) => b.lo >= m.lo && b.hi <= m.hi + 1e-6)
  return (
    <div data-tm-latency-hist=''>
      <div className='flex h-[64px] items-end gap-px' aria-hidden='true'>
        {d.bins.map((b) => {
          const mi = inMode(b)
          return (
            <span
              key={b.lo}
              className='min-w-[3px] flex-1 rounded-t-[2px]'
              style={{
                height: `${Math.max(b.n ? 4 : 0, (100 * b.n) / max)}%`,
                background:
                  d.bimodal && mi === d.modes.length - 1 ? 'var(--tm-update)' : 'var(--tm-accent)'
              }}
              data-tip={`${fmtMs(b.lo) === '—' ? '0 ms' : fmtMs(b.lo)}–${fmtMs(b.hi)}: ${b.n.toLocaleString()} requests`}
            />
          )
        })}
      </div>
      <div className='mt-0.5 flex justify-between text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
        <span>{fmtMs(d.bins[0]?.hi ?? 0)}</span>
        <span>{fmtMs(d.bins[d.bins.length - 1]?.hi ?? 0)}</span>
      </div>
      <p className='mt-1 text-[11.5px] text-[var(--tm-fg-2)]'>
        {d.total.toLocaleString()} requests · p50 {fmtMs(d.p50)} · p95 {fmtMs(d.p95)} · p99{' '}
        {fmtMs(d.p99)}
      </p>
      {d.bimodal ? (
        <p
          className='mt-0.5 text-[11.5px] font-medium text-[var(--tm-update)]'
          data-tm-latency-bimodal=''
        >
          Two groups:{' '}
          {d.modes.map((m) => `${Math.round(m.share * 100)}% around ${fmtMs(m.median)}`).join(', ')}
          . The p95 describes the slow group only.
        </p>
      ) : d.total >= 20 ? (
        <p className='mt-0.5 text-[11.5px] text-[var(--tm-muted)]'>One group of durations.</p>
      ) : null}
    </div>
  )
}

function RouteLatencyPanel({ sel, d }: { sel: Selection; d: InspectorData }) {
  const e = entityOf(sel)
  const routes = d.routes.slice(0, 12)
  const [route, setRoute] = useState(routes[0]?.route ?? '')
  const [hours, setHours] = useState('24')
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!routes.some((r) => r.route === route) && routes[0]) setRoute(routes[0].route)
  }, [routes, route])
  const dist = useRouteRead<Dist>('route-latency', e?.key ?? null, route, hours, open)
  const slow = useRouteRead<SlowParams>('slow-params', e?.key ?? null, route, hours, open)
  if (!e) return null
  return (
    <Section title='Durations by route'>
      {routes.length === 0 ? (
        <Empty>No routes seen on this node in the window.</Empty>
      ) : !open ? (
        <div className='flex flex-wrap items-center gap-2'>
          <button
            type='button'
            className={BTN}
            onClick={() => setOpen(true)}
            id='tm-route-latency-open'
          >
            Show durations and slow parameters
          </button>
          <span className='text-[11.5px] text-[var(--tm-muted)]'>
            Reads the request log for one route.
          </span>
        </div>
      ) : (
        <div className='grid gap-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <SimpleSelect
              value={route}
              onChange={setRoute}
              options={routes.map((r) => ({ value: r.route, label: r.route }))}
              ariaLabel='Route'
              triggerProps={{ id: 'tm-route-latency-route' }}
              className='h-7 w-auto min-w-0 max-w-full border-[var(--tm-line)] bg-[var(--tm-card)] px-2 font-mono text-[11px]'
            />
            <SimpleSelect
              value={hours}
              onChange={setHours}
              options={HOURS}
              ariaLabel='Over'
              triggerProps={{ id: 'tm-route-latency-hours' }}
              className='h-7 w-auto min-w-[76px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px]'
            />
          </div>
          {dist.isLoading ? (
            <div
              className='h-[80px] animate-pulse rounded-md bg-[var(--tm-skeleton)]'
              role='status'
              aria-label='Loading'
            />
          ) : dist.isError ? (
            <Note tone='error'>{errorOf(dist.error)}</Note>
          ) : !dist.data || dist.data.total === 0 ? (
            <Empty>No logged requests on this route in that range.</Empty>
          ) : (
            <Histogram d={dist.data} />
          )}
          {dist.data?.truncated && (
            <Note>
              Only the newest 20,000 requests were read; pick a shorter range for the whole picture.
            </Note>
          )}
          <div>
            <div className='mb-0.5 text-[12px] font-medium'>
              What the slow requests have in common
            </div>
            {slow.isLoading ? (
              <Empty>Comparing slow and fast requests…</Empty>
            ) : slow.isError ? (
              <Note tone='error'>{errorOf(slow.error)}</Note>
            ) : !slow.data || slow.data.total < 20 ? (
              <Empty>Too few requests to compare (20 or more needed).</Empty>
            ) : slow.data.features.length === 0 ? (
              <Empty>
                No parameter stands out: slow requests (over {fmtMs(slow.data.threshold_ms)}) carry
                the same parameters as fast ones
                {slow.data.with_query === 0
                  ? ' (and none of these requests had a query string)'
                  : ''}
                .
              </Empty>
            ) : (
              <ul className='grid gap-1 text-[12px]' data-tm-slow-params=''>
                {slow.data.features.map((f) => (
                  <li key={f.feature} className='grid gap-0.5' data-tm-slow-param={f.feature}>
                    <span className='flex flex-wrap items-baseline justify-between gap-x-2'>
                      <span className='font-medium'>{f.label}</span>
                      <span className='tabular-nums text-[var(--tm-fg-2)]'>
                        explains {Math.round(f.explains * 100)}% of the slow requests
                      </span>
                    </span>
                    <span className='text-[11.5px] tabular-nums text-[var(--tm-muted)]'>
                      {Math.round(f.slow_share * 100)}% slow with it ({f.n.toLocaleString()}{' '}
                      requests), {f.lift}× the rest · median {fmtMs(f.median_with)} against{' '}
                      {fmtMs(f.median_without)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {slow.data && slow.data.total >= 20 && (
              <p className='mt-1 text-[11px] text-[var(--tm-muted)]'>
                Slow = {fmtMs(slow.data.threshold_ms)} or more (the route&apos;s p90).
              </p>
            )}
          </div>
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'history-route-latency',
  order: 60,
  applies: (sel) => sel.kind === 'entity' && sel.id.includes('/'),
  live: true,
  history: true,
  Component: RouteLatencyPanel
})
