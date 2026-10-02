import { useQuery } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  MoreHorizontal,
  Pause as PauseIcon,
  Play,
  Waypoints
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { adminRealtime, getSocket, joinWatchRoom } from '@/lib/socket'
import { cn } from '@/lib/utils'
import { TrafficMapContext, type TrafficMapContextValue } from './context'
import { callerLabel, EventTicker, KIND_VAR } from './EventTicker'
import { useStore } from './features/b1-shared'
import { nodeFeed } from './features/node-merge'
import { usePinFilter } from './features/pins'
import {
  FrozenBanner,
  type FrozenSnapshot,
  filtersFromJson,
  loadFrozenSnapshot,
  useFrozenSnapshotId
} from './features/snapshots'
import { workspaceFocus } from './features/workspaces'
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
import { InspectHost } from './inspect/InspectHost'
import { closeInspect } from './inspect/stack'
import { MapCanvas } from './MapCanvas'
import { defaultFilters, laneOf, TrafficModel } from './model'
// Feature registrations (registry/index.ts) run before the page renders.
import './registry'
import { RewindBar } from './RewindBar'
import { PagePanels } from './registry/pagePanels'
import { ToolbarItems, toolbarItemsIn } from './registry/toolbarItems'
import { viewParams } from './registry/viewParams'
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
import { CORE_PARAMS, decodeView, encodeView } from './viewUrl'

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
/** The server caches the catalog for 60 s, so refetching more often gains nothing. */
export const CATALOG_REFRESH_MS = 60_000
/** A frame naming a caller or partner the catalog cannot label asks again this soon. */
export const CATALOG_MISSING_REFRESH_MS = 5_000

/**
 * True when the catalog has no label for a caller key or partner (`ext:<id>`) the live data
 * names — e.g. a person who first called after the page loaded, or a new API key.
 */
export function catalogMissing(
  cat: TrafficCatalog | null,
  callerKeys: Iterable<string>,
  downIds: Iterable<string> = []
): boolean {
  if (!cat) return true
  for (const k of callerKeys) if (!cat.callers[k]) return true
  for (const id of downIds) {
    if (id.startsWith('ext:') && !cat.partners[id.slice(4)]) return true
  }
  return false
}

const CHIP =
  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)] disabled:cursor-not-allowed disabled:opacity-60'
const CHIP_ON =
  'border-[color-mix(in_srgb,var(--tm-accent)_55%,var(--tm-line))] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
const CHIP_OFF =
  'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
const SEG =
  'inline-flex items-center gap-1.5 px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan disabled:cursor-not-allowed'
const SEG_ON = 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
/** Kind toggles carry their own colour swatch, so "on" stays neutral (no accent wash on all five). */
const SEG_ON_NEUTRAL = 'bg-[var(--tm-card)] text-[var(--tm-fg)]'
const SEG_IDLE = 'bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
/** A hidden kind: struck through, so the filter reads as "left out", not "not chosen". */
const SEG_OFF =
  'bg-[var(--tm-card-2)] text-[var(--tm-muted)] line-through decoration-[var(--tm-muted)]/60 hover:text-[var(--tm-fg-2)]'

