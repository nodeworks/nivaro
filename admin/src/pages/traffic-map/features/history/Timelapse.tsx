/**
 * #2183 — time-lapse playback of the last 24 hours or 7 days (from the minute store when it is on
 * and reaches back far enough, else hourly aggregates of the request log), 30 days from the
 * long-history store and 90 days / 13 months from its hourly rollups (#2544), with deploys,
 * restarts, configuration writes, maintenance windows and incidents marked as it plays. Pause on
 * any step to open it: its busiest nodes (click one to inspect it on the map), what changed near
 * it, and — inside the map's own rewind ring — "Rewind the map here".
 * #2249 — people online (concurrency samples) and people active (signed-in callers) under the
 * request curve, so more people and more work per person read apart.
 */
import { useQuery } from '@tanstack/react-query'
import { Pause, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../../context'
import { fmtCount, fmtMs } from '../../EventTicker'
import { requestMapRewind } from '../../RewindBar'
import type { Selection } from '../../types'
import { BTN, errorOf, Note } from '../shared'
import { type CurveMarker, HistoryCurve, Swatch } from './HistoryCurve'
import {
  fmtMoment,
  type HistoryRange,
  historyStore,
  nodeKeyLabel,
  RING_MS,
  type StoreStatusBody,
  type TimelapseBody,
  useHistoryState
} from './shared'

const SPEEDS = [60, 300, 900, 3600]
const SOURCE_TEXT: Record<TimelapseBody['source'], string> = {
  minutes: 'From the minute history.',
  log: 'From the request log, grouped by route family (turn on minute history for callers and partners).',
  store: 'From the long-history store, which keeps the request log past its 14 days.',
  rollups: 'From hourly summaries. p95 is estimated, and people shows each step’s busiest hour.',
  stack: 'From the long history, kept 13 months. p95 is estimated.',
  unavailable: 'The request log can only be grouped this way on SQL Server.'
}
const RANGE_LABEL: Record<HistoryRange, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '13mo': '13 months'
}
/** Ranges past the request log's 14 days: offered only with the long-history store. */
const STORE_RANGES: HistoryRange[] = ['30d', '90d', '13mo']

/** Whether the long-history store is set up (the 30-day and longer ranges need it). */
export function useStoreStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['traffic-map', 'history', 'store'],
    queryFn: async () =>
      ((await api.get('/traffic-map/history/store'))?.data?.data ?? null) as StoreStatusBody | null,
    enabled,
    staleTime: 5 * 60_000
  })
}

export function useTimelapse(range: HistoryRange, enabled: boolean) {
  return useQuery({
    queryKey: ['traffic-map', 'history', 'timelapse', range],
    queryFn: async () =>
      ((await api.get('/traffic-map/history/timelapse', { params: { range } }))?.data?.data ??
        null) as TimelapseBody | null,
    enabled,
    staleTime: 5 * 60_000
  })
}

export function curveTicks(from: number, stepS: number, n: number, range: HistoryRange) {
  const out: Array<{ i: number; label: string }> = []
  const tickS: Record<HistoryRange, number> = {
    '24h': 3 * 3600,
    '7d': 86_400,
    '30d': 3 * 86_400,
    '90d': 14 * 86_400,
    '13mo': 30 * 86_400
  }
  const every = Math.round(tickS[range] / stepS)
  for (let i = 0; i < n; i += Math.max(1, every)) {
    const t = from + i * stepS * 1000
    out.push({
      i,
      label:
        range === '24h'
          ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
          : range === '13mo'
            ? new Date(t).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
            : range === '90d'
              ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              : new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
    })
  }
  return out
}

/** "5 min", "hour", "6 h", "day", "3 days" — what one step of the curve covers. */
export function stepLabel(stepS: number): string {
  if (stepS < 3600) return `${Math.round(stepS / 60)} min`
  if (stepS === 3600) return 'hour'
  if (stepS < 86_400) return `${Math.round(stepS / 3600)} h`
  if (stepS === 86_400) return 'day'
  return `${Math.round(stepS / 86_400)} days`
}

export function markerIndexes(
  markers: TimelapseBody['markers'],
  from: number,
  stepS: number
): CurveMarker[] {
  const at = (ms: number) => (ms - from) / (stepS * 1000)
  return markers.map((m) => ({
    i: at(m.at),
    i2: m.until != null ? at(m.until) : undefined,
    kind: m.kind,
    label: `${fmtMoment(m.at)} · ${m.label}`
  }))
}

