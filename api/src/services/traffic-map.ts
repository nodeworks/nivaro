// api/src/services/traffic-map.ts
/**
 * Traffic Map aggregator (spec §5–6). In-process, per node: 15-minute per-second rings per
 * entity / caller / downstream node, fed by the api-logger (requests), broadcastCollectionUpdate
 * (writes) and logOutbound (partner calls). Memory only — nothing here touches the database.
 */
import { currentChain } from './chain.js'
import { currentSeq } from './event-journal.js'
import { INSTANCE_ID } from './instance-roster.js'
import { getIo } from './io-holder.js'
import { currentTraceCaller, currentTraceMeta } from './request-trace.js'
import { instanceKey } from './settings-overrides.js'
import { clientFactsOf } from './traffic-client-facts.js'
import {
  type CallerKey,
  type Classified,
  type ClassifyInput,
  callerKeyFor,
  classifyRequest,
  entityKey,
  LANES,
  normalizePath,
  routeTemplate,
  type TrafficKind,
  type TrafficLane
} from './traffic-entities.js'
import {
  bumpMinute,
  type CountRing,
  type MinuteSeries,
  RING_SECONDS,
  ringBump,
  ringSecond,
  ringSeries,
  ringSum,
  TOP_KEYS_CAP,
  topMinutes
} from './traffic-ring.js'
import { currentTrafficSource } from './traffic-source.js'
import {
  collectTaps,
  currentStoreId,
  DEFAULT_STORE,
  dropTapStore,
  eachTap,
  NO_STORE,
  resetTapState,
  storeForRequest,
  withTrafficStore
} from './traffic-taps.js'

export { MINUTE_BUCKETS, RING_SECONDS, TOP_KEYS_CAP } from './traffic-ring.js'
export const LANE_ENTITY_CAP = 40
export const RECENT_CAP = 12
export const LAT_SAMPLES = 240
export const EVENTS_PER_FRAME = 40
/** Pseudo-entity for partner calls with no request behind them (R36). */
export const BACKGROUND_ENTITY = '__background__'
export const NODE_SCOPE = 'this API process only (Redis adapter fans out sockets, not traffic)'
const SLOTS = 6 // req, read, create, update, delete, error
const K = { req: 0, read: 1, create: 2, update: 3, delete: 4, error: 5 } as const

export interface TrafficRequestEvent {
  method: string
  path: string
  status: number
  latencyMs: number
  authMethod: string | null
  apiKeyId: number | null
  userId: string | null
  graphqlOperation: string | null
  graphqlKind: string | null
  cacheHit: boolean
  at: number
  /** The Fastify request (taps read headers, masquerade, workspace, trace data off it). */
  req?: unknown
  /** The Fastify reply. */
  reply?: unknown
  /** Response body bytes (string/Buffer payloads); null for streams or when unknown. */
  responseBytes?: number | null
}
export interface TrafficWriteEvent {
  collection: string
  item: string | number
  action: 'create' | 'update' | 'delete'
  changedFields: string[]
  at: number
  /** Anything a writer wants a tap to see (never sent to the client by the map itself). */
  extra?: Record<string, unknown>
}
export interface TrafficOutboundEvent {
  apiId: number
  apiName: string
  status: number | null
  durationMs: number
  at: number
  /** HTTP verb and path of the call (extension node matching, #1114). */
  method?: string
  path?: string
  /** Transport error text when there was no response (error class, #1112). */
  error?: string | null
}
export interface TrafficEventWire {
  t: number
  lane: TrafficLane
  entity: string
  kind: TrafficKind | 'error'
  caller: CallerKey
  route: string
  status?: number
  ms?: number
  record?: string
  fields?: string[]
  code?: string | null
  via?: string
  /** Integration event chain the request / write belongs to (#1092 Show path). */
  chain?: string
  /** Short neutral labels a tap adds (shown as chips in the ticker). */
  tags?: string[]
  /** Tap-specific fields; the map itself never reads them. */
  extra?: Record<string, unknown>
  /** The request id behind the event (= its trace id and API log `request_id`). */
  rid?: string
  /** The API process that saw it (the roster id — the cluster's node id). */
  node?: string
  /** The browser tab the request came from (`x-nivaro-client` tab=). */
  tab?: string
  /** The frontend build that tab runs (`x-nivaro-client` build=). */
  build?: string
  /** Which front end (`x-nivaro-app`). */
  app?: string
  /** The screen pattern the request came from (`x-nivaro-page`, normalised). */
  page?: string
  /** The page load id (`x-nivaro-load`). */
  load?: string
  /** The cron job / flow run / import run that owns a write or partner call. */
  run?: string
}
interface RecentError {
  at: string
  status: number
  code: string | null
  route: string
  caller: CallerKey
  record: string | null
}
interface RecentWrite {
  at: string
  action: 'create' | 'update' | 'delete'
  record: string
  fields: string[]
  caller: CallerKey
  via: string
}

interface Ring extends CountRing {
  // counts: RING_SECONDS * SLOTS
  lat: Float32Array
  latN: number
  latI: number
}
interface EntityState extends Ring {
  lane: TrafficLane
  entity: string
  routes: Map<string, MinuteSeries>
  callers: Map<CallerKey, MinuteSeries>
  downs: Map<string, MinuteSeries>
  errors: RecentError[]
  writes: RecentWrite[]
  lastSeen: number
}
interface NodeState extends Ring {
  label: string
}

