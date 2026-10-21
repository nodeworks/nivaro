import { gunzipSync } from 'node:zlib'
import { db } from '../db/index.js'

/**
 * Session replay index (#1374, #1372) — what each recording touched, so
 * /session-replays can answer "who opened orders/1042", "who typed into a
 * `due_date` field" and "which recordings clicked this element".
 *
 * Written at upload: POST /session-recordings/:id/events stores the chunk and
 * hands its (already parsed) events to scheduleReplayIndex(), which queues
 * them and returns at once — the upload never waits on the index. One serial
 * worker per process drains the queue, so a recording's chunks are indexed
 * in arrival order and no two writes race inside this process.
 *
 * Four kinds of row in nivaro_replay_index, one per (recording, kind, key),
 * holding the first and last epoch-ms the key was seen:
 *   route     route pattern ('/collections/orders/:id') from the recorder's
 *             'route' custom events and rrweb Meta hrefs
 *   record    'collection/id' from admin record routes; its span runs until
 *             the person left that route (or the last event seen on it)
 *   field     data-field NAME of an input focused or typed into — bare
 *             ('due_date') and, on a record route, qualified ('orders.due_date').
 *             Names only: the recorder masks values and this never reads one
 *   selector  stable selector of an element clicked, focused or typed into
 *             (see selectorFor — the player's inspector builds the same one)
 *
 * Resolving node ids. rrweb input / click events name a node id, not an
 * element; the id → attributes map lives in the last full snapshot plus the
 * mutations since. Recorders take a full snapshot every 60 s (checkout) and
 * upload every 10 s, so most chunks have none. The worker keeps a minimal
 * map per recording (element id → parent, tag and the handful of hook
 * attributes selectors use — never text or values) in a bounded LRU
 * (CACHE_RECORDINGS × NODE_CAP). On a miss — a restart, another API instance
 * took the previous chunk, a gap in seq — it rebuilds from the database:
 * walks back at most REBUILD_MAX_CHUNKS stored chunks to the last one holding
 * a full snapshot and replays them, which a 60 s checkout keeps to about six.
 * Routes and records need no node map, so they are always indexed; a field or
 * selector whose node cannot be resolved is skipped. The index is
 * best-effort by design: every failure is caught and the queue is capped
 * (QUEUE_MAX_EVENTS), dropping work rather than holding memory.
 *
 * Rows purge with their recording (FK ON DELETE CASCADE, migration 421).
 */

export type IndexKind = 'route' | 'record' | 'field' | 'selector'

export interface IndexEntry {
  kind: IndexKind
  key: string
  first: number
  last: number
}

const KEY_MAX = 255
const CACHE_RECORDINGS = 48
const NODE_CAP = 40_000
const REBUILD_MAX_CHUNKS = 12
const ENTRIES_PER_CHUNK = 300
const ROWS_PER_RECORDING = 3_000
const QUEUE_MAX_EVENTS = 250_000
const INSERT_BATCH = 200

// rrweb event / source / node constants (rrweb 2.x)
const EV_FULL_SNAPSHOT = 2
const EV_INCREMENTAL = 3
const EV_META = 4
const EV_CUSTOM = 5
const SRC_MUTATION = 0
const SRC_MOUSE = 2
const SRC_INPUT = 5
const NODE_ELEMENT = 2
/** Click, ContextMenu, DblClick, Focus, TouchEnd. */
const INDEXED_MOUSE = new Set([2, 3, 4, 5, 9])
const MOUSE_FOCUS = 5

// ── Selectors ────────────────────────────────────────────────────────────────
// KEEP IN STEP with admin/src/components/replay-player/inspector-logic.ts —
// the inspector's "Find in other recordings" searches for the selector it
// builds from the live replay DOM, so both sides must build the same string
// for the same element. Both test files share the same vectors.

/** What the selector rules need from a node: a live element or a snapshot entry. */
export interface HookNode {
  tag: string
  attr(name: string): string | null
  attrNames(): string[]
  parent(): HookNode | null
}