export function Timelapse() {
  const { catalog, model, setSelection } = useTrafficMap()
  const st = useHistoryState()
  const range = st.range
  const q = useTimelapse(range, st.tab === 'timelapse')
  const store = useStoreStatus(st.tab === 'timelapse')
  const ranges: HistoryRange[] =
    store.data?.configured || STORE_RANGES.includes(range)
      ? ['24h', '7d', ...STORE_RANGES]
      : ['24h', '7d']
  const data = q.data ?? null
  const n = data?.frames.length ?? 0
  const [idx, setIdx] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(60)
  const [note, setNote] = useState<string | null>(null)
  // A link asked for a moment past 7 days but long history is not set up: show 7 days instead.
  const [fellBack, setFellBack] = useState(false)
  useEffect(() => {
    if (store.data && !store.data.configured && STORE_RANGES.includes(range)) {
      historyStore.set({ range: '7d', at: null })
      setFellBack(true)
    }
  }, [store.data, range])

  // A link / search answer asked for a moment: seek there, paused.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seek only when asked (or data lands)
  useEffect(() => {
    if (!data || st.at == null) return
    const i = Math.floor((st.at - data.from) / (data.step_s * 1000))
    setIdx(Math.max(0, Math.min(data.frames.length - 1, i)))
    setPlaying(false)
  }, [st.seek, data])

  useEffect(() => {
    if (!playing || !data) return
    const ms = Math.max(50, (data.step_s * 1000) / speed)
    const t = setInterval(() => {
      setIdx((cur) => {
        const next = (cur ?? -1) + 1
        if (next >= data.frames.length) {
          setPlaying(false)
          return data.frames.length - 1
        }
        return next
      })
    }, ms)
    return () => clearInterval(t)
  }, [playing, speed, data])

  const scale = useMemo(() => {
    let max = 1
    for (const f of data?.frames ?? []) for (const c of f.nodes) if (c[1] > max) max = c[1]
    return max
  }, [data])

  const cur = idx ?? (n ? n - 1 : 0)
  const frame = data?.frames[cur]
  const stepMs = (data?.step_s ?? 300) * 1000
  const values = useMemo(() => (data?.frames ?? []).map((f) => f.req), [data])
  const errs = useMemo(() => (data?.frames ?? []).map((f) => f.err), [data])
  const markers = useMemo(
    () => (data ? markerIndexes(data.markers, data.from, data.step_s) : []),
    [data]
  )
  const near = frame
    ? (data?.markers ?? []).filter((m) => m.at >= frame.t - stepMs && m.at < frame.t + 2 * stepMs)
    : []
  const rows = frame
    ? frame.nodes
        .slice()
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([i, req, err, p95]) => ({ key: data?.nodes[i]?.key ?? '', req, err, p95 }))
        .filter((r) => r.key)
    : []

  const pausedAt = (i: number) => {
    setPlaying(false)
    setIdx(i)
    setNote(null)
    if (data) historyStore.set({ at: data.from + i * stepMs })
  }

  return (
    <div className='grid gap-3 p-3.5' data-tm-timelapse=''>
      <div className='flex flex-wrap items-center gap-2'>
        <fieldset className='m-0 inline-flex min-w-0 max-w-full overflow-x-auto rounded-md border border-[var(--tm-line)] p-0'>
          <legend className='sr-only'>Range</legend>
          {ranges.map((r) => (
            <button
              key={r}
              type='button'
              aria-pressed={range === r}
              onClick={() => {
                historyStore.set({ range: r, at: null })
                setFellBack(false)
                setIdx(null)
                setPlaying(false)
              }}
              className={cn(
                'shrink-0 whitespace-nowrap px-2.5 py-[3px] text-[12px] font-medium first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                range === r
                  ? 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
                  : 'text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
              )}
              data-tm-history-range={r}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </fieldset>
        <button
          type='button'
          id='tm-history-play'
          className={BTN}
          disabled={!n}
          onClick={() => {
            if (playing) {
              pausedAt(cur)
              return
            }
            setNote(null)
            if (idx == null || idx >= n - 1) setIdx(0)
            setPlaying(true)
          }}
        >
          {playing ? (
            <Pause className='h-3.5 w-3.5' aria-hidden='true' />
          ) : (
            <Play className='h-3.5 w-3.5' aria-hidden='true' />
          )}
          {playing ? 'Pause' : 'Play'}
        </button>
        <SimpleSelect
          value={String(speed)}
          onChange={(v) => setSpeed(Number(v))}
          options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
          ariaLabel='Playback speed'
          triggerProps={{ id: 'tm-history-speed' }}
          className='h-7 w-auto min-w-[72px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px]'
        />
        <span
          className='text-[12px] tabular-nums text-[var(--tm-fg)]'
          data-tm-history-at={frame?.t ?? ''}
        >
          {frame ? fmtMoment(frame.t) : '—'}
        </span>
        {data && (
          <span className='text-[11.5px] text-[var(--tm-muted)]'>
            {SOURCE_TEXT[data.source]}
            {data.data_from != null && data.data_from > data.from && (
              <span data-tm-history-data-from={data.data_from}>
                {' '}
                Data from{' '}
                {new Date(data.data_from).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric'
                })}
                .
              </span>
            )}
          </span>
        )}
      </div>
      {fellBack && range === '7d' && (
        <Note>Long history isn’t set up, so this shows the last 7 days.</Note>
      )}
      {data?.note && <Note>{data.note}</Note>}

      {q.isLoading ? (
        <div
          className='h-[150px] animate-pulse rounded-md bg-[var(--tm-skeleton)]'
          role='status'
          aria-label='Loading'
        />
      ) : q.isError ? (
        <Note tone='error'>{errorOf(q.error)}</Note>
      ) : !data || !n ? (
        <Note>Nothing to play yet.</Note>
      ) : (
        <>
          <HistoryCurve
            label='Moment to show'
            values={values}
            errors={errs}
            line={data.people.sampled ? data.people.online : undefined}
            line2={data.people.active}
            markers={markers}
            playhead={cur}
            onPick={pausedAt}
            ticks={curveTicks(data.from, data.step_s, n, range)}
            legend={
              <>
                <Swatch color='var(--tm-accent)'>Requests per {stepLabel(data.step_s)}</Swatch>
                <Swatch color='var(--tm-error)'>Errors</Swatch>
                {data.people.sampled && (
                  <Swatch color='var(--tm-fg-2)' dashed>
                    People online
                  </Swatch>
                )}
                <Swatch color='var(--tm-read)'>People making requests</Swatch>
                <span>Dots mark deploys, restarts, config writes, maintenance and incidents.</span>
              </>
            }
          />
          {frame && (
            <div className='grid gap-3 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,280px)]'>
              <div className='min-w-0'>
                <div className='mb-1 flex items-baseline justify-between gap-2 text-[12px]'>
                  <span className='font-medium'>Busiest nodes in this step</span>
                  <span className='tabular-nums text-[var(--tm-muted)]'>
                    {fmtCount(frame.req)} requests ·{' '}
                    {frame.req
                      ? `${((100 * frame.err) / frame.req).toFixed(1)}% errors`
                      : 'no errors'}
                  </span>
                </div>
                {rows.length === 0 ? (
                  <Note>Nothing ran in this step.</Note>
                ) : (
                  <ul className='grid gap-0.5' data-tm-timelapse-nodes=''>
                    {rows.map((r) => {
                      const lab = nodeKeyLabel(r.key, catalog, model)
                      return (
                        <li key={r.key}>
                          <button
                            type='button'
                            className='grid w-full min-w-0 grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1 py-0.5 text-left text-[12px] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                            data-tip={`Inspect ${lab.label} on the map (its 1 h / 6 h / 24 h history)`}
                            onClick={() =>
                              setSelection({ kind: lab.kind, id: lab.id } as Selection)
                            }
                            data-tm-timelapse-node={r.key}
                          >
                            <span className='truncate'>{lab.label}</span>
                            <span className='relative h-2 overflow-hidden rounded-sm bg-[var(--tm-card-2)]'>
                              <span
                                className='absolute inset-y-0 left-0 bg-[var(--tm-accent)]'
                                style={{ width: `${(100 * r.req) / scale}%` }}
                              />
                              <span
                                className='absolute inset-y-0 left-0 bg-[var(--tm-error)]'
                                style={{ width: `${(100 * r.err) / scale}%` }}
                              />
                            </span>
                            <span className='tabular-nums text-[var(--tm-muted)]'>
                              {fmtCount(r.req)} · p95 {fmtMs(r.p95)}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
              <div className='min-w-0 text-[12px]'>
                <div className='mb-1 font-medium'>This moment</div>
                <p className='text-[var(--tm-fg-2)]'>
                  {data.people.online[cur] != null ? `${data.people.online[cur]} online · ` : ''}
                  {data.people.active[cur] ?? 0} people making requests
                </p>
                {near.length > 0 ? (
                  <ul className='mt-1 grid gap-0.5 text-[11.5px]' data-tm-timelapse-near=''>
                    {near.slice(0, 5).map((m) => (
                      <li key={`${m.kind}${m.at}`} className='text-[var(--tm-fg-2)]'>
                        <span className='tabular-nums text-[var(--tm-muted)]'>
                          {fmtMoment(m.at, false)}
                        </span>{' '}
                        {m.label}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>
                    No deploy, restart, config write or incident near here.
                  </p>
                )}
                {Date.now() - frame.t <= RING_MS && (
                  <button
                    type='button'
                    className={cn(BTN, 'mt-2')}
                    id='tm-history-rewind'
                    onClick={() => {
                      const r = requestMapRewind(frame.t + stepMs - 1000)
                      setNote(r === 'unavailable' ? 'The map cannot rewind to this second.' : null)
                    }}
                  >
                    Rewind the map here
                  </button>
                )}
                {note && <Note>{note}</Note>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