// ── per-store state (#1132) ──────────────────────────────────────────────────
// Everything the map holds lives in a store: one per process self-hosted, one per tenant in
// cloud mode (currentStoreId()). The names below are views onto the CURRENT store's maps, so the
// recording / reading code reads exactly as it did with module globals.
interface MapStore {
  entities: Map<string, EntityState>
  laneCount: Map<TrafficLane, number>
  callers: Map<CallerKey, NodeState>
  downs: Map<string, NodeState>
  partnerNames: Map<number, string>
  /** Label + kind of down nodes recorded through noteDown (and their sweep). */
  downMeta: Map<string, { label?: string; kind?: string }>
  /** Label + kind of non-request sources recorded through noteSource (keys in `callers`). */
  sourceMeta: Map<string, { label?: string; kind?: string }>
  edgesIn: Map<string, number> // this second only
  edgesOut: Map<string, number>
  pendingEvents: TrafficEventWire[]
  bufferDropped: number
  frameNo: number
}
const mapStores = new Map<string, MapStore>()
function mkStore(): MapStore {
  return {
    entities: new Map(),
    laneCount: new Map(),
    callers: new Map(),
    downs: new Map(),
    partnerNames: new Map(),
    downMeta: new Map(),
    sourceMeta: new Map(),
    edgesIn: new Map(),
    edgesOut: new Map(),
    pendingEvents: [],
    bufferDropped: 0,
    frameNo: 0
  }
}
/** The current store (created on first use; outside any store reads/writes `default`). */
function S(): MapStore {
  const id = currentStoreId() || DEFAULT_STORE
  let st = mapStores.get(id)
  if (!st) {
    st = mkStore()
    mapStores.set(id, st)
  }
  return st
}
/** A Map-typed view that resolves to the current store's map on every access. */
function storeMap<K, V>(pick: (st: MapStore) => Map<K, V>): Map<K, V> {
  return new Proxy(new Map<K, V>(), {
    get(_t, prop) {
      const m = pick(S())
      const v = Reflect.get(m, prop, m)
      return typeof v === 'function' ? v.bind(m) : v
    }
  })
}
const entities = storeMap((st) => st.entities)
const laneCount = storeMap((st) => st.laneCount)
const callers = storeMap((st) => st.callers)
const downs = storeMap((st) => st.downs)
const partnerNames = storeMap((st) => st.partnerNames)
const downMeta = storeMap((st) => st.downMeta)
const sourceMeta = storeMap((st) => st.sourceMeta)
const edgesIn = storeMap((st) => st.edgesIn)
const edgesOut = storeMap((st) => st.edgesOut)
export const EVENT_BUFFER_CAP = 200
let nowSec = Math.floor(Date.now() / 1000)
const bootedAt = Date.now()
/** Store ids holding map state (the emitter, the sweep and cluster relays walk them). */
export function trafficStoreIds(): string[] {
  return [...mapStores.keys()]
}

function mkRing(): Ring {
  return {
    counts: new Int32Array(RING_SECONDS * SLOTS),
    lat: new Float32Array(LAT_SAMPLES),
    latN: 0,
    latI: 0,
    lastSec: nowSec,
    touchedSec: nowSec
  }
}
function mkNode(label: string): NodeState {
  return { ...mkRing(), label }
}

function isStale(sec: number): boolean {
  return sec < nowSec - (RING_SECONDS - 1)
}
function bump(r: Ring, sec: number, slot: number, n = 1): void {
  ringBump(r, sec, slot, SLOTS, n)
}
function sample(r: Ring, ms: number): void {
  r.lat[r.latI] = ms
  r.latI = (r.latI + 1) % LAT_SAMPLES
  if (r.latN < LAT_SAMPLES) r.latN++
}
function sumWindow(r: Ring, windowS: number, sec: number): number[] {
  return ringSum(r, windowS, sec, SLOTS)
}
function seriesOf(r: Ring, windowS: number, sec: number, points: number): number[] {
  return ringSeries(r, windowS, sec, points, SLOTS, K.req)
}
function pct(r: Ring, p: number): number {
  if (!r.latN) return 0
  const a = Array.from(r.lat.subarray(0, r.latN)).sort((x, y) => x - y)
  return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))])
}
/** R29a: a JSON `code` string wins; else the first SHOUTY_TOKEN; else null. */
export function errorCode(text: string | null | undefined): string | null {
  if (!text) return null
  try {
    const j = JSON.parse(text)
    if (j && typeof j.code === 'string' && /^[A-Z_]{4,}$/.test(j.code)) return j.code.slice(0, 60)
  } catch {
    /* not JSON */
  }
  const m = text.match(/[A-Z_]{4,}/)
  return m ? m[0].slice(0, 60) : null
}
const ID_SEG = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
/** R29b: the first id-shaped path segment, if any. */
function recordOfPath(path: string): string | null {
  for (const seg of normalizePath(path).split('/')) if (ID_SEG.test(seg)) return seg.slice(0, 80)
  return null
}
/** R29c: a route template without a method (the trace does not carry one). */
function templateOfHint(hint: string): string {
  return routeTemplate('GET', hint).slice(4)
}

function getEntity(lane: TrafficLane, entity: string): EntityState {
  let key = entityKey(lane, entity)
  let e = entities.get(key)
  if (e) return e
  const n = laneCount.get(lane) ?? 0
  if (n >= LANE_ENTITY_CAP) {
    entity = '__other__'
    key = entityKey(lane, entity)
    e = entities.get(key)
    if (e) return e
  }
  e = {
    ...mkRing(),
    lane,
    entity,
    routes: new Map(),
    callers: new Map(),
    downs: new Map(),
    errors: [],
    writes: [],
    lastSeen: nowSec
  }
  entities.set(key, e)
  if (entity !== '__other__') laneCount.set(lane, n + 1)
  return e
}
function getCaller(key: CallerKey): NodeState {
  let c = callers.get(key)
  if (!c) {
    c = mkNode(key)
    callers.set(key, c)
  }
  return c
}
function getDown(id: string, label?: string): NodeState {
  let d = downs.get(id)
  if (!d) {
    d = mkNode(label ?? id)
    downs.set(id, d)
  } else if (label) d.label = label
  return d
}
/** The request id of the current trace, when a request (not a background job) is behind it. */
function currentRequestId(): string | undefined {
  const meta = currentTraceMeta()
  return meta && meta.request !== false && meta.id ? meta.id : undefined
}
/** Ids for an event recorded off a Fastify request: request id, node, and the client facts. */
function requestIds(
  req: unknown
): Pick<TrafficEventWire, 'rid' | 'node' | 'tab' | 'build' | 'app' | 'page' | 'load'> {
  const rid = (req as { requestId?: unknown } | undefined)?.requestId
  return {
    rid: typeof rid === 'string' && rid ? rid.slice(0, 64) : currentRequestId(),
    node: INSTANCE_ID,
    ...clientFactsOf(req)
  }
}
/** Ids for an event with no request object in hand: node, plus the trace / source in context. */
function contextIds(): Pick<TrafficEventWire, 'rid' | 'node' | 'run'> {
  const out: Pick<TrafficEventWire, 'rid' | 'node' | 'run'> = { node: INSTANCE_ID }
  const rid = currentRequestId()
  if (rid) out.rid = rid
  const run = currentTrafficSource()?.id
  if (run) out.run = String(run).slice(0, 120)
  return out
}
/** Taps add ticker events here; they share the bounded buffer and its priority rule. */
export function pushTrafficEvent(ev: TrafficEventWire): void {
  if (noStore()) return
  try {
    // A tap event inherits the ids of whatever is in context (the request / source it rode on).
    const ids = contextIds()
    if (ev.node == null) ev.node = ids.node
    if (ev.rid == null && ids.rid) ev.rid = ids.rid
    if (ev.run == null && ids.run) ev.run = ids.run
    pushEvent(ev)
  } catch {
    /* never */
  }
}
function pushEvent(ev: TrafficEventWire): void {
  const st = S()
  const pendingEvents = st.pendingEvents
  pendingEvents.push(ev)
  if (pendingEvents.length <= EVENT_BUFFER_CAP) return
  // Over the cap: drop the lowest-priority (then oldest) event, error>create>delete>update>read.
  let worst = 0
  for (let i = 1; i < pendingEvents.length; i++) {
    if (PRIORITY[pendingEvents[i].kind] > PRIORITY[pendingEvents[worst].kind]) worst = i
  }
  pendingEvents.splice(worst, 1)
  st.bufferDropped++
}
/** The request's integration chain id (plugins/chain.ts stamps `req.chainId`). */
/** Drop undefined keys, so an event never carries `rid: undefined` on the wire. */
function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const k of Object.keys(o) as Array<keyof T>) {
    if (o[k] !== undefined) out[k] = o[k]
  }
  return out
}
function chainOfReq(req: unknown): string | undefined {
  const id = (req as { chainId?: unknown } | undefined)?.chainId
  return typeof id === 'string' && id ? id.slice(0, 64) : undefined
}
function secOf(atMs: number): number {
  const s = Math.floor(atMs / 1000)
  return s > nowSec ? nowSec : s
}

