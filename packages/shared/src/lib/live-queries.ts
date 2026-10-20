import { type Query, type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { expandCoalesced } from './live'
import { LIVE_WIDGET_SAFETY_MS } from './live-widgets'
import { isOwnWrite } from './own-writes'
import {
  type CollectionUpdateEvent,
  type RealtimeAdapter,
  type RealtimeStatus,
  useOptionalRealtime,
  useRealtimeStatus
} from './realtime'

/**
 * Socket events refresh exactly what changed (#2450).
 *
 * One bridge per QueryClient maps `collection:update {collection, item, action?, changed_fields?}`
 * onto react-query invalidation, so a query only has to SAY what it reads:
 *
 *   useQuery({ queryKey: ['open-orders'], queryFn, meta: liveQueryMeta({ reads: ['orders'] }) })
 *   useQuery({ queryKey: ['order', id], queryFn, meta: liveQueryMeta({ record: { collection: 'orders', id } }) })
 *
 * - The bridge joins the collection rooms that ACTIVE tagged queries read (reference counted by
 *   the host adapter; a room is kept for `lingerMs` after its last query so a page change does
 *   not leave and re-join), and drops them when nothing reads them.
 * - Events are coalesced per collection (`windowMs`); each tagged query is then judged on its own
 *   meta: a record query only by events naming its id (or a bulk `'*'`), a `fields` list only by
 *   writes naming one of them, `$` aspect notices only when the query lists that aspect. Creates,
 *   deletes and events that name no fields always count — the event may have moved anything.
 * - Only queries someone is looking at refetch; inactive ones are marked stale (they refetch on
 *   their next mount). `minGapMs` caps how often one query refetches (a trailing refetch is
 *   never dropped) — collection reads default to 10 s, so a busy table cannot make a count
 *   re-aggregate on every write.
 * - A hidden tab marks stale and refetches when the tab is shown again.
 * - Reconcile (refetch every tagged query, plus the record/list heads that keep themselves live,
 *   once): after a reconnect whose catch-up did not replay the gap, on `nvr:catchup-full`, and
 *   when the tab comes back after being hidden for `hiddenReconcileMs`.
 *
 * The event is a notice. The bridge never reads a payload value: the refetch goes through the
 * query's own permission-checked route, so an event naming a record the viewer cannot read
 * refreshes nothing they could not already see. Unknown collections are ignored.
 */

export interface LiveQueryMeta {
  /** Collections whose writes may change this query's answer (lists, counts, widgets). */
  reads?: string[]
  /** The one record this query is about: refreshed only by writes naming it (or a bulk write). */
  record?: { collection: string; id: string | number }
  /** Only writes naming one of these fields refresh it (creates, deletes, unnamed writes always do). */
  fields?: string[]
  /** `$` aspects (`$state`, `$comments`, `$tasks`…) that refresh it. Default: aspect notices do not. */
  aspects?: string[]
  /** Refresh on this tab's own writes too. Default: yes for `reads`, no for `record` (the save refreshed it). */
  includeOwn?: boolean
  /** At most one refetch per this many ms, trailing refetch kept. Default 10 s for `reads`, 0 for `record`. */
  minGapMs?: number
  /** Never refreshed by events — only reconciled after a gap (a surface that keeps itself live). */
  reconcileOnly?: boolean
}

/** `meta` for a query the bridge keeps current: `useQuery({ …, meta: liveQueryMeta({ reads: ['orders'] }) })`. */
export function liveQueryMeta(live: LiveQueryMeta): { live: LiveQueryMeta } {
  return { live }
}

/**
 * Query-key heads of surfaces that keep themselves live with their own socket handlers (record
 * pages — RECORD_QUERY_HEADS in item-edit/RecordLiveSync — the collection browser's row reads,
 * queues, My Work, dashboard widgets). The bridge never refreshes them on an event; it only
 * refetches the active ones on a reconcile, since their handlers missed the gap too.
 */
export const LIVE_RECONCILE_HEADS: readonly string[] = [
  'item',
  'rrv-record',
  'revisions',
  'field-touch',
  'last-touch',
  'comments',
  'comments-related',
  'tasks',
  'addendums',
  'pipeline-instance',
  'pipeline-all-owners',
  'pipeline-instance-owners',
  'pipeline-owners-resolved',
  'approval-brief',
  'erp-submissions',
  'record-integrations',
  'record-integrity',
  'cbv-items',
  'cbv-pipeline-instances',
  'cbv-owners',
  'cbv-risk',
  'cbv-addendum-summary',
  'cbv-resolved',
  'cbv-row-instance',
  'queue-items',
  'my-work',
  'widget-data',
  'live-record',
  'live-list'
]

export interface LiveQueryBridgeOptions {
  /** Burst window per collection (default 300 ms). */
  windowMs?: number
  /** Default `minGapMs` for `reads` queries (default 10 s). */
  readsGapMs?: number
  /** A tab hidden at least this long reconciles when shown again (default 5 min). */
  hiddenReconcileMs?: number
  /** Keep a collection room this long after its last reader (default 30 s). */
  lingerMs?: number
  /** Spread a reconnect's reconcile over this long, so every tab does not ask at once (default 1.5 s). */
  jitterMs?: number
  /** Reconcile on `nvr:catchup-full` (default true). Off for a host that already refetches
   *  every query on it (admin's ForceRefreshBanner). */
  reconcileOnCatchupFull?: boolean
  /** Own-write test (default: the shared own-write registry). */
  isOwn?: (collection: string, item: string | number | null) => boolean
  /** Test seams. */
  now?: () => number
  random?: () => number
  doc?: (LiveEventTarget & { hidden: boolean }) | null
  win?: LiveEventTarget | null
}

/** The slice of `document` / `window` the bridge listens on. */
interface LiveEventTarget {
  addEventListener(type: string, cb: () => void): void
  removeEventListener(type: string, cb: () => void): void
}

export interface LiveQueryBridge {
  /** Refetch every tagged query and every active reconcile head once. */
  reconcile(reason: string): void
  /** Collections whose rooms the bridge holds right now. */
  collections(): string[]
  /** Counters for diagnostics and tests. */
  stats(): { events: number; refetches: number; reconciles: number; deferred: number }
  dispose(): void
}

type LiveEv = CollectionUpdateEvent & { own: boolean }
type AnyQuery = Query<unknown, Error, unknown, readonly unknown[]>

const metaOf = (q: AnyQuery): LiveQueryMeta | null => {
  const live = (q.meta as { live?: LiveQueryMeta } | undefined)?.live
  return live && typeof live === 'object' ? live : null
}

/** The collections a tagged query listens to (none for reconcile-only queries). */
export function liveCollectionsOf(meta: LiveQueryMeta | null): string[] {
  if (!meta || meta.reconcileOnly) return []
  const out = new Set<string>()
  for (const c of meta.reads ?? []) if (c) out.add(c)
  if (meta.record?.collection) out.add(meta.record.collection)
  return [...out]
}

/** Does this batch of events on `collection` change what `meta` reads? Exported for tests. */
export function liveEventsMatch(
  meta: LiveQueryMeta,
  collection: string,
  events: LiveEv[]
): boolean {
  if (meta.reconcileOnly) return false
  const rec = meta.record
  const asRecord = !!rec && rec.collection === collection
  if (!asRecord && !(meta.reads ?? []).includes(collection)) return false
  const includeOwn = meta.includeOwn ?? !asRecord
  const want = asRecord ? String(rec?.id) : null
  for (const ev of events) {
    if (ev.own && !includeOwn) continue
    if (want !== null && String(ev.item) !== want && ev.item !== '*') continue
    if (ev.action === 'create' || ev.action === 'delete') return true
    const fields = ev.changed_fields
    if (!fields || fields.length === 0) return true
    const columns = fields.filter((f) => !f.startsWith('$'))
    if (columns.length > 0 && (!meta.fields || columns.some((f) => meta.fields?.includes(f))))
      return true
    if (meta.aspects?.length && fields.some((f) => meta.aspects?.includes(f))) return true
  }
  return false
}

const bridges = new Map<QueryClient, number>()
const bridgeListeners = new Set<() => void>()
const bump = (qc: QueryClient, delta: number) => {
  const n = (bridges.get(qc) ?? 0) + delta
  if (n > 0) bridges.set(qc, n)
  else bridges.delete(qc)
  for (const l of bridgeListeners) l()
}

export function createLiveQueryBridge(
  qc: QueryClient,
  realtime: RealtimeAdapter,
  opts: LiveQueryBridgeOptions = {}
): LiveQueryBridge {
  const windowMs = opts.windowMs ?? 300
  const readsGapMs = opts.readsGapMs ?? 10_000
  const hiddenReconcileMs = opts.hiddenReconcileMs ?? 5 * 60_000
  const lingerMs = opts.lingerMs ?? 30_000
  const jitterMs = opts.jitterMs ?? 1500
  const isOwn = opts.isOwn ?? ((c, i) => isOwnWrite(c, i))
  const now = opts.now ?? (() => Date.now())
  const random = opts.random ?? Math.random
  const doc =
    opts.doc === undefined ? (typeof document === 'undefined' ? null : document) : opts.doc
  const win = opts.win === undefined ? (typeof window === 'undefined' ? null : window) : opts.win
  const cache = qc.getQueryCache()
  const counters = { events: 0, refetches: 0, reconciles: 0, deferred: 0 }
  let disposed = false

  // ── Rooms: one subscription per collection an active tagged query reads ──
  const subs = new Map<string, () => void>()
  const lingering = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, LiveEv[]>()
  const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const MAX_PENDING = 500

  const onEvent = (raw: CollectionUpdateEvent) => {
    if (disposed || !raw?.collection) return
    const collection = String(raw.collection)
    if (!subs.has(collection)) return // not a collection anything here reads
    counters.events++
    const list = pending.get(collection) ?? []
    for (const ev of expandCoalesced(raw as CollectionUpdateEvent & Record<string, unknown>)) {
      if (list.length >= MAX_PENDING) {
        // A flood: one bulk event stands for the rest (it refreshes every reader once).
        list.length = 0
        list.push({ collection, item: '*', own: false })
        break
      }
      list.push({ ...ev, own: ev.item != null && ev.item !== '*' && isOwn(collection, ev.item) })
    }
    pending.set(collection, list)
    if (!flushTimers.has(collection))
      flushTimers.set(
        collection,
        setTimeout(() => flush(collection), windowMs)
      )
  }

  const syncRooms = () => {
    if (disposed) return
    const wanted = new Set<string>()
    for (const q of cache.getAll() as AnyQuery[]) {
      if (q.getObserversCount() === 0) continue
      for (const c of liveCollectionsOf(metaOf(q))) wanted.add(c)
    }
    for (const c of wanted) {
      const t = lingering.get(c)
      if (t) {
        clearTimeout(t)
        lingering.delete(c)
      }
      if (!subs.has(c)) subs.set(c, realtime.subscribeCollections([c], onEvent))
    }
    for (const c of subs.keys()) {
      if (wanted.has(c) || lingering.has(c)) continue
      lingering.set(
        c,
        setTimeout(() => {
          lingering.delete(c)
          subs.get(c)?.()
          subs.delete(c)
        }, lingerMs)
      )
    }
  }
  let syncQueued = false
  const queueSync = () => {
    if (syncQueued) return
    syncQueued = true
    queueMicrotask(() => {
      syncQueued = false
      syncRooms()
    })
  }
  const offCache = cache.subscribe((e) => {
    if (
      e.type === 'added' ||
      e.type === 'removed' ||
      e.type === 'observerAdded' ||
      e.type === 'observerRemoved' ||
      e.type === 'observerOptionsUpdated'
    )
      queueSync()
  })

  // ── Refetching: only active queries, min gap per query, hidden tabs defer ──
  const lastRefetch = new WeakMap<AnyQuery, number>()
  const trailing = new Map<AnyQuery, ReturnType<typeof setTimeout>>()
  const deferred = new Set<AnyQuery>()

  // `cancel`: a fetch already in flight may have started before the write — restart it. Off when
  // the tab was just shown: react-query's own focus refetch is that fresh read already.
  const refetchNow = (targets: AnyQuery[], cancel: boolean) => {
    if (targets.length === 0) return
    const set = new Set(targets)
    const at = now()
    for (const q of targets) lastRefetch.set(q, at)
    counters.refetches += targets.filter((q) => q.getObserversCount() > 0).length
    void qc.invalidateQueries(
      { predicate: (q) => set.has(q as AnyQuery) },
      { cancelRefetch: cancel }
    )
  }

  const refresh = (targets: AnyQuery[], cancel = true) => {
    const due: AnyQuery[] = []
    const idle: AnyQuery[] = []
    for (const q of targets) {
      if (q.getObserversCount() === 0) idle.push(q)
      else if (doc?.hidden) {
        idle.push(q)
        deferred.add(q)
      } else due.push(q)
    }
    // Nobody is looking: mark stale, refetch on the next mount (or when the tab is shown).
    if (idle.length) {
      const set = new Set(idle)
      counters.deferred += idle.length
      void qc.invalidateQueries({ predicate: (q) => set.has(q as AnyQuery), refetchType: 'none' })
    }
    const nowAt = now()
    const ready: AnyQuery[] = []
    for (const q of due) {
      const meta = metaOf(q)
      const gap = meta?.minGapMs ?? (meta?.record ? 0 : readsGapMs)
      const last = lastRefetch.get(q) ?? 0
      if (gap <= 0 || nowAt - last >= gap) {
        const t = trailing.get(q)
        if (t) {
          clearTimeout(t)
          trailing.delete(q)
        }
        ready.push(q)
      } else if (!trailing.has(q)) {
        trailing.set(
          q,
          setTimeout(
            () => {
              trailing.delete(q)
              if (!disposed) refresh([q])
            },
            last + gap - nowAt
          )
        )
      }
    }
    refetchNow(ready, cancel)
  }

  const flush = (collection: string) => {
    flushTimers.delete(collection)
    const events = pending.get(collection) ?? []
    pending.delete(collection)
    if (disposed || events.length === 0) return
    const targets: AnyQuery[] = []
    for (const q of cache.getAll() as AnyQuery[]) {
      const meta = metaOf(q)
      if (meta && liveEventsMatch(meta, collection, events)) targets.push(q)
    }
    refresh(targets)
  }

  // ── Reconcile ──
  const heads = new Set(LIVE_RECONCILE_HEADS)
  const reconcile = (reason: string) => {
    void reason
    if (disposed) return
    counters.reconciles++
    const tagged: AnyQuery[] = []
    for (const q of cache.getAll() as AnyQuery[]) {
      if (metaOf(q)) tagged.push(q)
    }
    deferred.clear()
    const set = new Set(tagged)
    // Tagged queries (active refetch, the rest marked stale) + the active self-live surfaces.
    // A read already in flight (a focus refetch) started after the gap: keep it.
    void qc.invalidateQueries(
      {
        predicate: (q) =>
          set.has(q as AnyQuery) ||
          (q.getObserversCount() > 0 && heads.has(String((q.queryKey as unknown[])[0])))
      },
      { cancelRefetch: false }
    )
  }
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null
  const reconcileSoon = (reason: string) => {
    if (reconcileTimer) return
    reconcileTimer = setTimeout(
      () => {
        reconcileTimer = null
        reconcile(reason)
      },
      Math.floor(random() * jitterMs)
    )
  }

  // A reconnect: the adapter says whether its catch-up replayed the gap (`replayed`), reloaded
  // (`reloaded` — the window event below reconciles) or could not tell (`unverified`). An
  // adapter that does not say (`undefined`) reconciles too; `null` is a first connection.
  let wasLive = realtime.status?.().state !== 'reconnecting'
  const offStatus = realtime.onStatus?.((s: RealtimeStatus) => {
    const live = s.state === 'live'
    if (live && !wasLive && (s.resumed === 'unverified' || s.resumed === undefined))
      reconcileSoon('reconnect')
    wasLive = live
  })
  const onCatchupFull = () => reconcileSoon('catchup-full')
  const catchupWin = opts.reconcileOnCatchupFull === false ? null : win
  catchupWin?.addEventListener('nvr:catchup-full', onCatchupFull)

  let hiddenAt: number | null = doc?.hidden ? now() : null
  const onVisibility = () => {
    if (!doc) return
    if (doc.hidden) {
      hiddenAt ??= now()
      return
    }
    const away = hiddenAt == null ? 0 : now() - hiddenAt
    hiddenAt = null
    if (away >= hiddenReconcileMs) {
      reconcile('visible')
      return
    }
    const due = [...deferred].filter((q) => q.getObserversCount() > 0)
    deferred.clear()
    refresh(due, false)
  }
  doc?.addEventListener('visibilitychange', onVisibility)

  bump(qc, 1)
  syncRooms()

  return {
    reconcile,
    collections: () => [...subs.keys()],
    stats: () => ({ ...counters }),
    dispose() {
      if (disposed) return
      disposed = true
      offCache()
      offStatus?.()
      catchupWin?.removeEventListener('nvr:catchup-full', onCatchupFull)
      doc?.removeEventListener('visibilitychange', onVisibility)
      for (const t of [...flushTimers.values(), ...lingering.values(), ...trailing.values()])
        clearTimeout(t)
      if (reconcileTimer) clearTimeout(reconcileTimer)
      for (const off of subs.values()) off()
      subs.clear()
      bump(qc, -1)
    }
  }
}

/**
 * Mount ONCE per app, inside the QueryClientProvider and the RealtimeContext (admin: AppLayout;
 * a portal: its shell). Without a realtime adapter it does nothing and tagged queries keep their
 * own timers.
 */
export function useLiveQueryBridge(opts?: LiveQueryBridgeOptions): void {
  const qc = useQueryClient()
  const realtime = useOptionalRealtime()
  // Options are read once per mount (the bridge is long-lived).
  const optsRef = useRef(opts)
  useEffect(() => {
    if (!realtime) return
    const bridge = createLiveQueryBridge(qc, realtime, optsRef.current)
    return () => bridge.dispose()
  }, [qc, realtime])
}

/** Whether a bridge is mounted for this QueryClient (tagged queries refresh on events). */
export function useLiveQueriesOn(): boolean {
  const qc = useQueryClient()
  return useSyncExternalStore(
    (cb) => {
      bridgeListeners.add(cb)
      return () => {
        bridgeListeners.delete(cb)
      }
    },
    () => bridges.has(qc),
    () => false
  )
}

/**
 * The refetch interval for a query whose data a socket event covers: the caller's own while
 * events cannot arrive (no realtime, reconnecting — or, with `requireBridge`, no bridge for its
 * `meta.live`), a slow safety poll (`safetyMs`, default 5 min) while they can.
 */
export function useLiveRefetchInterval(
  base: number | false | undefined,
  opts: { requireBridge?: boolean; safetyMs?: number; enabled?: boolean } = {}
): number | false | undefined {
  const realtime = useOptionalRealtime()
  const status = useRealtimeStatus()
  const bridged = useLiveQueriesOn()
  const live =
    opts.enabled !== false &&
    !!realtime &&
    status?.state !== 'reconnecting' &&
    (!opts.requireBridge || bridged)
  return liveRefetchInterval(live, base, opts.safetyMs)
}

/** Pure form of `useLiveRefetchInterval` (exported for tests). */
export function liveRefetchInterval(
  live: boolean,
  base: number | false | undefined,
  safetyMs = LIVE_WIDGET_SAFETY_MS
): number | false | undefined {
  if (!live || base == null || base === false) return base
  return Math.max(base, safetyMs)
}
