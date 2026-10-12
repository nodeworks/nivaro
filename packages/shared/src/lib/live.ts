import { useContext, useEffect, useRef } from 'react'
import { ItemEditAuthContext } from '../context'
import { isOwnWrite } from './own-writes'
import { type CollectionUpdateEvent, useOptionalRealtime } from './realtime'

/**
 * Live hooks — the one pattern every "X updates live" surface uses.
 *
 * The server says THAT something changed, never WHAT it changed to:
 * `collection:update {collection, item, action?, changed_fields?}` (field
 * NAMES only) plus a few record-room events (`record:comment`,
 * `record:integrity`, `record:automation`, `access:changed` …). A component
 * reacts by refetching through its own permission-checked query, never by
 * trusting a payload value.
 *
 *   // 1. Refresh queries when this record changes (debounced, own writes skipped):
 *   useLiveRecordQueries('workflows', id, [['revisions', 'workflows', id]])
 *
 *   // 2. Custom reaction to a record's writes:
 *   useLiveRecord('workflows', id, (batch) => {
 *     if (batchTouches(batch, '$state')) refetchInstance()
 *   })
 *
 *   // 3. A whole list (rows on a page):
 *   useLiveCollection('workflows', (batch) => ..., { match: (ev) => visible.has(String(ev.item)) })
 *
 *   // 4. A named socket event about this record (record-room events):
 *   useLiveRecordEvent('record:integrity', 'workflows', id, () => qc.invalidateQueries(...))
 *
 * Rules the hooks enforce so callers do not have to:
 * - Handlers live in a ref — pass inline arrows, no memoising needed.
 * - Events within `debounceMs` (default 250) arrive as ONE batch.
 * - Writes this tab made itself are dropped unless `includeOwn` (see
 *   `noteOwnWrite`: every non-GET through a NivaroProvider client is noted
 *   automatically, so a save never echoes back as "someone else").
 * - `item: '*'` (a bulk raw write that names no single record) matches every
 *   record subscription — refetch, it may be yours.
 * - Without a host RealtimeAdapter the collection hooks are inert (the
 *   component behaves as it did before live updates). Named events also
 *   arrive through the window relay `nvr:live-event`, so a host whose record
 *   room rides a separate socket (admin's presence socket) can forward them
 *   with `relayLiveEvent(event, payload)`.
 *
 * Virtual "aspect" fields: an event whose changed_fields are all `$`-names
 * (`$state`, `$addendums`, `$comments`, `$tasks`, `$integrations`) says a
 * related surface moved, not the record's own columns — skip the row
 * refetch and refresh only that surface (`batch.aspectsOnly`).
 */

export const LIVE_WINDOW_EVENT = 'nvr:live-event'

/** Payload keys a live event may carry beyond the base contract (all optional). */
export interface LiveEvent extends CollectionUpdateEvent {
  /** This tab (or this user) made the write. */
  own: boolean
  /** Number of records a bulk raw write touched (with item '*'). */
  bulk?: number
}

export interface LiveBatch {
  events: LiveEvent[]
  /** Distinct record ids in the batch ('*' when a bulk write named none). */
  ids: string[]
  /** Every field name any event named; null when some event named none (= anything). */
  changedFields: string[] | null
  /** Every event named only `$` aspect fields — the record's own columns did not move. */
  aspectsOnly: boolean
  deleted: boolean
  created: boolean
  /** Every event in the batch was the viewer's own write. */
  own: boolean
}

/** True when the batch may have touched `field` (a batch without field names touches all). */
export function batchTouches(batch: LiveBatch, ...fields: string[]): boolean {
  if (batch.changedFields === null) return !batch.aspectsOnly
  return fields.some((f) => batch.changedFields?.includes(f))
}

/** Aspect (virtual) field names the record-page surfaces listen for. */
export const LIVE_ASPECTS = {
  state: '$state',
  addendums: '$addendums',
  comments: '$comments',
  tasks: '$tasks',
  integrations: '$integrations',
  owners: '$owners'
} as const

export { isOwnWrite, noteOwnWrite, noteOwnWriteFromCommand } from './own-writes'

/** The actor id an event names, when a server includes one (`by` / `user` / `user_id`). */
function actorOf(ev: Record<string, unknown>): string | null {
  for (const k of ['by', 'user', 'user_id']) {
    const v = ev[k]
    if (typeof v === 'string' && v) return v
    if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string')
      return (v as { id: string }).id
  }
  return null
}