// ── extension route matcher ───────────────────────────────────────────────────
let extRoutes: Map<string, Array<{ method: string; url: string }>> = new Map()
let extCompiled: Array<{ ext: string; method: string; re: RegExp }> = []
let extSig = ''
export function setExtensionRoutes(map: Map<string, Array<{ method: string; url: string }>>): void {
  extRoutes = map
  extSig = ''
}
const listIds = new WeakMap<object, number>()
let nextListId = 1
/**
 * R27: a cheap signature so a growing (or reloaded) live map recompiles — O(extensions), never
 * O(routes): per extension its route list's identity (a reload replaces the array) + length.
 */
function extSignature(): string {
  let sig = String(extRoutes.size)
  for (const list of extRoutes.values()) {
    let id = listIds.get(list)
    if (id === undefined) {
      id = nextListId++
      listIds.set(list, id)
    }
    sig += `|${id}:${list.length}`
  }
  return sig
}
function routeRegex(url: string): RegExp {
  const segs = url
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/$/, '$1')
    .split('/')
    .slice(1)
  let re = ''
  for (const s of segs) {
    if (s === '*') re += '(?:/.*)?'
    else if (s.startsWith(':') && s.endsWith('?')) re += '(?:/[^/]+)?'
    else if (s.startsWith(':')) re += '/[^/]+'
    else re += `/${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  }
  return new RegExp(`^${re || '/'}$`)
}
function compileExt(): Array<{ ext: string; method: string; re: RegExp }> {
  const sig = extSignature()
  if (sig === extSig) return extCompiled
  const out: Array<{ ext: string; method: string; re: RegExp }> = []
  for (const [ext, list] of extRoutes) {
    for (const r of list) {
      try {
        out.push({ ext, method: r.method.toUpperCase(), re: routeRegex(r.url) })
      } catch {
        /* a malformed route never breaks matching */
      }
    }
  }
  extCompiled = out
  extSig = sig
  return out
}
/** `method` null = any method (an outbound call's trace carries a URL, not a verb). */
export function matchExtensionRoute(method: string | null, path: string): string | null {
  if (extRoutes.size === 0) return null
  const p = normalizePath(path)
  const m = method ? method.toUpperCase() : null
  for (const r of compileExt()) if ((m === null || r.method === m) && r.re.test(p)) return r.ext
  return null
}

// ── cache-hit marker (set by the custom-query / widget render routes) ────────
const CACHE_MARK = '__nvrTrafficCacheHit'
export function markCacheHit(req: object): void {
  ;(req as Record<string, unknown>)[CACHE_MARK] = true
}
export function hasCacheHit(req: object): boolean {
  return (req as Record<string, unknown>)[CACHE_MARK] === true
}

// ── writers ──────────────────────────────────────────────────────────────────
function applyRequest(
  c: Classified,
  ev: TrafficRequestEvent,
  caller: CallerKey,
  route: string,
  code: string | null
): { e: EntityState; event?: TrafficEventWire } | null {
  if (isStale(Math.floor(ev.at / 1000))) return null
  const sec = secOf(ev.at)
  const e = getEntity(c.lane, c.entity)
  const isErr = ev.status >= 400
  bump(e, sec, K.req)
  if (isErr) bump(e, sec, K.error)
  else if (c.kind === 'read') bump(e, sec, K.read)
  sample(e, ev.latencyMs)
  e.lastSeen = sec
  bumpMinute(e.routes, route, sec)
  bumpMinute(e.callers, caller, sec)
  const downIds: string[] = ev.cacheHit ? c.down.map((d) => (d === 'db' ? 'redis' : d)) : c.down
  for (const d of downIds) {
    bumpMinute(e.downs, d, sec)
    const dn = getDown(d)
    bump(dn, sec, K.req)
    sample(dn, ev.latencyMs)
    edgesOut.set(`${c.lane}>${d}`, (edgesOut.get(`${c.lane}>${d}`) ?? 0) + 1)
  }
  const cn = getCaller(caller)
  bump(cn, sec, K.req)
  if (isErr) bump(cn, sec, K.error)
  edgesIn.set(`${caller}>${c.lane}`, (edgesIn.get(`${caller}>${c.lane}`) ?? 0) + 1)
  let event: TrafficEventWire | undefined
  if (isErr) {
    const record = recordOfPath(ev.path)
    const err: RecentError = {
      at: new Date(ev.at).toISOString(),
      status: ev.status,
      code,
      route,
      caller,
      record
    }
    e.errors.unshift(err)
    if (e.errors.length > RECENT_CAP) e.errors.pop()
    event = {
      t: ev.at,
      lane: c.lane,
      entity: e.entity,
      kind: 'error',
      caller,
      route,
      status: ev.status,
      ms: ev.latencyMs,
      code,
      record: record ?? undefined,
      chain: chainOfReq(ev.req),
      ...definedOnly(requestIds(ev.req))
    }
    pushEvent(event)
  } else if (c.kind === 'read') {
    event = {
      t: ev.at,
      lane: c.lane,
      entity: e.entity,
      kind: 'read',
      caller,
      route,
      status: ev.status,
      ms: ev.latencyMs,
      ...definedOnly(requestIds(ev.req))
    }
    pushEvent(event)
  }
  return { e, event }
}

/**
 * Classify without the extension matcher first; only a request that falls through to the
 * `other` lane is matched against extension routes (built-in lanes always win, so the result is
 * identical to matching up front — this just keeps the matcher off the hot path).
 */
function classifyLazy(input: ClassifyInput, matchMethod: string | null): Classified | null {
  const c = classifyRequest(input)
  if (c?.lane !== 'other') return c
  const extensionId = matchExtensionRoute(matchMethod, input.path)
  return extensionId ? classifyRequest({ ...input, extensionId }) : c
}

/**
 * No store to record into: cloud mode outside a tenant request (R31). Self-hosted always has one;
 * a cloud tenant records into its own store (#1132).
 */
function noStore(): boolean {
  return currentStoreId() === NO_STORE
}

export function noteRequest(ev: TrafficRequestEvent & { errorCode?: string | null }): void {
  const sid = storeForRequest(ev.req)
  if (sid === NO_STORE) return
  withTrafficStore(sid, () => recordRequest(ev))
}
function recordRequest(ev: TrafficRequestEvent & { errorCode?: string | null }): void {
  try {
    const c = classifyLazy(
      {
        method: ev.method,
        path: ev.path,
        graphqlOperation: ev.graphqlOperation,
        graphqlKind: ev.graphqlKind
      },
      ev.method
    )
    if (!c) return
    const caller = callerKeyFor({
      authMethod: ev.authMethod,
      apiKeyId: ev.apiKeyId,
      userId: ev.userId
    })
    const route = routeTemplate(ev.method, ev.path, ev.graphqlOperation)
    const code = ev.status >= 400 ? errorCode(ev.errorCode) : null
    const applied = applyRequest(c, ev, caller, route, code)
    if (applied) {
      const { e, event } = applied
      const ctx = {
        ev,
        lane: e.lane,
        entity: e.entity,
        entityKey: entityKey(e.lane, e.entity),
        kind: c.kind,
        caller,
        route,
        isError: ev.status >= 400,
        code,
        sec: secOf(ev.at),
        event
      }
      eachTap((t) => t.onRequest?.(ctx))
    }
  } catch {
    /* the map must never affect a response */
  }
}

function callerFromTrace(): { caller: CallerKey; via: string } {
  const tc = currentTraceCaller()
  const meta = currentTraceMeta()
  if (!tc && !meta) return { caller: 'cron', via: 'other' }
  const caller = callerKeyFor({
    authMethod: tc?.auth ?? null,
    apiKeyId: tc?.apiKeyId ?? null,
    userId: meta?.userId ?? null
  })
  const hint = meta?.urlHint ?? ''
  const via = hint.includes('/transition')
    ? 'transition'
    : hint.includes('graphql')
      ? 'graphql'
      : hint.includes('/api/inbound/')
        ? 'inbound'
        : hint.includes('/api/items/')
          ? 'items'
          : 'other'
  return { caller: caller === 'anon' && !hint ? 'cron' : caller, via }
}

export function noteWrite(ev: TrafficWriteEvent): void {
  if (noStore()) return
  try {
    if (isStale(Math.floor(ev.at / 1000))) return
    const sec = secOf(ev.at)
    const lane: TrafficLane = /^(nivaro_|directus_|sys)/.test(ev.collection) ? 'system' : 'items'
    const e = getEntity(lane, ev.collection.slice(0, 120))
    const slot = ev.action === 'create' ? K.create : ev.action === 'delete' ? K.delete : K.update
    bump(e, sec, slot)
    e.lastSeen = sec
    let { caller, via } = callerFromTrace()
    const src = currentTrafficSource()
    if (src) {
      // #1105/#1106/#1143: a cron job, flow run or import run owns this write, even inside a
      // request (a flow an item write fired).
      caller = src.id
      via = src.kind
      bumpSource(src.id, src.label, src.kind, sec, e, true)
    } else if (caller === 'cron') {
      // R4: a write inside a request is already counted by noteRequest.
      bumpMinute(e.callers, caller, sec)
      bump(getCaller(caller), sec, K.req)
      edgesIn.set(`cron>${lane}`, (edgesIn.get(`cron>${lane}`) ?? 0) + 1)
    }
    const hint = currentTraceMeta()?.urlHint
    const route = hint ? templateOfHint(hint) : `${via} write`
    const fields = ev.changedFields.slice(0, 20).map((f) => String(f).slice(0, 80))
    const w: RecentWrite = {
      at: new Date(ev.at).toISOString(),
      action: ev.action,
      record: String(ev.item).slice(0, 80),
      fields,
      caller,
      via
    }
    e.writes.unshift(w)
    if (e.writes.length > RECENT_CAP) e.writes.pop()
    const event: TrafficEventWire = {
      t: ev.at,
      lane,
      entity: e.entity,
      kind: ev.action,
      caller,
      route,
      record: w.record,
      fields,
      via,
      chain: currentChain()?.chain_id,
      // Client facts are not in hand here (no request object) — only the ids.
      ...contextIds()
    }
    pushEvent(event)
    const ctx = {
      ev,
      lane,
      entity: e.entity,
      entityKey: entityKey(lane, e.entity),
      caller,
      via,
      route,
      sec,
      event
    }
    eachTap((t) => t.onWrite?.(ctx))
  } catch {
    /* never */
  }
}

export function noteOutbound(ev: TrafficOutboundEvent): void {
  if (noStore()) return
  try {
    if (isStale(Math.floor(ev.at / 1000))) return
    const sec = secOf(ev.at)
    partnerNames.set(ev.apiId, ev.apiName)
    // #1114: an extension-declared node (MDSi, MWF…) takes the call instead of `ext:<apiId>`.
    const node = resolveOutboundNode(ev)
    const id = node?.id ?? `ext:${ev.apiId}`
    if (node) downMeta.set(id, { label: node.label, kind: 'partner' })
    const dn = getDown(id, node?.label ?? ev.apiName)
    const failed = ev.status == null || ev.status >= 400
    bump(dn, sec, K.req)
    if (failed) bump(dn, sec, K.error)
    sample(dn, ev.durationMs)
    const meta = currentTraceMeta()
    const hint = meta?.urlHint ?? null
    let c: Classified | null = null
    if (hint) {
      // The trace carries a URL, not a verb: try GET (+ extension routes, any verb), then POST
      // for routes only POST classifies.
      c = classifyLazy({ method: 'GET', path: hint }, null)
      if (!c || c.lane === 'other') {
        const p = classifyRequest({ method: 'POST', path: hint })
        if (p && (!c || p.lane !== 'other')) c = p
      }
    }
    // R36: no request behind the call — a background job. `other/__background__` can never
    // collide with a real route entity (`/api/cron` is `other/cron`).
    const e = c ? getEntity(c.lane, c.entity) : getEntity('other', BACKGROUND_ENTITY)
    e.lastSeen = sec
    bumpMinute(e.downs, id, sec)
    edgesOut.set(`${e.lane}>${id}`, (edgesOut.get(`${e.lane}>${id}`) ?? 0) + 1)
    const src = currentTrafficSource()
    if (src) {
      bumpSource(src.id, src.label, src.kind, sec, e, !failed)
    } else if (!meta) {
      // No request behind it: a cron / background call (spec §4).
      const cn = getCaller('cron')
      bump(cn, sec, K.req)
      if (failed) bump(cn, sec, K.error)
      edgesIn.set(`cron>${e.lane}`, (edgesIn.get(`cron>${e.lane}`) ?? 0) + 1)
    }
    const ctx = { ev, downId: id, entityKey: entityKey(e.lane, e.entity), failed, sec }
    eachTap((t) => t.onOutbound?.(ctx))
  } catch {
    /* never */
  }
}

/** `<lane>/<entity>` → the entity state (created; lane cap applies); null when malformed. */
function entityOfKey(key: string): EntityState | null {
  const cut = key.indexOf('/')
  if (cut <= 0) return null
  const lane = key.slice(0, cut) as TrafficLane
  if (!LANES.some((l) => l.id === lane)) return null
  const entity = key.slice(cut + 1).slice(0, 120)
  return entity ? getEntity(lane, entity) : null
}

export interface TrafficDownCall {
  /** Down node id (e.g. `mail`, `ai:gateway`); `db` / `redis` / `store` / `ext:*` are the map's. */
  id: string
  label?: string
  /** Snapshot down-row kind; default 'service'. */
  kind?: string
  ok: boolean
  ms?: number
  /** Epoch ms; default now. */
  at?: number
  /** `<lane>/<entity>` the call belongs to; absent = `other/__background__`. */
  entityKey?: string | null
}

/**
 * A call into any downstream node (mail, SMS, AI provider, webhook receiver…): same ring and
 * edge semantics as a partner call, without partner specifics. Never counts a caller — a source
 * that should appear as one records itself with noteSource.
 */
export function noteDown(d: TrafficDownCall): void {
  if (noStore()) return
  try {
    const at = d.at ?? Date.now()
    if (isStale(Math.floor(at / 1000))) return
    const id = String(d.id).slice(0, 120)
    if (!id) return
    const sec = secOf(at)
    if (d.label || d.kind) {
      const meta = downMeta.get(id) ?? {}
      if (d.label) meta.label = d.label.slice(0, 120)
      if (d.kind) meta.kind = d.kind.slice(0, 40)
      downMeta.set(id, meta)
    }
    const dn = getDown(id, d.label)
    bump(dn, sec, K.req)
    if (!d.ok) bump(dn, sec, K.error)
    if (d.ms != null && Number.isFinite(d.ms)) sample(dn, d.ms)
    const e =
      (d.entityKey ? entityOfKey(d.entityKey) : null) ?? getEntity('other', BACKGROUND_ENTITY)
    e.lastSeen = sec
    bumpMinute(e.downs, id, sec)
    edgesOut.set(`${e.lane}>${id}`, (edgesOut.get(`${e.lane}>${id}`) ?? 0) + 1)
  } catch {
    /* never */
  }
}

export interface TrafficSourceCall {
  /** Caller-ring key, e.g. `cron:<jobId>`, `import:<runId>`, `socket`. Never `k…` / `u…`. */
  id: string
  label?: string
  /** e.g. 'cron', 'import', 'socket'; default 'source'. */
  kind?: string
  at?: number
  /** `<lane>/<entity>` it fed; adds the `<id>><lane>` edge and the entity's caller row. */
  entityKey?: string | null
  /** false = counts as an error. */
  ok?: boolean
}

/** One unit of source traffic: the callers ring under `id`, and the entity's caller row + edge. */
function bumpSource(
  id: string,
  label: string | undefined,
  kind: string | undefined,
  sec: number,
  e: EntityState | null,
  ok: boolean,
  edgeKey?: string
): void {
  let meta = sourceMeta.get(id)
  if (!meta) {
    meta = {}
    sourceMeta.set(id, meta)
  }
  if (label && meta.label !== label) meta.label = label.slice(0, 120)
  if (kind && meta.kind !== kind) meta.kind = kind.slice(0, 40)
  const cn = getCaller(id)
  bump(cn, sec, K.req)
  if (!ok) bump(cn, sec, K.error)
  if (e) {
    e.lastSeen = sec
    bumpMinute(e.callers, id, sec)
    const edge = edgeKey ?? `${id}>${e.lane}`
    edgesIn.set(edge, (edgesIn.get(edge) ?? 0) + 1)
  }
}

/**
 * Traffic from a non-request source (a cron job, the import worker, a socket) into the callers
 * ring under its own key. The existing `cron` caller is left untouched.
 */
export function noteSource(s: TrafficSourceCall): void {
  if (noStore()) return
  try {
    const at = s.at ?? Date.now()
    if (isStale(Math.floor(at / 1000))) return
    const id = String(s.id).slice(0, 120)
    if (!id) return
    const sec = secOf(at)
    const e = s.entityKey ? entityOfKey(s.entityKey) : null
    bumpSource(id, s.label, s.kind, sec, e, s.ok !== false)
  } catch {
    /* never */
  }
}

// ── socket lane (#1104) ───────────────────────────────────────────────────────
/** The source every socket event is attributed to (the browsers' socket connections). */
export const SOCKET_SOURCE = 'socket:browsers'
const SOCKET_EDGE = `${SOCKET_SOURCE}>socket`
const SOCKET_EVENT_RE = /^[a-z0-9][a-z0-9:_.-]{0,59}$/i
/** `record:join` → `record.join` (entity names carry no colon); anything odd folds to `other`. */
export function socketEntity(event: string): string {
  const ev = String(event ?? '')
  return SOCKET_EVENT_RE.test(ev) ? ev.toLowerCase().replace(/:/g, '.') : 'other'
}
/** Event name → entity, memoised (bounded) so a busy socket never allocates per event. */
const socketEntityCache = new Map<string, string>()
function socketEntityCached(event: string): string {
  const hit = socketEntityCache.get(event)
  if (hit !== undefined) return hit
  const v = socketEntity(event)
  if (socketEntityCache.size < 200) socketEntityCache.set(event, v)
  return v
}
/**
 * One inbound socket.io event. Counter bumps only — no event object, no ticker row — so the
 * socket middleware stays free while nobody watches the map.
 */
export function noteSocket(event: string, at = Date.now()): void {
  if (noStore()) return
  try {
    if (isStale(Math.floor(at / 1000))) return
    const sec = secOf(at)
    const e = getEntity('socket', socketEntityCached(event))
    bump(e, sec, K.req)
    bump(e, sec, K.read)
    e.lastSeen = sec
    bumpSource(SOCKET_SOURCE, 'Browser sockets', 'socket', sec, e, true, SOCKET_EDGE)
  } catch {
    /* never */
  }
}

// ── extension-declared downstream nodes (#1114) ─────────────────────────────
export type OutboundNodeResolver = (
  ev: TrafficOutboundEvent
) => { id: string; label: string } | null
let outboundResolver: OutboundNodeResolver | null = null
/** Set (or clear) the function that maps a partner call onto an extension-declared node. */
export function setOutboundNodeResolver(fn: OutboundNodeResolver | null): void {
  outboundResolver = fn
}
function resolveOutboundNode(ev: TrafficOutboundEvent): { id: string; label: string } | null {
  if (!outboundResolver) return null
  try {
    const n = outboundResolver(ev)
    return n?.id ? { id: String(n.id).slice(0, 120), label: String(n.label || n.id) } : null
  } catch {
    return null
  }
}

/** The ring clock (epoch seconds) — routes asking taps for figures pass it on. */
export function currentTrafficSec(): number {
  return nowSec
}

/**
 * #1149 — the `n` busiest entities of the current store over the window, each with its request
 * series folded into `points` buckets (oldest first), for the correlated-spikes route.
 */
export function entityRequestSeries(
  windowS: number,
  points: number,
  n: number
): Array<{ key: string; total: number; series: number[] }> {
  const sec = nowSec
  const rows: Array<{ key: string; total: number; e: EntityState }> = []
  for (const [key, e] of entities) {
    const total = sumWindow(e, windowS, sec)[K.req]
    if (total > 0) rows.push({ key, total, e })
  }
  rows.sort((a, b) => b.total - a.total)
  return rows
    .slice(0, n)
    .map((r) => ({ key: r.key, total: r.total, series: seriesOf(r.e, windowS, sec, points) }))
}

// ── clock ────────────────────────────────────────────────────────────────────
export function advanceTo(sec: number): void {
  if (sec > nowSec) nowSec = sec
}
function takeEvents(): { events: TrafficEventWire[]; dropped: number } {
  const st = S()
  const out = { events: st.pendingEvents, dropped: st.bufferDropped }
  st.pendingEvents = []
  st.bufferDropped = 0
  return out
}
export function drainEvents(): TrafficEventWire[] {
  return takeEvents().events
}
/** Unwatched tick: drop the per-second accumulators so the first frame after a watcher joins
 *  never carries an idle backlog (R3). */
export function discardTick(): void {
  takeEvents()
  edgesIn.clear()
  edgesOut.clear()
}
const PRIORITY: Record<string, number> = { error: 0, create: 1, delete: 2, update: 3, read: 4 }
function pickEvents(all: TrafficEventWire[]): { events: TrafficEventWire[]; dropped: number } {
  if (all.length <= EVENTS_PER_FRAME) return { events: all, dropped: 0 }
  const sorted = all.slice().sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.t - b.t)
  return { events: sorted.slice(0, EVENTS_PER_FRAME), dropped: all.length - EVENTS_PER_FRAME }
}

export interface FrameWire {
  v: 1
  at: string
  instance: string
  node_scope: string
  frame: number
  window_s: 1
  entities: Record<string, number[]>
  callers: Record<string, number[]>
  down: Record<string, number[]>
  /** Labels of the down nodes in this frame that are not plain ids (partners, declared nodes). */
  down_labels?: Record<string, string>
  edges_in: Record<string, number>
  edges_out: Record<string, number>
  events: TrafficEventWire[]
  events_dropped?: number
  sockets: number
  journal_seq: number | null
  /** Tap figures for this second, by tap id (absent when no tap sent any). */
  ext?: Record<string, unknown>
  /** The API process that built the frame (#1098; set by the emitter). */
  node?: string
}

function secondOf(r: Ring, sec: number): number[] {
  return ringSecond(r, sec, SLOTS)
}

export function buildFrame(
  sec: number,
  opts: { sockets: number; journalSeq: number | null }
): FrameWire {
  advanceTo(sec)
  const frameNo = ++S().frameNo
  const ents: Record<string, number[]> = {}
  for (const [key, e] of entities) {
    if (e.touchedSec < sec) continue
    const s = secondOf(e, sec)
    if (s[K.req] + s[K.create] + s[K.update] + s[K.delete] + s[K.error] === 0) continue
    ents[key] = [...s, pct(e, 0.95)]
  }
  const cs: Record<string, number[]> = {}
  for (const [key, c] of callers) {
    if (c.touchedSec < sec) continue
    const s = secondOf(c, sec)
    if (s[K.req]) cs[key] = [s[K.req], s[K.error]]
  }
  const ds: Record<string, number[]> = {}
  // Names travel with the frame: a partner first seen mid-session must not read as `ext:9`
  // until the page's next (throttled, cached) catalog read.
  const dl: Record<string, string> = {}
  for (const [key, d] of downs) {
    if (d.touchedSec < sec) continue
    const s = secondOf(d, sec)
    if (!s[K.req]) continue
    ds[key] = [s[K.req], s[K.error], pct(d, 0.95)]
    if (d.label && d.label !== key && !DOWN_LABELS[key]) dl[key] = d.label.slice(0, 120)
  }
  // Accepted: edges/events for a frame can lead the entity counts by up to 1 s.
  const taken = takeEvents()
  const picked = pickEvents(taken.events)
  const events = picked.events
  const dropped = picked.dropped + taken.dropped
  const frame: FrameWire = {
    v: 1,
    at: new Date(sec * 1000).toISOString(),
    instance: instanceKey(),
    node_scope: NODE_SCOPE,
    frame: frameNo,
    window_s: 1,
    entities: ents,
    callers: cs,
    down: ds,
    edges_in: Object.fromEntries(edgesIn),
    edges_out: Object.fromEntries(edgesOut),
    events,
    sockets: opts.sockets,
    journal_seq: opts.journalSeq
  }
  if (dropped) frame.events_dropped = dropped
  if (Object.keys(dl).length) frame.down_labels = dl
  const ext = collectTaps((t) => t.frame?.(sec))
  if (ext) frame.ext = ext
  edgesIn.clear()
  edgesOut.clear()
  return frame
}

// ── snapshot ─────────────────────────────────────────────────────────────────
export interface SnapshotEntity {
  key: string
  lane: TrafficLane
  entity: string
  label: string
  system: boolean
  req: number
  read: number
  create: number
  update: number
  delete: number
  error: number
  p50: number
  p95: number
  series: number[]
  routes: Array<{ route: string; n: number }>
  callers: Array<{ key: CallerKey; n: number }>
  down: Record<string, number>
  recent_errors: RecentError[]
  recent_writes: RecentWrite[]
  /** Tap figures for this entity, by tap id (absent when none). */
  ext?: Record<string, unknown>
}
export interface TrafficSnapshot {
  instance: string
  node_scope: string
  at: string
  window_s: number
  uptime_s: number
  frame: number
  lanes: Array<{ id: TrafficLane; label: string; route_hint: string }>
  entities: SnapshotEntity[]
  callers: Array<{ key: CallerKey; req: number; error: number }>
  down: Array<{
    id: string
    label: string
    /** 'db' | 'cache' | 'storage' | 'partner' for the map's own nodes; noteDown kinds else. */
    kind: string
    req: number
    error: number
    p95: number
  }>
  totals: {
    req: number
    read: number
    create: number
    update: number
    delete: number
    error: number
    p50: number
    p95: number
    outbound_req: number
    outbound_error: number
  }
  sockets: { count: number; users: number }
  journal_seq: number | null
  /** Non-request sources (noteSource) with traffic in the window (absent when none). */
  sources?: Array<{ id: string; label: string; kind: string; req: number; error: number }>
  /** Tap figures, by tap id (absent when none). */
  ext?: Record<string, unknown>
  /** The API process the snapshot describes (#1098; absent before the emitter starts). */
  node?: string
}

function topOf(
  map: Map<string, MinuteSeries>,
  windowS: number,
  sec: number,
  n: number
): Array<[string, number]> {
  return topMinutes(map, windowS, sec, n)
}
function downKind(id: string): string {
  if (id === 'db') return 'db'
  if (id === 'redis') return 'cache'
  if (id === 'store') return 'storage'
  if (id.startsWith('ext:')) return 'partner'
  return downMeta.get(id)?.kind ?? 'service'
}
const DOWN_LABELS: Record<string, string> = {
  db: 'SQL Server',
  redis: 'Redis',
  store: 'File storage'
}

export function buildSnapshot(
  windowS: 60 | 300 | 900,
  opts: { sockets: number; users: number; journalSeq: number | null }
): TrafficSnapshot {
  const sec = nowSec
  const out: SnapshotEntity[] = []
  const totals = [0, 0, 0, 0, 0, 0]
  const allLat: number[] = []
  const entityExt = (key: string) => collectTaps((t) => t.entitySnapshot?.(key, windowS, sec))
  for (const [key, e] of entities) {
    const s = sumWindow(e, windowS, sec)
    const downTop = topOf(e.downs, windowS, sec, TOP_KEYS_CAP)
    if (s.every((v) => v === 0) && downTop.length === 0) continue
    for (let k = 0; k < SLOTS; k++) totals[k] += s[k]
    allLat.push(...Array.from(e.lat.subarray(0, e.latN)))
    const row: SnapshotEntity = {
      key,
      lane: e.lane,
      entity: e.entity,
      label:
        e.entity === '__other__'
          ? 'other'
          : e.entity === BACKGROUND_ENTITY
            ? 'Background jobs'
            : e.entity,
      system: e.lane === 'system',
      req: s[K.req],
      read: s[K.read],
      create: s[K.create],
      update: s[K.update],
      delete: s[K.delete],
      error: s[K.error],
      p50: pct(e, 0.5),
      p95: pct(e, 0.95),
      series: seriesOf(e, windowS, sec, 60),
      routes: topOf(e.routes, windowS, sec, 5).map(([route, n]) => ({ route, n })),
      callers: topOf(e.callers, windowS, sec, 5).map(([k, n]) => ({ key: k, n })),
      down: Object.fromEntries(downTop),
      recent_errors: e.errors.slice(),
      recent_writes: e.writes.slice()
    }
    const ext = entityExt(key)
    if (ext) row.ext = ext
    out.push(row)
  }
  out.sort((a, b) => b.req - a.req)
  const sourceRows: NonNullable<TrafficSnapshot['sources']> = []
  const callerRows = [...callers]
    .map(([key, c]) => {
      const s = sumWindow(c, windowS, sec)
      const meta = sourceMeta.get(key)
      if (meta && s[K.req] > 0) {
        sourceRows.push({
          id: key,
          label: meta.label ?? key,
          kind: meta.kind ?? 'source',
          req: s[K.req],
          error: s[K.error]
        })
      }
      return { key, req: s[K.req], error: s[K.error] }
    })
    .filter((c) => c.req > 0)
    .sort((a, b) => b.req - a.req)
  let outboundReq = 0
  let outboundErr = 0
  const downRows = [...downs]
    .map(([id, d]) => {
      const s = sumWindow(d, windowS, sec)
      if (id.startsWith('ext:')) {
        outboundReq += s[K.req]
        outboundErr += s[K.error]
      }
      return {
        id,
        label: DOWN_LABELS[id] ?? d.label,
        kind: downKind(id),
        req: s[K.req],
        error: s[K.error],
        p95: pct(d, 0.95)
      }
    })
    .filter((d) => d.req > 0)
  allLat.sort((a, b) => a - b)
  const q = (p: number) =>
    allLat.length
      ? Math.round(allLat[Math.min(allLat.length - 1, Math.floor(allLat.length * p))])
      : 0
  const snap: TrafficSnapshot = {
    instance: instanceKey(),
    node_scope: NODE_SCOPE,
    at: new Date(sec * 1000).toISOString(),
    window_s: windowS,
    uptime_s: Math.round((Date.now() - bootedAt) / 1000),
    frame: S().frameNo,
    lanes: LANES.map((l) => ({ ...l })),
    entities: out,
    callers: callerRows,
    down: downRows,
    totals: {
      req: totals[K.req],
      read: totals[K.read],
      create: totals[K.create],
      update: totals[K.update],
      delete: totals[K.delete],
      error: totals[K.error],
      p50: q(0.5),
      p95: q(0.95),
      outbound_req: outboundReq,
      outbound_error: outboundErr
    },
    sockets: { count: opts.sockets, users: opts.users },
    journal_seq: opts.journalSeq
  }
  if (sourceRows.length) snap.sources = sourceRows.sort((a, b) => b.req - a.req)
  if (thisNode) snap.node = thisNode
  const ext = collectTaps((t) => t.snapshot?.(windowS, sec))
  if (ext) snap.ext = ext
  return snap
}

/** Caller keys of requests (keys / people / cron / anon) — noteSource ids are left out. */
export function seenCallerKeys(): CallerKey[] {
  return [...callers.keys()].filter((k) => !sourceMeta.has(k))
}
/** Label + kind of every noteSource id still held. */
export function seenSources(): Array<{ id: string; label: string; kind: string }> {
  return [...sourceMeta].map(([id, m]) => ({ id, label: m.label ?? id, kind: m.kind ?? 'source' }))
}
export function seenPartnerIds(): number[] {
  return [...partnerNames.keys()]
}

/**
 * Hourly sweep: forget entities idle for 15 minutes so capped lanes free their slots — in every
 * store; a tenant store left empty is dropped with its tap state (#1132).
 */
export function sweepIdle(sec = nowSec): number {
  let removed = 0
  const ids = new Set(trafficStoreIds())
  if (!process.env.CLOUD_META_DB_URL) ids.add(DEFAULT_STORE)
  for (const id of ids) {
    removed += withTrafficStore(id, () => sweepStore(sec))
    const st = mapStores.get(id)
    if (id !== DEFAULT_STORE && st && !st.entities.size && !st.callers.size) {
      mapStores.delete(id)
      dropTapStore(id)
    }
  }
  return removed
}
function sweepStore(sec: number): number {
  let removed = 0
  for (const [key, c] of callers) {
    if (sec - c.touchedSec >= RING_SECONDS) {
      callers.delete(key)
      sourceMeta.delete(key)
      removed++
    }
  }
  for (const [key, d] of downs) {
    if (key === 'db' || key === 'redis' || key === 'store') continue
    if (sec - d.touchedSec >= RING_SECONDS) {
      downs.delete(key)
      downMeta.delete(key)
      removed++
    }
  }
  for (const [key, e] of entities) {
    if (sec - e.lastSeen >= RING_SECONDS && e.entity !== '__other__') {
      entities.delete(key)
      laneCount.set(e.lane, Math.max(0, (laneCount.get(e.lane) ?? 1) - 1))
      removed++
    }
  }
  eachTap((t) => t.sweep?.(sec))
  return removed
}

export function resetTrafficMap(): void {
  mapStores.clear()
  nowSec = 0
  extCompiled = []
  extSig = ''
  resetTapState()
}

// ── emitter ──────────────────────────────────────────────────────────────────
interface IoLike {
  sockets: { adapter: { rooms: Map<string, Set<string>> } }
  to(room: string): { emit(ev: string, payload: unknown): void }
  local?: { to(room: string): { emit(ev: string, payload: unknown): void } }
  engine?: { clientsCount?: number }
}
export const TRAFFIC_MAP_ROOM = 'watch:traffic-map'
export const TRAFFIC_MAP_EVENT = 'traffic-map:frame'

/** The socket room a store's frames go to: the historic room self-hosted, one per tenant else. */
export function trafficRoomFor(storeId: string): string {
  return storeId === DEFAULT_STORE ? TRAFFIC_MAP_ROOM : `${TRAFFIC_MAP_ROOM}:${storeId}`
}

/**
 * Multi-node hook (#1098): set by the cluster relay when Redis is available. A node with local
 * watchers announces it; a node another node is watching keeps building frames and publishes
 * them, so the page can merge every API process. Idle clusters publish nothing.
 */
export interface TrafficCluster {
  /** This node has watchers for `storeId` (called every watched tick). */
  announce(storeId: string): void
  /** Another node has watchers for `storeId`. */
  watched(storeId: string): boolean
  /** Hand a built frame to the other nodes. */
  publish(storeId: string, frame: FrameWire): void
}
let cluster: TrafficCluster | null = null
/** This process's node id, once the emitter started (snapshots carry it). */
let thisNode: string | undefined
export function setTrafficCluster(c: TrafficCluster | null): void {
  cluster = c
}

/**
 * One tick per second. The ring clock always advances; a frame is built ONLY while a store's
 * room has a member here or on another node (#1098). Local frames go through io.local (never the
 * adapter); other nodes get theirs through the cluster relay.
 */
export function startTrafficMapEmitter(
  opts: {
    intervalMs?: number
    io?: () => IoLike | null
    now?: () => number
    /** This process's id on the wire (frames carry it so pages can merge nodes). */
    node?: string
  } = {}
): () => void {
  const ioOf = opts.io ?? (() => getIo() as unknown as IoLike | null)
  if (opts.node) thisNode = opts.node
  const nowMs = opts.now ?? (() => Date.now())
  let journalSeq: number | null = null
  let lastSeqPoll = 0
  let nextFrameSec = -1
  const timer = setInterval(() => {
    try {
      const sec = Math.floor(nowMs() / 1000)
      if (nextFrameSec < 0) nextFrameSec = sec - 1
      if (sec - 1 < nextFrameSec) return // same second already handled
      advanceTo(sec)
      const io = ioOf()
      const ids = new Set(trafficStoreIds())
      if (!process.env.CLOUD_META_DB_URL) ids.add(DEFAULT_STORE)
      let watchedAny = false
      for (const id of ids) {
        withTrafficStore(id, () => {
          const local = io?.sockets?.adapter?.rooms?.get(trafficRoomFor(id))?.size ?? 0
          if (local > 0) cluster?.announce(id)
          const remote = cluster?.watched(id) ?? false
          if (!io || (local === 0 && !remote)) {
            discardTick()
            return
          }
          watchedAny = true
          // Emit every completed second we have not sent (timer drift can skip one); cap the
          // catch-up at 5 s, then skip ahead.
          for (let s = Math.max(nextFrameSec, sec - 5); s <= sec - 1; s++) {
            const frame = buildFrame(s, { sockets: io.engine?.clientsCount ?? 0, journalSeq })
            if (opts.node) frame.node = opts.node
            if (local > 0) (io.local ?? io).to(trafficRoomFor(id)).emit(TRAFFIC_MAP_EVENT, frame)
            if (remote) cluster?.publish(id, frame)
          }
        })
      }
      if (watchedAny && sec - lastSeqPoll >= 5) {
        lastSeqPoll = sec
        void currentSeq()
          .then((v) => {
            journalSeq = v
          })
          .catch(() => {})
      }
      nextFrameSec = sec
    } catch {
      /* the map must never throw into the event loop */
    }
  }, opts.intervalMs ?? 1000)
  timer.unref?.()
  const sweep = setInterval(() => sweepIdle(), 3_600_000)
  sweep.unref?.()
  return () => {
    clearInterval(timer)
    clearInterval(sweep)
  }
}
