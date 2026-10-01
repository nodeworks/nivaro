import { useQuery } from '@tanstack/react-query'
import { Waypoints } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { adminRealtime, getSocket, joinWatchRoom } from '@/lib/socket'
import { cn } from '@/lib/utils'
import { callerLabel, EventTicker, KIND_VAR } from './EventTicker'
import { HotEntities } from './HotEntities'
import {
  describeSelection,
  type Hours,
  historyAvailable,
  historyUrl,
  hoursPhrase,
  Inspector,
  InspectorPlaceholder
} from './Inspector'
import { MapCanvas } from './MapCanvas'
import { defaultFilters, laneOf, TrafficModel } from './model'
import { type StripData, SummaryStrip } from './SummaryStrip'
import type {
  DownHistory,
  EntityHistory,
  Filters,
  Kind,
  Lane,
  Selection,
  TrafficCatalog,
  TrafficFrame,
  TrafficSnapshot
} from './types'
import { KIND_ORDER, LANE_LABEL, LANE_ORDER } from './types'

/**
 * Traffic Map (spec: docs/superpowers/specs/2026-09-30-traffic-map-design.md §10).
 * Per-node live view: the snapshot seeds a client ring, one frame per second keeps it current,
 * and a snapshot refetch on reconnect, tab return, resume or window change REPLACES the ring so
 * nothing double counts.
 */

/** Lane `other` is never drawn or offered as a chip, but always counted in totals (R24). */
const CHIP_LANES: Lane[] = LANE_ORDER.filter((l) => l !== 'other')
const CHIP_LABEL: Partial<Record<Lane, string>> = {
  items: 'Collections',
  queries: 'Queries'
}
const WINDOWS = [
  [60, '1m'],
  [300, '5m'],
  [900, '15m']
] as const
/** No frame for this long while live = the socket dropped (frames arrive every second). */
const STALE_MS = 6000

const CHIP =
  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)] disabled:cursor-not-allowed disabled:opacity-60'
const CHIP_ON =
  'border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
const CHIP_OFF =
  'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
const FLABEL = 'mr-0.5 text-[12px] font-medium text-[var(--tm-muted)]'

function errorText(e: unknown): string {
  const r = e as { response?: { data?: { error?: string } }; message?: string }
  return r?.response?.data?.error ?? r?.message ?? 'Unknown error'
}