/** Attribute values a selector may quote. */
const SAFE_VALUE = /^[\w.:/-]{1,64}$/
/** Values that name one record — a selector carrying them matches nothing elsewhere. */
const ID_LIKE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,})$/i
const CBV_ATTR = /^data-cbv-[a-z0-9-]{1,48}$/
const STABLE_ID = /^[A-Za-z][\w-]{0,63}$/
/** Library-generated ids (radix-:r3:, headlessui-menu-12…) change per render. */
const GENERATED_ID = /^(?:radix-|headlessui-|react-|rc-|mui-|downshift-|tippy-|rr-)|\d{3,}/
const SAFE_TOKEN = /^[a-z][a-z0-9-]{0,23}$/
const MAX_ANCESTORS = 25

/** The element's own stable hook as a selector, or null. */
export function hookOf(n: HookNode): string | null {
  const testid = n.attr('data-testid')
  if (testid && SAFE_VALUE.test(testid)) return `[data-testid="${testid}"]`
  const field = n.attr('data-field')
  if (field && SAFE_VALUE.test(field)) return `[data-field="${field}"]`
  const cbv = n
    .attrNames()
    .filter((a) => CBV_ATTR.test(a))
    .sort()[0]
  if (cbv) {
    const v = n.attr(cbv) ?? ''
    return v && v.length <= 40 && SAFE_VALUE.test(v) && !ID_LIKE.test(v)
      ? `[${cbv}="${v}"]`
      : `[${cbv}]`
  }
  const id = n.attr('id')
  if (id && STABLE_ID.test(id) && !GENERATED_ID.test(id)) return `#${id}`
  return null
}

/** Tag plus the qualifiers that say what kind of control it is. */
function partOf(n: HookNode): string {
  let s = n.tag
  const name = n.attr('name')
  if (name && SAFE_VALUE.test(name) && /^(input|select|textarea|button)$/.test(n.tag)) {
    s += `[name="${name}"]`
  }
  const type = n.tag === 'input' ? n.attr('type')?.toLowerCase() : null
  if (type && SAFE_TOKEN.test(type)) s += `[type="${type}"]`
  const role = n.attr('role')?.toLowerCase()
  if (role && SAFE_TOKEN.test(role)) s += `[role="${role}"]`
  return s
}

/**
 * A selector for the element: its own hook, else the nearest hooked
 * ancestor + its tag and kind. `anchored` is false when no hook was found —
 * a bare `button` is shown but never indexed or searched for.
 */
export function selectorFor(n: HookNode): { selector: string; anchored: boolean } {
  const own = hookOf(n)
  if (own) return { selector: own, anchored: true }
  const part = partOf(n)
  let p = n.parent()
  for (let d = 0; p && d < MAX_ANCESTORS; d++, p = p.parent()) {
    const h = hookOf(p)
    if (h) return { selector: `${h} ${part}`, anchored: true }
  }
  return { selector: part, anchored: false }
}

/** The nearest `data-field` name on the element or an ancestor. */
export function nearestDataField(n: HookNode): string | null {
  let p: HookNode | null = n
  for (let d = 0; p && d <= MAX_ANCESTORS; d++, p = p.parent()) {
    const f = p.attr('data-field')
    if (f && SAFE_VALUE.test(f)) return f
  }
  return null
}

// ── Routes and records ───────────────────────────────────────────────────────

const RESERVED_ITEM = new Set(['classic', 's', '+', 'new'])
const COLLECTION_NAME = /^[\w-]{1,64}$/

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

function isIdSegment(seg: string): boolean {
  return (
    ID_LIKE.test(seg) ||
    seg.includes('@') ||
    (seg.length >= 20 && /\d/.test(seg)) ||
    /^[0-9a-f]{12,}$/i.test(seg)
  )
}

