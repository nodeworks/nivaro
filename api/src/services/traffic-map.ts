// api/src/services/traffic-map.ts
/**
 * Traffic Map aggregator (spec §5–6). In-process, per node: 15-minute per-second rings per
 * entity / caller / downstream node, fed by the api-logger (requests), broadcastCollectionUpdate
 * (writes) and logOutbound (partner calls). Memory only — nothing here touches the database.
 */
import { currentSeq } from './event-journal.js'
import { getIo } from './io-holder.js'
import { currentTraceCaller, currentTraceMeta } from './request-trace.js'
import { instanceKey } from './settings-overrides.js'
import {
  type CallerKey,
  type Classified,
  type ClassifyInput,
  callerKeyFor,
  classifyRequest,
  type DownId,
  entityKey,
  LANES,
  normalizePath,
  routeTemplate,
  type TrafficKind,
  type TrafficLane
} from './traffic-entities.js'

export const RING_SECONDS = 900
export const MINUTE_BUCKETS = 15
export const LANE_ENTITY_CAP = 40
export const TOP_KEYS_CAP = 20
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
}
export interface TrafficWriteEvent {
  collection: string
  item: string | number
  action: 'create' | 'update' | 'delete'
  changedFields: string[]
  at: number
}
export interface TrafficOutboundEvent {
  apiId: number
  apiName: string
  status: number | null
  durationMs: number
  at: number
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

interface Ring {
  counts: Int32Array // RING_SECONDS * SLOTS
  lat: Float32Array
  latN: number
  latI: number
  lastSec: number // last second written (for gap zeroing)
  touchedSec: number
}
interface EntityState extends Ring {
  lane: TrafficLane
  entity: string
  routes: Map<string, MinuteSeries>
  callers: Map<CallerKey, MinuteSeries>
  downs: Map<DownId, MinuteSeries>
  errors: RecentError[]
  writes: RecentWrite[]
  lastSeen: number
}
interface NodeState extends Ring {
  label: string
}

const entities = new Map<string, EntityState>()
const laneCount = new Map<TrafficLane, number>()
const callers = new Map<CallerKey, NodeState>()
const downs = new Map<string, NodeState>()
const partnerNames = new Map<number, string>()
const edgesIn = new Map<string, number>() // this second only
const edgesOut = new Map<string, number>()
let pendingEvents: TrafficEventWire[] = []
let bufferDropped = 0
export const EVENT_BUFFER_CAP = 200
let nowSec = Math.floor(Date.now() / 1000)
let frameNo = 0
const bootedAt = Date.now()

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

/** Zero every slot between the ring's last write and `sec` (a quiet gap must read as zeros). */
function catchUp(r: Ring, sec: number): void {
  if (sec <= r.lastSec) return
  const gap = Math.min(sec - r.lastSec, RING_SECONDS)
  for (let i = 1; i <= gap; i++) {
    const idx = ((r.lastSec + i) % RING_SECONDS) * SLOTS
    r.counts.fill(0, idx, idx + SLOTS)
  }
  r.lastSec = sec
}
function isStale(sec: number): boolean {
  return sec < nowSec - (RING_SECONDS - 1)
}
function bump(r: Ring, sec: number, slot: number, n = 1): void {
  if (sec < r.lastSec - (RING_SECONDS - 1)) return
  catchUp(r, sec)
  r.counts[(sec % RING_SECONDS) * SLOTS + slot] += n
  r.touchedSec = sec
}
function sample(r: Ring, ms: number): void {
  r.lat[r.latI] = ms
  r.latI = (r.latI + 1) % LAT_SAMPLES
  if (r.latN < LAT_SAMPLES) r.latN++
}
/** Per-minute counts stamped with the minute they belong to, so a wrapped slot never reads stale. */
interface MinuteSeries {
  c: Uint16Array
  m: Int32Array
}
function bumpMinute(map: Map<string, MinuteSeries>, key: string, sec: number): void {
  let arr = map.get(key)
  if (!arr) {
    if (map.size >= TOP_KEYS_CAP) {
      const cur = Math.floor(sec / 60)
      for (const [k, v] of map) {
        let newest = -1
        for (let i = 0; i < MINUTE_BUCKETS; i++) if (v.m[i] > newest) newest = v.m[i]
        if (k !== '__other__' && newest < cur - (MINUTE_BUCKETS - 1)) {
          map.delete(k)
          break
        }
      }
    }
    if (map.size >= TOP_KEYS_CAP) {
      key = '__other__'
      arr = map.get(key)
    }
    if (!arr) {
      arr = { c: new Uint16Array(MINUTE_BUCKETS), m: new Int32Array(MINUTE_BUCKETS).fill(-1) }
      map.set(key, arr)
    }
  }
  const mn = Math.floor(sec / 60)
  const i = mn % MINUTE_BUCKETS
  if (arr.m[i] !== mn) {
    arr.m[i] = mn
    arr.c[i] = 0
  }
  if (arr.c[i] < 65535) arr.c[i]++
}
function sumMinute(arr: MinuteSeries, windowS: number, sec: number): number {
  const minutes = Math.min(MINUTE_BUCKETS, Math.ceil(windowS / 60) + 1)
  const cur = Math.floor(sec / 60)
  let s = 0
  for (let k = 0; k < minutes; k++) {
    const mn = cur - k
    const i = ((mn % MINUTE_BUCKETS) + MINUTE_BUCKETS) % MINUTE_BUCKETS
    if (arr.m[i] === mn) s += arr.c[i]
  }
  return s
}
function sumWindow(r: Ring, windowS: number, sec: number): number[] {
  catchUp(r, sec)
  const out = [0, 0, 0, 0, 0, 0]
  for (let i = 0; i < windowS; i++) {
    const base = (((sec - i) % RING_SECONDS) + RING_SECONDS) % RING_SECONDS
    for (let k = 0; k < SLOTS; k++) out[k] += r.counts[base * SLOTS + k]
  }
  return out
}
function seriesOf(r: Ring, windowS: number, sec: number, points: number): number[] {
  const per = windowS / points
  const out = new Array<number>(points).fill(0)
  for (let i = 0; i < windowS; i++) {
    const s = sec - windowS + 1 + i
    const base = ((s % RING_SECONDS) + RING_SECONDS) % RING_SECONDS
    out[Math.min(points - 1, Math.floor(i / per))] += r.counts[base * SLOTS + K.req]
  }
  return out
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
function getDown(id: DownId, label?: string): NodeState {
  let d = downs.get(id)
  if (!d) {
    d = mkNode(label ?? id)
    downs.set(id, d)
  } else if (label) d.label = label
  return d
}
function pushEvent(ev: TrafficEventWire): void {
  pendingEvents.push(ev)
  if (pendingEvents.length <= EVENT_BUFFER_CAP) return
  // Over the cap: drop the lowest-priority (then oldest) event, error>create>delete>update>read.
  let worst = 0
  for (let i = 1; i < pendingEvents.length; i++) {
    if (PRIORITY[pendingEvents[i].kind] > PRIORITY[pendingEvents[worst].kind]) worst = i
  }
  pendingEvents.splice(worst, 1)
  bufferDropped++
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
): void {
  if (isStale(Math.floor(ev.at / 1000))) return
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
  const downIds: DownId[] = ev.cacheHit ? c.down.map((d) => (d === 'db' ? 'redis' : d)) : c.down
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
    pushEvent({
      t: ev.at,
      lane: c.lane,
      entity: e.entity,
      kind: 'error',
      caller,
      route,
      status: ev.status,
      ms: ev.latencyMs,
      code,
      record: record ?? undefined
    })
  } else if (c.kind === 'read') {
    pushEvent({
      t: ev.at,
      lane: c.lane,
      entity: e.entity,
      kind: 'read',
      caller,
      route,
      status: ev.status,
      ms: ev.latencyMs
    })
  }
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

/** Cloud mode: one process serves many tenants and no emitter runs, so record nothing (R31). */
function inCloud(): boolean {
  return !!process.env.CLOUD_META_DB_URL
}

export function noteRequest(ev: TrafficRequestEvent & { errorCode?: string | null }): void {
  if (inCloud()) return
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
    applyRequest(c, ev, caller, route, ev.status >= 400 ? errorCode(ev.errorCode) : null)
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
  if (inCloud()) return
  try {
    if (isStale(Math.floor(ev.at / 1000))) return
    const sec = secOf(ev.at)
    const lane: TrafficLane = /^(nivaro_|directus_|sys)/.test(ev.collection) ? 'system' : 'items'
    const e = getEntity(lane, ev.collection.slice(0, 120))
    const slot = ev.action === 'create' ? K.create : ev.action === 'delete' ? K.delete : K.update
    bump(e, sec, slot)
    e.lastSeen = sec
    const { caller, via } = callerFromTrace()
    if (caller === 'cron') {
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
    pushEvent({
      t: ev.at,
      lane,
      entity: e.entity,
      kind: ev.action,
      caller,
      route,
      record: w.record,
      fields,
      via
    })
  } catch {
    /* never */
  }
}

export function noteOutbound(ev: TrafficOutboundEvent): void {
  if (inCloud()) return
  try {
    if (isStale(Math.floor(ev.at / 1000))) return
    const sec = secOf(ev.at)
    const id: DownId = `ext:${ev.apiId}`
    partnerNames.set(ev.apiId, ev.apiName)
    const dn = getDown(id, ev.apiName)
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
    if (!meta) {
      // No request behind it: a cron / background call (spec §4).
      const cn = getCaller('cron')
      bump(cn, sec, K.req)
      if (failed) bump(cn, sec, K.error)
      edgesIn.set(`cron>${e.lane}`, (edgesIn.get(`cron>${e.lane}`) ?? 0) + 1)
    }
  } catch {
    /* never */
  }
}

// ── clock ────────────────────────────────────────────────────────────────────
export function advanceTo(sec: number): void {
  if (sec > nowSec) nowSec = sec
}
function takeEvents(): { events: TrafficEventWire[]; dropped: number } {
  const out = { events: pendingEvents, dropped: bufferDropped }
  pendingEvents = []
  bufferDropped = 0
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
  edges_in: Record<string, number>
  edges_out: Record<string, number>
  events: TrafficEventWire[]
  events_dropped?: number
  sockets: number
  journal_seq: number | null
}

function secondOf(r: Ring, sec: number): number[] {
  catchUp(r, sec)
  const base = (sec % RING_SECONDS) * SLOTS
  return Array.from(r.counts.subarray(base, base + SLOTS))
}

export function buildFrame(
  sec: number,
  opts: { sockets: number; journalSeq: number | null }
): FrameWire {
  advanceTo(sec)
  frameNo++
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
  for (const [key, d] of downs) {
    if (d.touchedSec < sec) continue
    const s = secondOf(d, sec)
    if (s[K.req]) ds[key] = [s[K.req], s[K.error], pct(d, 0.95)]
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
    kind: 'db' | 'cache' | 'storage' | 'partner'
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
}

function topOf(
  map: Map<string, MinuteSeries>,
  windowS: number,
  sec: number,
  n: number
): Array<[string, number]> {
  const rows: Array<[string, number]> = []
  for (const [k, arr] of map) {
    const v = sumMinute(arr, windowS, sec)
    if (v > 0) rows.push([k, v])
  }
  return rows.sort((a, b) => b[1] - a[1]).slice(0, n)
}
function downKind(id: string): 'db' | 'cache' | 'storage' | 'partner' {
  return id === 'db' ? 'db' : id === 'redis' ? 'cache' : id === 'store' ? 'storage' : 'partner'
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
  for (const [key, e] of entities) {
    const s = sumWindow(e, windowS, sec)
    const downTop = topOf(e.downs, windowS, sec, TOP_KEYS_CAP)
    if (s.every((v) => v === 0) && downTop.length === 0) continue
    for (let k = 0; k < SLOTS; k++) totals[k] += s[k]
    allLat.push(...Array.from(e.lat.subarray(0, e.latN)))
    out.push({
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
    })
  }
  out.sort((a, b) => b.req - a.req)
  const callerRows = [...callers]
    .map(([key, c]) => {
      const s = sumWindow(c, windowS, sec)
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
  return {
    instance: instanceKey(),
    node_scope: NODE_SCOPE,
    at: new Date(sec * 1000).toISOString(),
    window_s: windowS,
    uptime_s: Math.round((Date.now() - bootedAt) / 1000),
    frame: frameNo,
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
}

export function seenCallerKeys(): CallerKey[] {
  return [...callers.keys()]
}
export function seenPartnerIds(): number[] {
  return [...partnerNames.keys()]
}

/** Hourly sweep: forget entities idle for 15 minutes so capped lanes free their slots. */
export function sweepIdle(sec = nowSec): number {
  let removed = 0
  for (const [key, c] of callers) {
    if (sec - c.touchedSec >= RING_SECONDS) {
      callers.delete(key)
      removed++
    }
  }
  for (const [key, d] of downs) {
    if (key === 'db' || key === 'redis' || key === 'store') continue
    if (sec - d.touchedSec >= RING_SECONDS) {
      downs.delete(key)
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
  return removed
}

export function resetTrafficMap(): void {
  entities.clear()
  laneCount.clear()
  callers.clear()
  downs.clear()
  partnerNames.clear()
  edgesIn.clear()
  edgesOut.clear()
  pendingEvents = []
  bufferDropped = 0
  frameNo = 0
  nowSec = 0
  extCompiled = []
  extSig = ''
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

/**
 * One tick per second. The ring clock always advances; a frame is built and emitted ONLY while
 * the room has a member. Frames are per node, so they go through io.local (never the adapter).
 */
export function startTrafficMapEmitter(
  opts: { intervalMs?: number; io?: () => IoLike | null; now?: () => number } = {}
): () => void {
  const ioOf = opts.io ?? (() => getIo() as unknown as IoLike | null)
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
      const watchers = io?.sockets?.adapter?.rooms?.get(TRAFFIC_MAP_ROOM)?.size ?? 0
      if (!io || watchers === 0) {
        discardTick()
        nextFrameSec = sec
        return
      }
      if (sec - lastSeqPoll >= 5) {
        lastSeqPoll = sec
        void currentSeq()
          .then((v) => {
            journalSeq = v
          })
          .catch(() => {})
      }
      // Emit every completed second we have not sent (timer drift can skip one); cap the
      // catch-up at 5 s, then skip ahead.
      for (let s = Math.max(nextFrameSec, sec - 5); s <= sec - 1; s++) {
        const frame = buildFrame(s, { sockets: io.engine?.clientsCount ?? 0, journalSeq })
        ;(io.local ?? io).to(TRAFFIC_MAP_ROOM).emit(TRAFFIC_MAP_EVENT, frame)
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