function isOwnEvent(ev: Record<string, unknown>, selfId: string): boolean {
  const actor = actorOf(ev)
  if (actor && selfId && actor.toUpperCase() === selfId.toUpperCase()) return true
  const collection = typeof ev.collection === 'string' ? ev.collection : ''
  return collection !== '' && ev.item != null && isOwnWrite(collection, ev.item as string)
}

/** Fold raw events into one batch (exported for tests). */
export function toLiveBatch(events: LiveEvent[]): LiveBatch {
  const ids = [...new Set(events.map((e) => String(e.item)))]
  let changed: Set<string> | null = new Set()
  let aspectsOnly = events.length > 0
  for (const e of events) {
    const f = e.changed_fields
    if (!f || f.length === 0) {
      changed = null
      aspectsOnly = false
      continue
    }
    if (!f.every((x) => x.startsWith('$'))) aspectsOnly = false
    if (changed) for (const x of f) changed.add(x)
  }
  if (events.some((e) => e.action === 'create' || e.action === 'delete')) aspectsOnly = false
  return {
    events,
    ids,
    changedFields: changed ? [...changed] : null,
    aspectsOnly,
    deleted: events.some((e) => e.action === 'delete'),
    created: events.some((e) => e.action === 'create'),
    own: events.length > 0 && events.every((e) => e.own)
  }
}

export interface LiveOptions {
  /** Burst window; events inside it arrive as one batch. 0 = deliver each event. */
  debounceMs?: number
  /** Deliver this tab's own writes too (marked `own`). */
  includeOwn?: boolean
  /** Extra filter over each event. */
  match?: (ev: LiveEvent) => boolean
  /** Pause without unmounting. */
  enabled?: boolean
}

/**
 * Subscribe to `collection:update` for one or more collections. The
 * foundation the record/list hooks build on.
 */