/** `/collections/orders/1042?tab=x` → { collection: 'orders', item: '1042' }. */
export function recordFromPath(path: string): { collection: string; item: string } | null {
  const bare = String(path ?? '').split(/[?#]/)[0]
  const m = bare.match(/(?:^|\/)collections\/([^/]+)\/([^/]+)\/?$/)
  if (!m) return null
  const collection = decode(m[1])
  const item = decode(m[2])
  if (!COLLECTION_NAME.test(collection) || RESERVED_ITEM.has(item)) return null
  if (!item || item.length > 200 || /[\s/]/.test(item)) return null
  return { collection, item }
}

/** A path with its ids folded: `/collections/orders/1042` → `/collections/orders/:id`. */
export function routePattern(path: string): string | null {
  const bare = String(path ?? '').split(/[?#]/)[0]
  if (!bare.startsWith('/')) return null
  const rec = recordFromPath(bare)
  const segs = bare.split('/')
  const out = segs.map((s, i) => {
    if (!s) return s
    // The record route's item is an id whatever it looks like.
    if (rec && i === segs.length - 1 - (segs[segs.length - 1] === '' ? 1 : 0)) return ':id'
    return isIdSegment(decode(s)) ? ':id' : s
  })
  const p = out.join('/') || '/'
  return p.length > KEY_MAX ? p.slice(0, KEY_MAX) : p
}

function pathOfHref(href: unknown): string | null {
  if (typeof href !== 'string' || !href) return null
  try {
    const u = new URL(href)
    return u.pathname
  } catch {
    return href.startsWith('/') ? href : null
  }
}

// ── Node map + event walk ────────────────────────────────────────────────────

/** Attributes the node map keeps — the selector hooks, nothing else. */
const KEPT_ATTRS = new Set(['id', 'name', 'type', 'role', 'data-testid', 'data-field'])
function keepAttr(name: string): boolean {
  return KEPT_ATTRS.has(name) || CBV_ATTR.test(name)
}

interface NodeLite {
  /** parent node id (-1: none) */
  p: number
  t: string
  a?: Record<string, string>
}

export interface IndexState {
  nodes: Map<number, NodeLite>
  route: { pattern: string; record: string | null; collection: string | null } | null
  lastSeq: number
  /** Rows this recording holds (approximate; caps the per-recording total). */
  rows: number
}

export function newIndexState(): IndexState {
  return { nodes: new Map(), route: null, lastSeq: -1, rows: 0 }
}

type SerializedNode = {
  type?: number
  id?: number
  tagName?: string
  attributes?: Record<string, unknown>
  childNodes?: SerializedNode[]
}

function keptAttrs(raw: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!raw) return undefined
  let out: Record<string, string> | undefined
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string' || !keepAttr(k)) continue
    out ??= {}
    out[k] = v.slice(0, 128)
  }
  return out
}

function addSerialized(state: IndexState, node: SerializedNode | undefined, parent: number): void {
  // Iterative: a deep DOM must not blow the stack.
  const stack: Array<[SerializedNode, number]> = node ? [[node, parent]] : []
  while (stack.length > 0) {
    const [n, p] = stack.pop()!
    let childParent = p
    if (typeof n.id === 'number') {
      if (n.type === NODE_ELEMENT && state.nodes.size < NODE_CAP) {
        const a = keptAttrs(n.attributes)
        state.nodes.set(n.id, {
          p,
          t: String(n.tagName ?? '').toLowerCase(),
          ...(a ? { a } : {})
        })
      }
      childParent = n.id
    }
    if (Array.isArray(n.childNodes)) {
      for (const c of n.childNodes) stack.push([c, childParent])
    }
  }
}

function hookNode(state: IndexState, id: number, depth = 0): HookNode | null {
  const n = state.nodes.get(id)
  if (!n || depth > MAX_ANCESTORS + 2) return null
  return {
    tag: n.t,
    attr: (name) => n.a?.[name] ?? null,
    attrNames: () => (n.a ? Object.keys(n.a) : []),
    parent: () => (n.p >= 0 ? hookNode(state, n.p, depth + 1) : null)
  }
}

/** Collects entries for one chunk, keeping first / last per (kind, key). */
export class EntryCollector {
  private map = new Map<string, IndexEntry>()
  add(kind: IndexKind, key: string, at: number): void {
    if (!key || !Number.isFinite(at)) return
    const k = key.length > KEY_MAX ? key.slice(0, KEY_MAX) : key
    const id = `${kind}\u0000${k}`
    const e = this.map.get(id)
    if (e) {
      if (at < e.first) e.first = at
      if (at > e.last) e.last = at
    } else if (this.map.size < ENTRIES_PER_CHUNK) {
      this.map.set(id, { kind, key: k, first: at, last: at })
    }
  }
  entries(): IndexEntry[] {
    return [...this.map.values()]
  }
}

type EventLike = { type?: unknown; timestamp?: unknown; data?: Record<string, unknown> }

/**
 * Walk one chunk's events in order: keep the node map and current route up to
 * date, and — with a collector — note what was touched. Without a collector
 * (a rebuild) it only replays state.
 */
export function applyEvents(state: IndexState, events: unknown[], out?: EntryCollector): void {
  let lastTs = Number.NaN
  const extendRoute = (at: number) => {
    if (!out || !state.route || !Number.isFinite(at)) return
    out.add('route', state.route.pattern, at)
    if (state.route.record) out.add('record', state.route.record, at)
  }
  const setRoute = (path: string | null, at: number) => {
    if (!path) return
    const pattern = routePattern(path)
    if (!pattern) return
    const rec = recordFromPath(path)
    const record = rec ? `${rec.collection}/${rec.item}` : null
    // Leaving a route closes its span at the moment of leaving.
    if (state.route && (state.route.pattern !== pattern || state.route.record !== record)) {
      extendRoute(at)
    }
    state.route = { pattern, record, collection: rec?.collection ?? null }
    extendRoute(at)
  }
  const touch = (id: unknown, at: number, fieldish: boolean) => {
    if (!out || typeof id !== 'number') return
    const node = hookNode(state, id)
    if (!node) return
    const sel = selectorFor(node)
    if (sel.anchored) out.add('selector', sel.selector, at)
    if (fieldish) {
      const f = nearestDataField(node)
      if (f) {
        out.add('field', f, at)
        if (state.route?.collection) out.add('field', `${state.route.collection}.${f}`, at)
      }
    }
  }

  for (const raw of events) {
    const ev = raw as EventLike | null
    if (!ev || typeof ev !== 'object') continue
    const at = Number(ev.timestamp)
    const data = (ev.data ?? {}) as Record<string, unknown>
    switch (ev.type) {
      case EV_FULL_SNAPSHOT:
        state.nodes.clear()
        addSerialized(state, data.node as SerializedNode, -1)
        break
      case EV_META:
        setRoute(pathOfHref(data.href), at)
        break
      case EV_CUSTOM: {
        const payload = data.payload as { path?: unknown } | undefined
        if (data.tag === 'route' && typeof payload?.path === 'string') {
          setRoute(payload.path, at)
        }
        break
      }
      case EV_INCREMENTAL: {
        if (data.source === SRC_MUTATION) {
          for (const r of (data.removes as Array<{ id?: number }> | undefined) ?? []) {
            if (typeof r?.id === 'number') state.nodes.delete(r.id)
          }
          for (const a of (data.adds as Array<{ parentId?: number; node?: SerializedNode }>) ??
            []) {
            if (a?.node)
              addSerialized(state, a.node, typeof a.parentId === 'number' ? a.parentId : -1)
          }
          for (const ch of (data.attributes as Array<{
            id?: number
            attributes?: Record<string, unknown>
          }>) ?? []) {
            const n = typeof ch?.id === 'number' ? state.nodes.get(ch.id) : undefined
            if (!n || !ch.attributes) continue
            for (const [k, v] of Object.entries(ch.attributes)) {
              if (!keepAttr(k)) continue
              if (typeof v === 'string') {
                n.a ??= {}
                n.a[k] = v.slice(0, 128)
              } else if (n.a) {
                delete n.a[k]
              }
            }
          }
        } else if (data.source === SRC_MOUSE) {
          if (INDEXED_MOUSE.has(Number(data.type))) touch(data.id, at, data.type === MOUSE_FOCUS)
        } else if (data.source === SRC_INPUT) {
          touch(data.id, at, true)
        }
        break
      }
    }
    if (Number.isFinite(at)) lastTs = at
  }
  // Still on the route at the end of the chunk: its span runs to here.
  extendRoute(lastTs)
}

/** Index one chunk against a state (pure — the tests' entry point). */
export function indexChunk(state: IndexState, events: unknown[]): IndexEntry[] {
  const out = new EntryCollector()
  applyEvents(state, events, out)
  return out.entries()
}

// ── Worker: queue, cache, rebuild, write ─────────────────────────────────────

const cache = new Map<string, IndexState>()

function cacheGet(id: string): IndexState | undefined {
  const s = cache.get(id)
  if (s) {
    cache.delete(id)
    cache.set(id, s)
  }
  return s
}

function cacheSet(id: string, s: IndexState): void {
  cache.delete(id)
  cache.set(id, s)
  while (cache.size > CACHE_RECORDINGS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Stored chunks are `gz:`+base64 or (older) plain JSON — as routes/session-recordings.ts. */
function decodeStored(stored: string): unknown[] {
  const json = stored.startsWith('gz:')
    ? gunzipSync(Buffer.from(stored.slice(3), 'base64')).toString('utf8')
    : stored
  const v = JSON.parse(json)
  return Array.isArray(v) ? v : []
}

function hasFullSnapshot(events: unknown[]): boolean {
  return events.some((e) => (e as EventLike | null)?.type === EV_FULL_SNAPSHOT)
}

/** State as of just before `seq`: replay back to the last full snapshot. */
async function rebuildState(recording: string, seq: number): Promise<IndexState> {
  const state = newIndexState()
  const seqs = (await db('nivaro_session_events')
    .where({ recording })
    .where('seq', '<', seq)
    .orderBy('seq', 'desc')
    .limit(REBUILD_MAX_CHUNKS)
    .select('seq')) as Array<{ seq: number }>
  const chunks: unknown[][] = []
  for (const { seq: s } of seqs) {
    const row = (await db('nivaro_session_events').where({ recording, seq: s }).first('events')) as
      | { events?: string }
      | undefined
    if (!row?.events) continue
    let evs: unknown[] = []
    try {
      evs = decodeStored(row.events)
    } catch {
      continue
    }
    chunks.unshift(evs)
    if (hasFullSnapshot(evs)) break
  }
  for (const evs of chunks) applyEvents(state, evs)
  state.lastSeq = seq - 1
  const c = (await db('nivaro_replay_index').where({ recording }).count({ n: '*' }).first()) as
    | { n?: number | string }
    | undefined
  state.rows = Number(c?.n ?? 0)
  return state
}

async function writeEntries(
  recording: string,
  entries: IndexEntry[],
  state: IndexState
): Promise<void> {
  if (entries.length === 0) return
  const keys = [...new Set(entries.map((e) => e.key))]
  const existing = (await db('nivaro_replay_index')
    .where({ recording })
    .whereIn('key', keys)
    .select('id', 'kind', 'key', 'first_ms', 'last_ms')) as Array<{
    id: number
    kind: string
    key: string
    first_ms: number | string
    last_ms: number | string
  }>
  const byKey = new Map(existing.map((r) => [`${r.kind}\u0000${r.key}`, r]))
  const inserts: Array<{
    recording: string
    kind: IndexKind
    key: string
    first_ms: number
    last_ms: number
  }> = []
  for (const e of entries) {
    const ex = byKey.get(`${e.kind}\u0000${e.key}`)
    if (ex) {
      const first = Math.min(Number(ex.first_ms), e.first)
      const last = Math.max(Number(ex.last_ms), e.last)
      if (first !== Number(ex.first_ms) || last !== Number(ex.last_ms)) {
        await db('nivaro_replay_index')
          .where({ id: ex.id })
          .update({ first_ms: first, last_ms: last })
      }
    } else if (state.rows + inserts.length < ROWS_PER_RECORDING) {
      inserts.push({ recording, kind: e.kind, key: e.key, first_ms: e.first, last_ms: e.last })
    }
  }
  for (let i = 0; i < inserts.length; i += INSERT_BATCH) {
    const batch = inserts.slice(i, i + INSERT_BATCH)
    try {
      await db('nivaro_replay_index').insert(batch)
      state.rows += batch.length
    } catch {
      // Another API instance indexed one of these keys first (unique key):
      // fall back to one row at a time and widen the span of the winner.
      for (const row of batch) {
        try {
          await db('nivaro_replay_index').insert(row)
          state.rows += 1
        } catch {
          await db('nivaro_replay_index')
            .where({ recording, kind: row.kind, key: row.key })
            .update({
              first_ms: db.raw('CASE WHEN first_ms < ? THEN first_ms ELSE ? END', [
                row.first_ms,
                row.first_ms
              ]),
              last_ms: db.raw('CASE WHEN last_ms > ? THEN last_ms ELSE ? END', [
                row.last_ms,
                row.last_ms
              ])
            })
            .catch(() => {})
        }
      }
    }
  }
}

interface Job {
  recording: string
  seq: number
  events: unknown[]
}

/** Index one uploaded chunk now (the worker's step; exported for tests). */
export async function indexUploadedChunk(job: Job): Promise<IndexEntry[]> {
  let state = cacheGet(job.recording)
  // In step (the previous seq, or this chunk starts over with a full
  // snapshot): carry on. Otherwise rebuild from what is stored.
  const inStep = state && state.lastSeq >= job.seq - 1
  if (!inStep && !hasFullSnapshot(job.events)) {
    state = await rebuildState(job.recording, job.seq)
  } else if (!state) {
    state = newIndexState()
    const c = (await db('nivaro_replay_index')
      .where({ recording: job.recording })
      .count({ n: '*' })
      .first()) as { n?: number | string } | undefined
    state.rows = Number(c?.n ?? 0)
  }
  const s = state as IndexState
  const entries = indexChunk(s, job.events)
  s.lastSeq = Math.max(s.lastSeq, job.seq)
  cacheSet(job.recording, s)
  await writeEntries(job.recording, entries, s)
  return entries
}

const queue: Job[] = []
let queuedEvents = 0
let draining: Promise<void> | null = null
let warned = false

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const job = queue.shift()!
    queuedEvents -= job.events.length
    try {
      await indexUploadedChunk(job)
    } catch (err) {
      if (!warned) {
        warned = true
        // biome-ignore lint/suspicious/noConsole: once per process — a broken index must show in the server log
        console.warn('[session-replay-index] indexing a chunk failed:', (err as Error)?.message)
      }
    }
  }
}

/**
 * Queue an uploaded chunk for indexing and return at once. Never throws;
 * past QUEUE_MAX_EVENTS pending, the chunk is skipped (its routes go
 * unindexed — the recording itself is untouched).
 */
export function scheduleReplayIndex(recording: string, seq: number, events: unknown[]): void {
  try {
    if (!Array.isArray(events) || events.length === 0) return
    if (queuedEvents + events.length > QUEUE_MAX_EVENTS) return
    queue.push({ recording, seq, events })
    queuedEvents += events.length
    if (!draining) {
      draining = new Promise<void>((resolve) => setImmediate(resolve)).then(drain).finally(() => {
        draining = null
      })
    }
  } catch {
    /* the index is best-effort — never disturb an upload */
  }
}

/** Resolves once the queue is empty (tests). */
export async function replayIndexIdle(): Promise<void> {
  while (draining) await draining
}

/** Drop cached node maps (tests). */
export function resetReplayIndexCache(): void {
  cache.clear()
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface ReplaySearchQuery {
  collection?: string
  item?: string
  field?: string
  selector?: string
  route?: string
  limit?: number
}

export interface Criterion {
  kind: IndexKind
  key?: string
  /** key prefix (collection without an item: any record of it) */
  prefix?: string
}

/** The query as index lookups; ANDed — a recording must match every one. */
export function searchCriteria(q: ReplaySearchQuery): Criterion[] {
  const out: Criterion[] = []
  const collection = q.collection?.trim()
  const item = q.item?.trim()
  const field = q.field?.trim()
  if (collection && item) out.push({ kind: 'record', key: `${collection}/${item}` })
  else if (collection && !field) out.push({ kind: 'record', prefix: `${collection}/` })
  if (field) out.push({ kind: 'field', key: collection ? `${collection}.${field}` : field })
  if (q.selector?.trim()) out.push({ kind: 'selector', key: q.selector.trim() })
  if (q.route?.trim()) out.push({ kind: 'route', key: q.route.trim() })
  return out.map((c) =>
    c.key && c.key.length > KEY_MAX ? { ...c, key: c.key.slice(0, KEY_MAX) } : c
  )
}

export interface ReplaySearchHit {
  id: string
  user: string | null
  user_name: string | null
  app: string | null
  origin: string | null
  started_at: string | Date
  ended_at: string | Date | null
  last_event_at: string | Date | null
  event_count: number
  byte_size: number
  truncated: boolean
  /** Span of the primary match (epoch ms). */
  first_ms: number
  last_ms: number
  matches: Array<{
    kind: IndexKind | 'outcome'
    key: string
    first_ms: number
    last_ms: number
  }>
}

export async function searchReplayIndex(q: ReplaySearchQuery): Promise<ReplaySearchHit[]> {
  const crit = searchCriteria(q)
  if (crit.length === 0) return []
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 100), 1), 200)
  const [primary, ...rest] = crit
  const rows = (await db('nivaro_replay_index as i')
    .join('nivaro_session_recordings as r', 'r.id', 'i.recording')
    .leftJoin('nivaro_users as u', 'u.id', 'r.user')
    .where('i.kind', primary.kind)
    .modify((qb) => {
      if (primary.key != null) qb.where('i.key', primary.key)
      // `_` is a LIKE wildcard: over-matches are filtered below.
      else if (primary.prefix) qb.where('i.key', 'like', `${primary.prefix}%`)
      for (const c of rest) {
        qb.whereExists(function () {
          this.select(db.raw('1'))
            .from('nivaro_replay_index as i2')
            .where('i2.recording', db.ref('i.recording'))
            .where('i2.kind', c.kind)
            .where('i2.key', c.key ?? '')
        })
      }
    })
    .orderBy('i.last_ms', 'desc')
    .limit(limit * 4)
    .select(
      'i.recording',
      'i.kind',
      'i.key',
      'i.first_ms',
      'i.last_ms',
      'r.user',
      'r.app',
      'r.origin',
      'r.started_at',
      'r.ended_at',
      'r.last_event_at',
      'r.event_count',
      'r.byte_size',
      'r.truncated',
      db.raw(
        "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as user_name"
      )
    )) as Array<Record<string, unknown>>

  const hits = new Map<string, ReplaySearchHit>()
  for (const r of rows) {
    const key = String(r.key)
    if (primary.prefix && !key.startsWith(primary.prefix)) continue
    const id = String(r.recording)
    const first = Number(r.first_ms)
    const last = Number(r.last_ms)
    let hit = hits.get(id)
    if (!hit) {
      if (hits.size >= limit) continue
      hit = {
        id,
        user: (r.user as string) ?? null,
        user_name: (r.user_name as string) || null,
        app: (r.app as string) ?? null,
        origin: (r.origin as string) ?? null,
        started_at: r.started_at as string,
        ended_at: (r.ended_at as string) ?? null,
        last_event_at: (r.last_event_at as string) ?? null,
        event_count: Number(r.event_count ?? 0),
        byte_size: Number(r.byte_size ?? 0),
        truncated: !!r.truncated,
        first_ms: first,
        last_ms: last,
        matches: []
      }
      hits.set(id, hit)
    }
    hit.first_ms = Math.min(hit.first_ms, first)
    hit.last_ms = Math.max(hit.last_ms, last)
    hit.matches.push({ kind: r.kind as IndexKind, key, first_ms: first, last_ms: last })
  }
  return [...hits.values()]
}

/** Known keys of a kind, for the search form's suggestions (prefix match). */
export async function replayIndexKeys(
  kind: IndexKind,
  prefix: string,
  limit = 20
): Promise<Array<{ key: string; recordings: number }>> {
  const p = prefix.trim().slice(0, KEY_MAX)
  const rows = (await db('nivaro_replay_index')
    .where('kind', kind)
    .modify((qb) => {
      if (p) qb.where('key', 'like', `${p}%`)
    })
    .groupBy('key')
    .orderByRaw('COUNT(*) DESC')
    .limit(limit * 2)
    .select('key')
    .count({ recordings: '*' })) as Array<{ key: string; recordings: number | string }>
  return rows
    .filter((r) => String(r.key).startsWith(p))
    .slice(0, limit)
    .map((r) => ({ key: String(r.key), recordings: Number(r.recordings) }))
}
