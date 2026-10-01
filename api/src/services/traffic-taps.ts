// api/src/services/traffic-taps.ts
/**
 * Traffic Map taps: the plug-in seam for features that watch the same request / write / outbound
 * stream the map does and add their own figures to frames, snapshots and the inspector.
 *
 * A feature registers ONE tap from its own module (`registerTrafficTap({ id, … })`) and keeps its
 * state in `tapState(id, init)`, never in module globals — state is per store: one store when
 * self-hosted, one per tenant in cloud mode (#1132). Taps run inside the store being recorded or
 * read, each call is isolated (a throwing tap affects nothing else), and every hook is optional.
 * Counters: use MinuteCounter / SecondRing from traffic-ring.ts.
 *
 * Ordering: taps run after the map has counted the event, in registration order.
 */
import { getTenantId } from '../db/tenant-context.js'
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
/** The self-hosted store (one per process). */
export const DEFAULT_STORE = 'default'
/** No store to record into (cloud mode outside a tenant request): callers record nothing. */
export const NO_STORE = ''
const stores = new Map<string, Map<string, unknown>>()
let storeOverride: string | null = null

function inCloud(): boolean {
  return !!process.env.CLOUD_META_DB_URL
}

/** The store of one tenant (cloud mode). */
export function tenantStoreId(tenantId: string): string {
  return `t:${tenantId}`
}

/**
 * The store the current call records into (#1132). Self-hosted: always `default`. Cloud: the
 * request's tenant (`t:<tenantId>`, from the tenant AsyncLocalStorage), or NO_STORE outside a
 * tenant request. `withTrafficStore` overrides it for the emitter, sweeps and Redis relays.
 */
export function currentStoreId(): string {
  if (storeOverride !== null) return storeOverride
  if (!inCloud()) return DEFAULT_STORE
  const t = getTenantId()
  return t ? tenantStoreId(t) : NO_STORE
}

/**
 * The store a finished request belongs to: the tenant the tenant hook stamped on it (the
 * onResponse hook may run outside the request's AsyncLocalStorage), else currentStoreId().
 */
export function storeForRequest(req: unknown): string {
  if (!inCloud()) return storeOverride ?? DEFAULT_STORE
  const stamped = (req as { nvrTenantId?: unknown } | null | undefined)?.nvrTenantId
  return typeof stamped === 'string' && stamped ? tenantStoreId(stamped) : currentStoreId()
}

/** Run `fn` (synchronously) recording into / reading from store `id`. */
export function withTrafficStore<T>(id: string, fn: () => T): T {
  const prev = storeOverride
  storeOverride = id
  try {
    return fn()
  } finally {
    storeOverride = prev
  }
}

/** A tap's state in the current store, created by `init` on first use. */
export function tapState<T>(tapId: string, init: () => T): T {
  const storeId = currentStoreId() || DEFAULT_STORE
  let store = stores.get(storeId)
  if (!store) {
    store = new Map()
    stores.set(storeId, store)
  }
  if (!store.has(tapId)) store.set(tapId, init())
  return store.get(tapId) as T
}

/** Forget every tap's state in one store (an idle tenant store is dropped by the sweep). */
export function dropTapStore(storeId: string): void {
  stores.delete(storeId)
}

/** Drop every tap's state, then let each tap reset anything else it holds. */
export function resetTapState(): void {
  stores.clear()
  eachTap((t) => t.reset?.())
}