export function useLiveCollection(
  collections: string | string[] | null | undefined,
  onBatch: (batch: LiveBatch) => void,
  opts: LiveOptions = {}
): void {
  const realtime = useOptionalRealtime()
  const { userId } = useContext(ItemEditAuthContext)
  const handlerRef = useRef(onBatch)
  handlerRef.current = onBatch
  const optsRef = useRef(opts)
  optsRef.current = opts
  const selfRef = useRef(userId)
  selfRef.current = userId
  const list = collections == null ? [] : Array.isArray(collections) ? collections : [collections]
  const listKey = list.filter(Boolean).join(',')
  const enabled = opts.enabled !== false

  useEffect(() => {
    if (!realtime || !listKey || !enabled) return
    const names = listKey.split(',')
    let pending: LiveEvent[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      const evs = pending
      pending = []
      if (evs.length > 0) handlerRef.current(toLiveBatch(evs))
    }
    const unsub = realtime.subscribeCollections(names, (raw) => {
      const ev = raw as CollectionUpdateEvent & Record<string, unknown>
      if (!ev || !names.includes(String(ev.collection))) return
      const live: LiveEvent = { ...ev, own: isOwnEvent(ev, selfRef.current) }
      const o = optsRef.current
      if (live.own && !o.includeOwn) return
      if (o.match && !o.match(live)) return
      pending.push(live)
      const wait = o.debounceMs ?? 250
      if (wait <= 0) flush()
      else if (!timer) timer = setTimeout(flush, wait)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [realtime, listKey, enabled])
}

/** One record's writes (plus bulk `'*'` events on its collection). */
export function useLiveRecord(
  collection: string | null | undefined,
  itemId: string | number | null | undefined,
  onBatch: (batch: LiveBatch) => void,
  opts: LiveOptions = {}
): void {
  const id = itemId == null || itemId === 'new' ? null : String(itemId)
  const outer = opts.match
  useLiveCollection(collection && id ? collection : null, onBatch, {
    ...opts,
    match: (ev) => (String(ev.item) === id || ev.item === '*') && (!outer || outer(ev))
  })
}

/**
 * Invalidate react-query keys whenever this record changes (someone else's
 * write). `aspects` narrows it: only batches naming one of those `$` fields —
 * or naming no fields at all — invalidate.
 */
export function useLiveRecordQueries(
  collection: string | null | undefined,
  itemId: string | number | null | undefined,
  keys: unknown[][],
  opts: LiveOptions & {
    aspects?: string[]
    client?: { invalidateQueries: (f: { queryKey: unknown[] }) => unknown }
  } = {}
): void {
  const keysRef = useRef(keys)
  keysRef.current = keys
  const qcRef = useRef(opts.client)
  qcRef.current = opts.client
  useLiveRecord(
    collection,
    itemId,
    (batch) => {
      const aspects = opts.aspects
      if (
        aspects &&
        aspects.length > 0 &&
        batch.changedFields !== null &&
        !batchTouches(batch, ...aspects)
      )
        return
      for (const k of keysRef.current) void qcRef.current?.invalidateQueries({ queryKey: k })
    },
    opts
  )
}

// ── Named events (record rooms, user rooms) ───────────────────────────────

/** Hosts forward socket events that reach a different socket than the adapter's. */
export function relayLiveEvent(event: string, payload: unknown): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(LIVE_WINDOW_EVENT, { detail: { event, payload } }))
}

export interface LiveEventOptions {
  match?: (payload: any) => boolean
  /** >0: deliver the LAST payload of each burst. */
  debounceMs?: number
  enabled?: boolean
  /** Deliver events naming the viewer as their actor too. */
  includeOwn?: boolean
}

/**
 * Listen to named socket events through the adapter AND the window relay.
 * The same payload arriving by both routes inside 150ms is delivered once.
 */
export function useLiveEvent(
  events: string | string[],
  onEvent: (payload: any, event: string) => void,
  opts: LiveEventOptions = {}
): void {
  const realtime = useOptionalRealtime()
  const { userId } = useContext(ItemEditAuthContext)
  const handlerRef = useRef(onEvent)
  handlerRef.current = onEvent
  const optsRef = useRef(opts)
  optsRef.current = opts
  const selfRef = useRef(userId)
  selfRef.current = userId
  const names = (Array.isArray(events) ? events : [events]).join(',')
  const enabled = opts.enabled !== false

  useEffect(() => {
    if (!enabled || !names) return
    const list = names.split(',')
    let last: { sig: string; at: number } | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let latest: { payload: any; event: string } | null = null
    const deliver = (event: string, payload: any) => {
      if (!list.includes(event)) return
      const o = optsRef.current
      const p = payload ?? {}
      if (!o.includeOwn && typeof p === 'object') {
        const actor = actorOf(p as Record<string, unknown>)
        if (actor && selfRef.current && actor.toUpperCase() === selfRef.current.toUpperCase())
          return
      }
      if (o.match && !o.match(p)) return
      let sig = event
      try {
        sig = `${event}|${JSON.stringify(p)}`
      } catch {
        /* unserialisable payload — no dedupe */
      }
      const now = Date.now()
      if (last && last.sig === sig && now - last.at < 150) return
      last = { sig, at: now }
      const wait = o.debounceMs ?? 0
      if (wait <= 0) {
        handlerRef.current(p, event)
        return
      }
      latest = { payload: p, event }
      if (!timer)
        timer = setTimeout(() => {
          timer = null
          if (latest) handlerRef.current(latest.payload, latest.event)
          latest = null
        }, wait)
    }
    const offs = list.map((e) => realtime?.on(e, (p) => deliver(e, p)) ?? (() => {}))
    const onWindow = (e: Event) => {
      const d = (e as CustomEvent).detail as { event?: string; payload?: unknown } | undefined
      if (d?.event) deliver(d.event, d.payload)
    }
    window.addEventListener(LIVE_WINDOW_EVENT, onWindow)
    return () => {
      for (const off of offs) off()
      window.removeEventListener(LIVE_WINDOW_EVENT, onWindow)
      if (timer) clearTimeout(timer)
    }
  }, [realtime, names, enabled])
}

/** A named event about one record (payload carries `collection` + `item`). */
export function useLiveRecordEvent(
  events: string | string[],
  collection: string | null | undefined,
  itemId: string | number | null | undefined,
  onEvent: (payload: any, event: string) => void,
  opts: LiveEventOptions = {}
): void {
  const id = itemId == null || itemId === 'new' ? null : String(itemId)
  const outer = opts.match
  useLiveEvent(events, onEvent, {
    ...opts,
    enabled: opts.enabled !== false && !!collection && !!id,
    match: (p) => p?.collection === collection && String(p?.item) === id && (!outer || outer(p))
  })
}

/**
 * Join an admin-only watch room while mounted (`jobs`, `conformance`). The
 * server checks admin access when the socket joins; for anyone else, and for
 * hosts whose adapter has no `joinWatch`, nothing arrives and the component's
 * own polling carries on. Returns whether live events can arrive (false = poll normally).
 */
export function useLiveWatchRoom(room: string, enabled = true): boolean {
  const realtime = useOptionalRealtime()
  const can = !!realtime?.joinWatch
  useEffect(() => {
    if (!enabled || !realtime?.joinWatch) return
    return realtime.joinWatch(room)
  }, [realtime, room, enabled])
  return can && enabled
}

/** Whether the host wired a realtime adapter (collection feeds are live). */
export function useLiveAvailable(): boolean {
  return useOptionalRealtime() != null
}