/** The ten lane toggles, folded into one menu: "All lanes" or "4 of 10 lanes". */
function LanesMenu({
  types,
  onToggle,
  onSet
}: {
  types: Set<Lane>
  onToggle: (l: Lane) => void
  onSet: (lanes: Lane[]) => void
}) {
  const shown = CHIP_LANES.filter((l) => types.has(l))
  const all = shown.length === CHIP_LANES.length
  const label = all
    ? 'All lanes'
    : shown.length === 1
      ? (CHIP_LABEL[shown[0]] ?? LANE_LABEL[shown[0]])
      : `${shown.length} of ${CHIP_LANES.length} lanes`
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-lanes'
          aria-label={`Lanes: ${label}`}
          className={cn(CHIP, all ? CHIP_OFF : CHIP_ON)}
        >
          {label}
          <ChevronDown className='h-3.5 w-3.5 opacity-70' aria-hidden='true' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='traffic-map w-[240px] p-1'>
        <fieldset className='grid text-[12.5px]' aria-label='Lanes'>
          {CHIP_LANES.map((l) => {
            const on = types.has(l)
            return (
              <div
                key={l}
                className='group flex items-center rounded-md hover:bg-[var(--tm-card-2)]'
              >
                <button
                  type='button'
                  id={`tm-type-${l}`}
                  aria-pressed={on}
                  disabled={on && types.size === 1}
                  onClick={() => onToggle(l)}
                  className='flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--tm-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan disabled:cursor-not-allowed'
                >
                  <span
                    className={cn(
                      'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                      on
                        ? 'border-[var(--tm-accent)] bg-[var(--tm-accent)] text-[var(--tm-card)]'
                        : 'border-[var(--tm-line)] bg-[var(--tm-card)]'
                    )}
                    aria-hidden='true'
                  >
                    {on ? <Check className='h-2.5 w-2.5' strokeWidth={3} /> : null}
                  </span>
                  <span className='truncate'>{CHIP_LABEL[l] ?? LANE_LABEL[l]}</span>
                </button>
                <button
                  type='button'
                  onClick={() => onSet([l])}
                  aria-label={`Show only ${CHIP_LABEL[l] ?? LANE_LABEL[l]}`}
                  className='mr-1 rounded px-1.5 py-0.5 text-[11.5px] text-[var(--tm-muted)] opacity-0 hover:text-[var(--tm-fg)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan group-hover:opacity-100'
                >
                  Only
                </button>
              </div>
            )
          })}
        </fieldset>
        <div className='mt-1 border-t border-[var(--tm-line-2)] px-1 pt-1'>
          <button
            type='button'
            disabled={all}
            onClick={() => onSet(CHIP_LANES)}
            className='w-full rounded-md px-2 py-1.5 text-left text-[12.5px] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan disabled:cursor-default disabled:opacity-50'
          >
            Show all lanes
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Set-once preferences (the daily summary) live here instead of on the toolbar. */
function MoreMenu() {
  if (toolbarItemsIn('menu').length === 0) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-more'
          aria-label='More'
          title='More'
          className={cn(CHIP, CHIP_OFF, 'px-1.5')}
        >
          <MoreHorizontal className='h-3.5 w-3.5' aria-hidden='true' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='traffic-map grid w-[230px] gap-1 p-1.5 [&_button]:w-full [&_button]:justify-start'
      >
        <ToolbarItems slot='menu' />
      </PopoverContent>
    </Popover>
  )
}

function errorText(e: unknown): string {
  const r = e as { response?: { data?: { error?: string } }; message?: string }
  return r?.response?.data?.error ?? r?.message ?? 'Unknown error'
}

/** #1166: the view a link opened with (read once per page mount). */
function initialView() {
  const empty = { filters: defaultFilters(), selection: null, at: null }
  if (typeof window === 'undefined') return empty
  try {
    return decodeView(new URLSearchParams(window.location.search), empty)
  } catch {
    return empty
  }
}

