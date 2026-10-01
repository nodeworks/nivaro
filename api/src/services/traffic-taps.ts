// api/src/services/traffic-taps.ts
/**
 * Traffic Map taps: the plug-in seam for features that watch the same request / write / outbound
 * stream the map does and add their own figures to frames, snapshots and the inspector.
 *
 * A feature registers ONE tap from its own module (`registerTrafficTap({ id, … })`) and keeps its
 * state in `tapState(id, init)`, never in module globals — state is per store, so a tenant-scoped
 * map (#1132) can give each tenant its own without touching the taps. Taps run only where the map
 * records (never in cloud mode), each call is isolated (a throwing tap affects nothing else), and
 * every hook is optional. Counters: use MinuteCounter / SecondRing from traffic-ring.ts.
 *
 * Ordering: taps run after the map has counted the event, in registration order.
 */
import type { TrafficKind, TrafficLane } from './traffic-entities.js'
import type {
  TrafficEventWire,
  TrafficOutboundEvent,
  TrafficRequestEvent,
  TrafficWriteEvent
} from './traffic-map.js'

export { MinuteCounter, SecondRing } from './traffic-ring.js'

export interface TapRequestCtx {
  ev: TrafficRequestEvent
  lane: TrafficLane
  /** The entity the counts landed on (`__other__` once its lane is at the cap). */
  entity: string
  /** `<lane>/<entity>` */
  entityKey: string
  kind: TrafficKind
  caller: string
  /** Route template (`GET /api/items/workflows/:id`, or the GraphQL operation). */
  route: string
  isError: boolean
  /** Error code read from the response body (null on success or when none was found). */
  code: string | null
  /** Epoch second the event belongs to. */
  sec: number
  /** The ticker event the map queued for this request (reads and errors only); a tap may add
   *  `tags` / `extra` to it before it is sent. */
  event?: TrafficEventWire
}
export interface TapWriteCtx {
  ev: TrafficWriteEvent
  lane: TrafficLane
  entity: string
  entityKey: string
  caller: string
  via: string
  route: string
  sec: number
  /** The ticker event the map queued for this write; a tap may add `tags` / `extra` to it. */
  event?: TrafficEventWire
}
export interface TapOutboundCtx {
  ev: TrafficOutboundEvent
  /** `ext:<apiId>` */
  downId: string
  /** The entity the call was attributed to (`other/__background__` without a request). */
  entityKey: string
  failed: boolean
  sec: number
}

export interface TrafficTap {
  id: string
  onRequest?(c: TapRequestCtx): void
  onWrite?(c: TapWriteCtx): void
  onOutbound?(c: TapOutboundCtx): void
  /** Value for `frame.ext[id]` (this second); undefined = nothing to send. */
  frame?(sec: number): unknown
  /** Value for `snapshot.ext[id]`; undefined = nothing. */
  snapshot?(windowS: number, sec: number): unknown
  /** Value for `snapshot.entities[i].ext[id]`; undefined = nothing. */
  entitySnapshot?(entityKey: string, windowS: number, sec: number): unknown
  /** Value for GET /traffic-map/entity-detail `data[id]` (may read the database). */
  entityDetail?(entityKey: string, windowS: number, sec: number): unknown | Promise<unknown>
  /** Hourly idle sweep (drop state idle for the whole ring). */
  sweep?(sec: number): void
  /** resetTrafficMap(): tap state is already cleared; drop anything else held. */
  reset?(): void
}

const taps = new Map<string, TrafficTap>()

/** Register (or replace, by id) a tap. */
export function registerTrafficTap(tap: TrafficTap): void {
  taps.set(tap.id, tap)
}
export function unregisterTrafficTap(id: string): void {
  taps.delete(id)
}
export function trafficTaps(): TrafficTap[] {
  return [...taps.values()]
}

/** Run `fn` for every tap, each isolated: a tap must never affect a response or another tap. */
export function eachTap(fn: (t: TrafficTap) => void): void {
  if (taps.size === 0) return
  for (const t of taps.values()) {
    try {
      fn(t)
    } catch {
      /* isolated */
    }
  }
}

/** `{ [tapId]: value }` of the taps whose `fn` returned something; undefined when none did. */
export function collectTaps(fn: (t: TrafficTap) => unknown): Record<string, unknown> | undefined {
  if (taps.size === 0) return undefined
  let out: Record<string, unknown> | undefined
  for (const t of taps.values()) {
    try {
      const v = fn(t)
      if (v === undefined) continue
      if (!out) out = {}
      out[t.id] = v
    } catch {
      /* isolated */
    }
  }
  return out
}

// ── per-store tap state ─────────────────────────────────────────────────────
const DEFAULT_STORE = 'default'
const stores = new Map<string, Map<string, unknown>>()

/** The store the current call records into. One store today; #1132 makes it per tenant. */
export function currentStoreId(): string {
  return DEFAULT_STORE
}

/** A tap's state in the current store, created by `init` on first use. */
export function tapState<T>(tapId: string, init: () => T): T {
  const storeId = currentStoreId()
  let store = stores.get(storeId)
  if (!store) {
    store = new Map()
    stores.set(storeId, store)
  }
  if (!store.has(tapId)) store.set(tapId, init())
  return store.get(tapId) as T
}

/** Drop every tap's state, then let each tap reset anything else it holds. */
export function resetTapState(): void {
  stores.clear()
  eachTap((t) => t.reset?.())
}