export default function TrafficMap() {
  const modelRef = useRef(new TrafficModel())
  const [filters, setFilters] = useState<Filters>(() => defaultFilters())
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const [catalog, setCatalog] = useState<TrafficCatalog | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  /** Inspector range: 0 = live (the ring); 1/6/24 h read the request log. Kept across selections. */
  const [hours, setHours] = useState<Hours>(0)
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  const [tick, setTick] = useState(0)
  const [ready, setReady] = useState(false)
  const [snapError, setSnapError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [users, setUsers] = useState(0)
  const peak = useRef(0)
  const eventsSeen = useRef(0)
  const snapSeq = useRef(0)
  const lastSnapAt = useRef(0)

  const loadSnapshot = useCallback(async (win: number) => {
    const id = ++snapSeq.current
    lastSnapAt.current = Date.now()
    try {
      const res = await api.get(`/traffic-map/snapshot?window=${win}`)
      if (id !== snapSeq.current) return // a newer request (window change) superseded this one
      const snap = res.data.data as TrafficSnapshot
      const m = modelRef.current
      m.applySnapshot(snap)
      lastSnapAt.current = Date.now()
      peak.current = Math.max(peak.current, snap.sockets.count)
      setUsers(snap.sockets.users)
      setSelection((cur) => {
        if (cur) return cur
        const types = filtersRef.current.types
        const busiest = snap.entities.find((e) => types.has(e.lane)) ?? snap.entities[0]
        return busiest ? { kind: 'entity', id: busiest.key } : null
      })
      setSnapError(null)
      setStale(false)
      setReady(true)
      setTick((t) => t + 1)
    } catch (e) {
      if (id !== snapSeq.current) return
      setSnapError(errorText(e))
    }
  }, [])

  useEffect(() => {
    void loadSnapshot(filters.win)
  }, [filters.win, loadSnapshot])

  useEffect(() => {
    let alive = true
    api
      .get('/traffic-map/catalog')
      .then((r) => {
        if (alive) setCatalog(r.data.data as TrafficCatalog)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const leave = joinWatchRoom('traffic-map')
    const off = adminRealtime.on('traffic-map:frame', (p: unknown) => {
      if (pausedRef.current || document.hidden) return
      const m = modelRef.current
      const f = p as TrafficFrame
      const gap = m.lastFrameAt > 0 && Date.now() - m.lastFrameAt > STALE_MS
      const before = m.lastFrameAt
      const beforeNo = m.frameNo
      m.applyFrame(f)
      if (m.lastFrameAt !== before || m.frameNo !== beforeNo) {
        eventsSeen.current += f.events.length + (f.events_dropped ?? 0)
        peak.current = Math.max(peak.current, f.sockets)
      }
      setStale(false)
      setTick((t) => t + 1)
      // frames resumed after a hole (a reconnect the local socket did not see): re-seed
      if (gap && Date.now() - lastSnapAt.current > STALE_MS)
        void loadSnapshot(filtersRef.current.win)
    })
    // R23: a socket reconnect re-seeds from the snapshot (frames were lost while away)
    const socket = getSocket()
    let firstAuth = socket.connected
    const onAuth = () => {
      if (!firstAuth) {
        firstAuth = true // the initial connect: the mount already asked for a snapshot
        return
      }
      void loadSnapshot(filtersRef.current.win)
    }
    socket.on('auth:ok', onAuth)
    const onVis = () => {
      if (!document.hidden && !pausedRef.current) void loadSnapshot(filtersRef.current.win)
    }
    document.addEventListener('visibilitychange', onVis)
    const watchdog = setInterval(() => {
      if (pausedRef.current || document.hidden || !lastSnapAt.current) return
      const last = Math.max(modelRef.current.lastFrameAt, lastSnapAt.current)
      setStale(Date.now() - last > STALE_MS)
    }, 2000)
    return () => {
      off()
      leave()
      socket.off('auth:ok', onAuth)
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(watchdog)
    }
  }, [loadSnapshot])

  const togglePause = () => {
    const next = !pausedRef.current
    pausedRef.current = next // set here so a frame arriving before the re-render is dropped
    setPaused(next)
    // frames were dropped while paused: resuming re-seeds so the hole is filled
    if (!next) void loadSnapshot(filtersRef.current.win)
  }
  const toggleType = (l: Lane) =>
    setFilters((f) => {
      const types = new Set(f.types)
      if (types.has(l)) {
        if (types.size === 1) return f
        types.delete(l)
      } else types.add(l)
      return { ...f, types }
    })
  const toggleKind = (k: Kind) =>
    setFilters((f) => {
      const kinds = new Set(f.kinds)
      if (kinds.has(k)) {
        if (kinds.size === 1) return f
        kinds.delete(k)
      } else kinds.add(k)
      return { ...f, kinds }
    })

  const m = modelRef.current
  const win = filters.win
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read of the mutable model
  const view = useMemo(() => {
    if (!ready) return null
    const totals = m.totals(win, filters)
    const last60 = m.totals(60, filters)
    const counted = (lane: Lane) => lane === 'other' || filters.types.has(lane)
    const series = new Array<number>(60).fill(0)
    for (const k of m.entityKeys()) {
      if (!counted(laneOf(k))) continue
      const s = m.entitySeries(k, win, 60)
      for (let i = 0; i < 60; i++) series[i] += s[i] ?? 0
    }
    const visibleEvents = m.visibleEvents(filters)
    // Newest error code, counted the way the error total is: visible lanes plus `other` (R24).
    let lastError: string | null = null
    if (filters.kinds.has('error')) {
      const evErr = m.events.find(
        (e) =>
          e.kind === 'error' && counted(e.lane) && (!filters.caller || e.caller === filters.caller)
      )
      if (evErr) lastError = evErr.code ?? (evErr.status ? String(evErr.status) : null)
      else {
        let newest = ''
        for (const k of m.entityKeys()) {
          if (!counted(laneOf(k))) continue
          const e = m
            .entityMeta(k)
            ?.recent_errors.find((x) => !filters.caller || x.caller === filters.caller)
          if (e && e.at > newest) {
            newest = e.at
            lastError = e.code ?? String(e.status)
          }
        }
      }
    }
    const partners: string[] = []
    for (const id of m.downIds()) {
      if (!id.startsWith('ext:') || m.downSum(id, win)[0] <= 0) continue
      partners.push(catalog?.partners[id.slice(4)] ?? m.downLabels.get(id) ?? id)
    }
    const strip: StripData = {
      rps: totals.req / win,
      series,
      p95: totals.p95,
      p50: totals.p50,
      req: totals.req,
      errN: totals.error,
      lastError,
      writesPerMin: last60.create + last60.update + last60.delete,
      writesMix: { create: last60.create, update: last60.update, delete: last60.delete },
      outboundPerMin: (totals.outbound_req * 60) / win,
      outboundErr: totals.outbound_error,
      partners,
      sockets: m.sockets,
      users,
      peak: Math.max(peak.current, m.sockets)
    }
    return { strip, hot: m.hot(win, filters, 12), events: visibleEvents }
  }, [m, ready, win, filters, catalog, users, tick])

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read of the mutable model
  const inspector = useMemo(
    () => (ready && selection ? describeSelection(m, selection, filters, catalog) : null),
    [m, ready, selection, filters, catalog, tick]
  )
  const canHistory = historyAvailable(selection)
  const historyQ = useQuery({
    queryKey: ['traffic-map', 'history', selection?.kind, selection?.id, hours],
    queryFn: async () => {
      const res = await api.get(historyUrl(selection as Selection, hours))
      return res.data.data as EntityHistory | DownHistory
    },
    enabled: canHistory && hours > 0,
    staleTime: 60_000
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read of the mutable model
  const callerOptions = useMemo(() => {
    const keys = new Set(m.callerKeys())
    if (filters.caller) keys.add(filters.caller)
    const opts = [...keys]
      .map((k) => ({ value: k, label: callerLabel(catalog, k) }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return [{ value: '', label: 'All callers' }, ...opts]
  }, [m, catalog, filters.caller, tick])

  const live = ready && !stale && !snapError
  const statusLabel = !ready
    ? 'Loading'
    : paused
      ? 'Paused'
      : stale
        ? 'Reconnecting'
        : snapError
          ? 'Snapshot failed'
          : 'Live'

  return (
    <div className='traffic-map flex min-h-0 flex-1 flex-col text-[13px]'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-start justify-between gap-x-6 gap-y-2'>
          <div className='flex min-w-0 items-start gap-2.5'>
            <Waypoints
              className='mt-0.5 h-5 w-5 shrink-0 text-muted-foreground'
              aria-hidden='true'
            />
            <div className='min-w-0'>
              <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
                Traffic Map
              </h1>
              <p className='mt-0.5 max-w-[78ch] text-[12.5px] text-[var(--tm-muted)]'>
                Live requests, writes and errors across collections, widgets, pages, queries and
                partners, as seen by this API node. Select any node for its traffic, routes, callers
                and recent errors.
              </p>
            </div>
          </div>
          <div
            className='flex items-center gap-1.5 whitespace-nowrap pt-1 text-[11.5px] text-[var(--tm-muted)]'
            id='tm-node'
          >
            <span
              className={cn(
                'inline-block h-[7px] w-[7px] rounded-full',
                live && !paused
                  ? 'bg-[var(--tm-create)]'
                  : stale || paused
                    ? 'bg-[var(--tm-update)]'
                    : 'bg-[var(--tm-muted)]'
              )}
              aria-hidden='true'
            />
            <span className='sr-only'>{statusLabel}: </span>
            <span>
              api · <span data-testid='tm-instance'>{m.instance || '…'}</span> · journal seq{' '}
              <span className='font-mono tabular-nums'>
                {m.journalSeq != null ? m.journalSeq.toLocaleString() : '—'}
              </span>
            </span>
          </div>
        </div>
        <div
          className='mt-3 flex flex-wrap items-center gap-x-4 gap-y-2'
          role='toolbar'
          aria-label='Filters'
        >
          <fieldset className='flex min-w-0 flex-wrap items-center gap-1' aria-label='Entity types'>
            <span className={FLABEL}>Show</span>
            {CHIP_LANES.map((l) => {
              const on = filters.types.has(l)
              return (
                <button
                  key={l}
                  type='button'
                  id={`tm-type-${l}`}
                  aria-pressed={on}
                  disabled={on && filters.types.size === 1}
                  onClick={() => toggleType(l)}
                  className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
                >
                  {CHIP_LABEL[l] ?? LANE_LABEL[l]}
                </button>
              )
            })}
          </fieldset>
          <fieldset
            className='flex min-w-0 flex-wrap items-center gap-1'
            aria-label='Request kinds'
          >
            <span className={FLABEL}>Kinds</span>
            {KIND_ORDER.map((k) => {
              const on = filters.kinds.has(k)
              return (
                <button
                  key={k}
                  type='button'
                  id={`tm-kind-${k}`}
                  aria-pressed={on}
                  disabled={on && filters.kinds.size === 1}
                  onClick={() => toggleKind(k)}
                  className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
                >
                  <span
                    className='h-2 w-2 rounded-sm'
                    style={{ background: KIND_VAR[k], opacity: on ? 1 : 0.35 }}
                    aria-hidden='true'
                  />
                  {k}
                </button>
              )
            })}
          </fieldset>
          <div className='flex items-center gap-1.5'>
            <label htmlFor='tm-caller' className={FLABEL}>
              Caller
            </label>
            <SimpleSelect
              value={filters.caller}
              onChange={(v) => setFilters((f) => ({ ...f, caller: v }))}
              options={callerOptions}
              triggerProps={{ id: 'tm-caller' }}
              className='h-7 min-w-[170px] max-w-[240px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 text-[12px] text-[var(--tm-fg-2)]'
            />
          </div>
          <div className='flex items-center gap-1.5'>
            <span className={FLABEL} id='tm-window-label'>
              Window
            </span>
            <fieldset
              className='inline-flex min-w-0 overflow-hidden rounded-md border border-[var(--tm-line)]'
              aria-labelledby='tm-window-label'
            >
              {WINDOWS.map(([w, label], i) => {
                const on = filters.win === w
                return (
                  <button
                    key={w}
                    type='button'
                    id={`tm-win-${w}`}
                    aria-pressed={on}
                    onClick={() => setFilters((f) => ({ ...f, win: w }))}
                    className={cn(
                      'px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                      i > 0 && 'border-l border-[var(--tm-line)]',
                      on
                        ? 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
                        : 'bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
                    )}
                  >
                    {label}
                  </button>
                )
              })}
            </fieldset>
          </div>
          <button
            type='button'
            id='tm-pause'
            aria-pressed={paused}
            onClick={togglePause}
            className={cn(
              CHIP,
              'ml-auto',
              paused
                ? 'border-[var(--tm-update)] bg-[var(--tm-update)] text-[var(--tm-on-update)]'
                : CHIP_OFF
            )}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      <div className='flex-1 overflow-auto bg-[var(--tm-bg)] p-6 text-[var(--tm-fg)]'>
        {snapError && (
          <div
            role='alert'
            id='tm-snapshot-error'
            className='mb-3.5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--tm-error)] bg-[var(--tm-error-soft)] px-3.5 py-2 text-[12.5px]'
          >
            <span>
              {ready
                ? 'The latest snapshot could not be loaded; the map shows the last one.'
                : 'The traffic snapshot could not be loaded.'}{' '}
              <span className='font-mono text-[11.5px] text-[var(--tm-fg-2)]'>{snapError}</span>
            </span>
            <button
              type='button'
              id='tm-snapshot-retry'
              className={cn(CHIP, CHIP_OFF)}
              onClick={() => void loadSnapshot(filtersRef.current.win)}
            >
              Retry
            </button>
          </div>
        )}
        <SummaryStrip d={view?.strip ?? null} />
        <div className='mt-3.5 grid items-start gap-3.5 min-[1100px]:grid-cols-[minmax(0,1fr)_360px]'>
          <MapCanvas
            model={m}
            filters={filters}
            selection={selection}
            onSelect={setSelection}
            catalog={catalog}
            tick={tick}
            paused={paused}
            stale={stale && !paused}
          />
          <p className='sr-only' aria-live='polite' id='tm-inspector-announce'>
            {inspector
              ? `Inspecting ${inspector.name}${canHistory && hours > 0 ? `, ${hoursPhrase(hours)}` : ''}`
              : ''}
          </p>
          {inspector && selection ? (
            <Inspector
              d={inspector}
              catalog={catalog}
              selKey={selection.id}
              history={{
                hours,
                onHours: setHours,
                available: canHistory,
                data: historyQ.data ?? null,
                // a Retry after a failure shows the skeleton while it runs (isError holds until it lands)
                state: historyQ.isFetching ? 'loading' : historyQ.isError ? 'error' : 'idle',
                error: historyQ.error ? errorText(historyQ.error) : null,
                onRetry: () => void historyQ.refetch()
              }}
            />
          ) : (
            <InspectorPlaceholder loading={!ready} />
          )}
        </div>
        <div className='mt-3.5 grid items-start gap-3.5 min-[1100px]:grid-cols-2'>
          <EventTicker
            events={view?.events ?? []}
            newestT={m.events[0]?.t ?? 0}
            win={win}
            catalog={catalog}
            total={eventsSeen.current}
            loading={!ready}
          />
          <HotEntities
            rows={view?.hot ?? []}
            catalog={catalog}
            selectedKey={selection?.kind === 'entity' ? selection.id : null}
            onSelect={(key) => setSelection({ kind: 'entity', id: key })}
            loading={!ready}
          />
        </div>
      </div>
    </div>
  )
}