export default function TrafficMap() {
  const modelRef = useRef(new TrafficModel())
  const linked = useRef(initialView())
  const [filters, setFilters] = useState<Filters>(() => linked.current.filters)
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const [catalog, setCatalog] = useState<TrafficCatalog | null>(null)
  const [selection, setSelection] = useState<Selection | null>(() => linked.current.selection)
  /** #1100: the rewound second while paused (null = the newest). */
  const [viewSec, setViewSec] = useState<number | null>(null)
  // #1154: the workspace chip scopes the whole map
  const wsFocus = useStore(workspaceFocus)
  const pinFilter = usePinFilter()
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
  const catalogRef = useRef<TrafficCatalog | null>(null)
  const catalogAt = useRef(0)
  const catalogBusy = useRef(false)
  const alive = useRef(true)
  // #1097: `?snapshot=<id>` opens a stored view read-only (no socket, labels from the snapshot).
  const frozenId = useFrozenSnapshotId()
  const frozenRef = useRef(frozenId)
  frozenRef.current = frozenId
  const [frozen, setFrozen] = useState<FrozenSnapshot | null>(null)
  const frozenApplied = useRef<string | null>(null)

  /** Throttled to one request per `minGap` (default CATALOG_REFRESH_MS) unless `force` (the mount). */
  const refreshCatalog = useCallback((force = false, minGap = CATALOG_REFRESH_MS) => {
    if (catalogBusy.current || frozenRef.current) return
    if (!force && Date.now() - catalogAt.current < minGap) return
    catalogAt.current = Date.now()
    catalogBusy.current = true
    api
      .get('/traffic-map/catalog')
      .then((r) => {
        if (!alive.current) return
        const c = r.data.data as TrafficCatalog
        catalogRef.current = c
        setCatalog(c)
      })
      .catch(() => {})
      .finally(() => {
        catalogBusy.current = false
      })
  }, [])

  const loadSnapshot = useCallback(
    async (win: number) => {
      const id = ++snapSeq.current
      lastSnapAt.current = Date.now()
      try {
        const fid = frozenRef.current
        const fz = fid ? await loadFrozenSnapshot(fid) : null
        const res = fz ? null : await api.get(nodeFeed.snapshotUrl(win))
        if (id !== snapSeq.current) return // a newer request (window change) superseded this one
        const snap = (fz ? fz.snapshot : res?.data.data) as TrafficSnapshot
        const m = modelRef.current
        m.applySnapshot(snap)
        if (fz) {
          setFrozen(fz)
          if (fz.catalog) {
            catalogRef.current = fz.catalog
            setCatalog(fz.catalog)
          }
          // the stored selection + filters apply once per snapshot (a window change after is the reader's)
          if (frozenApplied.current !== fz.id) {
            frozenApplied.current = fz.id
            if (fz.selection) setSelection(fz.selection)
            if (fz.filters) setFilters((f) => filtersFromJson(f, fz.filters))
          }
        } else {
          setFrozen(null)
          nodeFeed.noteSnapshot(snap, (res?.data.nodes as unknown[] | undefined)?.length ?? 1)
        }
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
        // Labels for anything seen since the last catalog read (throttled; the server caches).
        refreshCatalog()
      } catch (e) {
        if (id !== snapSeq.current) return
        setSnapError(errorText(e))
      }
    },
    [refreshCatalog]
  )

  useEffect(() => {
    alive.current = true
    refreshCatalog(true)
    return () => {
      alive.current = false
    }
  }, [refreshCatalog])

  useEffect(() => {
    if (frozenId) return // a frozen view never goes live
    const leave = joinWatchRoom('traffic-map')
    // #1098: frames from every API process; nodeFeed merges them (or keeps one node's).
    const offReseed = nodeFeed.onReseed(() => void loadSnapshot(filtersRef.current.win))
    const off = adminRealtime.on('traffic-map:frame', (p: unknown) => {
      if (pausedRef.current || document.hidden) return
      nodeFeed.accept(p as TrafficFrame, apply)
    })
    function apply(f: TrafficFrame) {
      const m = modelRef.current
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
      // A caller or partner the catalog has no label for: refetch it (throttled).
      const keys = [...Object.keys(f.callers ?? {}), ...(f.events ?? []).map((e) => e.caller)]
      if (catalogMissing(catalogRef.current, keys, Object.keys(f.down ?? {})))
        refreshCatalog(false, CATALOG_MISSING_REFRESH_MS)
      // frames resumed after a hole (a reconnect the local socket did not see): re-seed
      if (gap && Date.now() - lastSnapAt.current > STALE_MS)
        void loadSnapshot(filtersRef.current.win)
    }
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
      offReseed()
      leave()
      socket.off('auth:ok', onAuth)
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(watchdog)
    }
  }, [loadSnapshot, refreshCatalog, frozenId])

  /** #1100: pausing fills the ring's older seconds from a 15-minute snapshot, so the timeline
   *  reaches back before this page was opened. */
  const backfill = useCallback(async () => {
    if (frozenRef.current) return
    try {
      const res = await api.get(nodeFeed.snapshotUrl(900))
      if (!pausedRef.current) return
      modelRef.current.backfill(res.data.data as TrafficSnapshot)
      setTick((t) => t + 1)
    } catch {
      /* the timeline keeps what the page already holds */
    }
  }, [])
  const togglePause = () => {
    const next = !pausedRef.current
    pausedRef.current = next // set here so a frame arriving before the re-render is dropped
    setPaused(next)
    if (next) void backfill()
    else {
      // back to live: drop the rewind, and re-seed (frames were dropped while paused)
      modelRef.current.setView(null)
      setViewSec(null)
      void loadSnapshot(filtersRef.current.win)
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: leaving a frozen snapshot must reload the live one
  useEffect(() => {
    // paused: the new window's snapshot replaced the ring, so fill the older seconds again
    void loadSnapshot(filters.win).then(() => {
      if (pausedRef.current) void backfill()
    })
  }, [filters.win, loadSnapshot, frozenId, backfill])
  const rewindTo = useCallback((sec: number | null) => {
    modelRef.current.setView(sec)
    setViewSec(sec)
    setTick((t) => t + 1)
  }, [])
  const goLive = () => {
    if (pausedRef.current) togglePause()
    else rewindTo(null)
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
  const setTypes = (lanes: Lane[]) =>
    setFilters((f) => {
      const types = new Set(f.types)
      for (const l of CHIP_LANES) types.delete(l)
      for (const l of lanes) types.add(l)
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

  // The investigation stack is a module store: close it when the page goes away, so coming back
  // neither reopens it nor rewrites `inspect=` into the URL. Declared BEFORE the apply-once effect
  // below, so a StrictMode remount (cleanup → setup) closes first and the link re-applies after.
  useEffect(() => () => closeInspect(), [])
  // #1166: a link's lens / workspace / zoom params apply once on open. A link that carries any
  // view param is a whole view: params it leaves out go back to their defaults.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const own = [...CORE_PARAMS, ...viewParams.map((v) => v.param)]
    if (!own.some((k) => p.has(k))) return
    for (const v of viewParams) {
      try {
        v.set(p.get(v.param))
      } catch {
        /* a broken param leaves its state alone */
      }
    }
  }, [])
  // #1100 + #1166: a link that names a second opens paused at it (once the first snapshot is in)
  const atApplied = useRef(false)
  useEffect(() => {
    if (!ready || atApplied.current) return
    atApplied.current = true
    const at = linked.current.at
    if (at == null || frozenRef.current) return
    pausedRef.current = true
    setPaused(true)
    rewindTo(at)
    void backfill().then(() => rewindTo(at))
  }, [ready, rewindTo, backfill])
  // #1166: keep the address bar on the current view (replaceState: no history entry, no reload)
  const [paramsV, setParamsV] = useState(0)
  useEffect(() => {
    const offs = viewParams.map((v) => v.subscribe?.(() => setParamsV((n) => n + 1)))
    return () => {
      for (const off of offs) off?.()
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: paramsV re-runs it when a view param changes
  useEffect(() => {
    const t = setTimeout(() => {
      const url = new URL(window.location.href)
      for (const k of CORE_PARAMS) url.searchParams.delete(k)
      for (const v of viewParams) url.searchParams.delete(v.param)
      for (const [k, v] of encodeView({
        filters,
        selection,
        at: paused && viewSec != null ? viewSec : null
      }))
        url.searchParams.set(k, v)
      for (const v of viewParams) {
        let val: string | null = null
        try {
          val = v.get()
        } catch {
          val = null
        }
        if (val != null) url.searchParams.set(v.param, val)
      }
      if (url.href !== window.location.href)
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }, 250)
    return () => clearTimeout(t)
  }, [filters, selection, paused, viewSec, paramsV])

  const m = modelRef.current
  const win = filters.win
  const ef = useMemo<Filters>(
    () => (wsFocus ? { ...filters, workspace: wsFocus } : filters),
    [filters, wsFocus]
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read of the mutable model
  const view = useMemo(() => {
    if (!ready) return null
    const totals = m.totals(win, ef)
    const last60 = m.totals(60, ef)
    const counted = (lane: Lane) => lane === 'other' || ef.types.has(lane)
    const series = new Array<number>(60).fill(0)
    for (const k of m.entityKeys()) {
      if (!counted(laneOf(k))) continue
      const s = m.entitySeries(k, win, 60)
      for (let i = 0; i < 60; i++) series[i] += s[i] ?? 0
    }
    const allEvents = m.visibleEvents(ef)
    // #1125 pinned only: the ticker and the hot table keep the pinned entities
    const visibleEvents = pinFilter
      ? allEvents.filter((e) => pinFilter.has(`${e.lane}/${e.entity}`))
      : allEvents
    // Newest error code, counted the way the error total is: visible lanes plus `other` (R24).
    let lastError: string | null = null
    if (ef.kinds.has('error')) {
      const evErr = m.events.find(
        (e) => e.kind === 'error' && counted(e.lane) && (!ef.caller || e.caller === ef.caller)
      )
      if (evErr) lastError = evErr.code ?? (evErr.status ? String(evErr.status) : null)
      else {
        let newest = ''
        for (const k of m.entityKeys()) {
          if (!counted(laneOf(k))) continue
          const e = m.entityMeta(k)?.recent_errors.find((x) => !ef.caller || x.caller === ef.caller)
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
    const hot = pinFilter
      ? m
          .hot(win, ef, 100000)
          .filter((r) => pinFilter.has(r.key))
          .slice(0, 12)
      : m.hot(win, ef, 12)
    return { strip, hot, events: visibleEvents }
  }, [m, ready, win, ef, catalog, users, tick, pinFilter])

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read of the mutable model
  const inspector = useMemo(
    () => (ready && selection ? describeSelection(m, selection, ef, catalog) : null),
    [m, ready, selection, ef, catalog, tick]
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

  const ctx = useMemo<TrafficMapContextValue>(
    () => ({
      model: m,
      filters: ef,
      setFilters,
      selection,
      setSelection,
      catalog,
      tick,
      win,
      paused,
      ready
    }),
    [m, ef, selection, catalog, tick, win, paused, ready]
  )

  const live = ready && !stale && !snapError && !frozen
  const statusLabel = !ready
    ? 'Loading'
    : frozen
      ? 'Snapshot'
      : paused
        ? 'Paused'
        : stale
          ? 'Reconnecting'
          : snapError
            ? 'Snapshot failed'
            : 'Live'

  return (
    <TrafficMapContext.Provider value={ctx}>
      <div className='traffic-map flex min-h-0 flex-1 flex-col text-[13px]'>
        <header className='shrink-0 border-b border-slate-200 bg-white px-6 pb-3 pt-4 dark:border-border dark:bg-card'>
          <div className='flex flex-wrap items-center justify-between gap-x-6 gap-y-2'>
            <div className='flex min-w-0 flex-1 items-center gap-2.5'>
              <Waypoints className='h-5 w-5 shrink-0 text-muted-foreground' aria-hidden='true' />
              <h1 className='shrink-0 text-[17px] font-semibold text-slate-900 dark:text-foreground'>
                Traffic Map
              </h1>
              <p className='hidden min-w-0 truncate text-[12.5px] text-[var(--tm-muted)] 2xl:block'>
                Live requests, writes and errors as this API node sees them. Select any node for its
                routes, callers and recent errors.
              </p>
            </div>
            <div className='flex shrink-0 items-center gap-2'>
              <ToolbarItems slot='status' />
              <ToolbarItems slot='actions' />
              <MoreMenu />
              <span className='mx-1 h-4 w-px bg-[var(--tm-line)]' aria-hidden='true' />
              <div
                className='flex items-center gap-1.5 whitespace-nowrap px-1 text-[12px] text-[var(--tm-muted)]'
                id='tm-node'
                title={
                  m.journalSeq != null
                    ? `Journal sequence ${m.journalSeq.toLocaleString()}`
                    : undefined
                }
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
                <span className='font-medium text-[var(--tm-fg-2)]'>{statusLabel}</span>
                <span aria-hidden='true'>·</span>
                <span>
                  api <span data-testid='tm-instance'>{m.instance || '…'}</span>
                </span>
              </div>
              {/* A snapshot is already still: no Pause (a `hidden` attribute loses to the chip's display class). */}
              {!frozen && (
                <button
                  type='button'
                  id='tm-pause'
                  aria-pressed={paused}
                  onClick={togglePause}
                  title={paused ? 'Back to live' : 'Pause and rewind through the last 15 minutes'}
                  className={cn(
                    CHIP,
                    paused
                      ? 'border-[var(--tm-update)] bg-[var(--tm-update)] text-[var(--tm-on-update)]'
                      : CHIP_OFF
                  )}
                >
                  {paused ? (
                    <Play className='h-3 w-3' aria-hidden='true' />
                  ) : (
                    <PauseIcon className='h-3 w-3' aria-hidden='true' />
                  )}
                  {paused ? 'Resume' : 'Pause'}
                </button>
              )}
            </div>
          </div>
          <div
            className='mt-3 flex flex-wrap items-center gap-x-2 gap-y-2'
            role='toolbar'
            aria-label='Filters'
          >
            <ToolbarItems slot='lead' />
            <LanesMenu types={filters.types} onToggle={toggleType} onSet={setTypes} />
            <fieldset
              className='inline-flex min-w-0 overflow-hidden rounded-md border border-[var(--tm-line)]'
              aria-label='Request kinds'
            >
              {KIND_ORDER.map((k, i) => {
                const on = filters.kinds.has(k)
                return (
                  <button
                    key={k}
                    type='button'
                    id={`tm-kind-${k}`}
                    aria-pressed={on}
                    disabled={on && filters.kinds.size === 1}
                    onClick={() => toggleKind(k)}
                    className={cn(
                      SEG,
                      i > 0 && 'border-l border-[var(--tm-line)]',
                      on ? SEG_ON_NEUTRAL : SEG_OFF
                    )}
                  >
                    <span
                      className='h-2 w-2 rounded-sm'
                      style={{ background: KIND_VAR[k], opacity: on ? 1 : 0.3 }}
                      aria-hidden='true'
                    />
                    {k}
                  </button>
                )
              })}
            </fieldset>
            <label htmlFor='tm-caller' className='sr-only'>
              Caller
            </label>
            <SimpleSelect
              value={filters.caller}
              onChange={(v) => setFilters((f) => ({ ...f, caller: v }))}
              options={callerOptions}
              triggerProps={{ id: 'tm-caller' }}
              className='h-7 w-[170px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 text-[12px] text-[var(--tm-fg-2)]'
            />
            <fieldset
              className='inline-flex min-w-0 overflow-hidden rounded-md border border-[var(--tm-line)]'
              aria-label='Window'
              title='How far back the rates and counts look'
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
                      SEG,
                      i > 0 && 'border-l border-[var(--tm-line)]',
                      on ? SEG_ON : SEG_IDLE
                    )}
                  >
                    {label}
                  </button>
                )
              })}
            </fieldset>
            <ToolbarItems slot='filters' />
          </div>
        </header>

        <div className='relative flex min-h-0 flex-1'>
          <div className='min-w-0 flex-1 overflow-auto bg-[var(--tm-bg)] p-6 text-[var(--tm-fg)]'>
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
            <FrozenBanner snap={frozen} />
            {ready && (paused || frozen) ? (
              <RewindBar
                model={m}
                win={win}
                viewSec={viewSec}
                frozen={!!frozen}
                onRewind={rewindTo}
                onLive={goLive}
              />
            ) : null}
            <SummaryStrip d={view?.strip ?? null} />
            <div className='mt-3.5 grid items-start gap-3.5 min-[1100px]:grid-cols-[minmax(0,1fr)_360px]'>
              <MapCanvas
                model={m}
                filters={ef}
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
                  sel={selection}
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
            <PagePanels />
          </div>
          <InspectHost />
        </div>
      </div>
    </TrafficMapContext.Provider>
  )
}
