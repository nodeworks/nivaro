import type { Command, NivaroClient } from '@nivaro/sdk'
import { noteOwnWriteFromCommand } from './own-writes'

/**
 * Two transport-level wrappers over a NivaroClient.
 *
 * `withGetCoalescing` — identical GETs in flight at the same moment share one
 * HTTP request. A record page mounts a dozen components that each ask for
 * the same collection metadata under their own query key (different cache
 * SHAPES, so the keys cannot merge); the wire request can. Only concurrent
 * calls coalesce. A repeat after the first resolves is a fresh request too,
 * except the configuration reads `isSettledRead` names, reused for
 * SETTLED_READ_MS until any write (or `forgetSettledReads()`) drops them — so
 * a read that follows a write is never served a pre-write body. Followers get
 * a structured clone: consumers sort/mutate response arrays in place.
 *
 * `createGatedClient` — a client whose reads WAIT while its gate is closed.
 * A host that keeps several record tabs mounted at once wraps each hidden
 * tab's client so its mount + invalidation refetches queue until the tab is
 * shown again; the same call fired twice while closed runs once on open.
 * Writes (POST/PATCH/PUT/DELETE) and lock/draft traffic always pass — a
 * hidden tab must keep its edit lock alive and its draft mirrored.
 */

type AnyCommand = { _method?: string; _path?: string; _body?: unknown; _params?: unknown }

/**
 * The query string a command puts on the wire, as a stable key: the SDK drops
 * null/undefined params and stringifies the rest, so `{}`, `undefined`,
 * `{ layout_id: 5 }` vs `{ layout_id: '5' }` and key order are the SAME
 * request. Keying on raw JSON split them, and two components asking for one
 * URL in the same tick each paid a round trip.
 */
function paramsKey(params: unknown): string {
  if (!params || typeof params !== 'object') return ''
  const entries = Object.entries(params as Record<string, unknown>)
    .filter(([, v]) => v != null)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return entries.length ? new URLSearchParams(entries as [string, string][]).toString() : ''
}

function commandKey(c: AnyCommand): string {
  const method = (c._method ?? 'GET').toUpperCase()
  const body = method === 'GET' || c._body === undefined ? '' : JSON.stringify(c._body)
  return `${method} ${c._path ?? ''} ${paramsKey(c._params)} ${body}`
}

function isRead(c: AnyCommand): boolean {
  return (c._method ?? 'GET').toUpperCase() === 'GET'
}

/**
 * POSTs that are reads in everything but verb — a widget render, a child
 * summary, an integrity check, an owners batch, a preview. A hidden tab must
 * not run these either: they are the expensive half of a record load.
 * `record-views/touch` rolls the viewer's watermark, which a tab nobody is
 * looking at must not do; it runs on activation like the rest.
 */
const READ_LIKE_POSTS =
  /^\/(widgets-internal\/[^/]+\/render|items\/[^/]+\/[^/]+\/child-summary|items\/[^/]+\/auto-id-preview|config-conformance\/record\/.+\/check|pipelines\/instance\/[^/]+\/owners\/batch|addendums\/summary|at-risk\/evaluate|record-views\/.+\/touch)$/

function isGateable(c: AnyCommand): boolean {
  if (isRead(c)) return true
  if ((c._method ?? 'GET').toUpperCase() !== 'POST') return false
  return READ_LIKE_POSTS.test((c._path ?? '').split('?')[0])
}

function cloneResult<T>(v: T): T {
  if (v == null || typeof v !== 'object') return v
  try {
    return structuredClone(v)
  } catch {
    return v
  }
}

const COALESCED = Symbol('nivaro.coalesced')

export function isCoalesced(client: NivaroClient): boolean {
  return (client as unknown as Record<symbol, unknown>)[COALESCED] === true
}

export interface CoalescingOptions {
  /**
   * #1304: record reads (`GET /items/<c>` and `GET /items/<c>/<id>`) fired in
   * the same tick ride ONE `POST /items/batch-read`. Off by default — a host
   * opts in. A read the batch could not answer with 200 (or a batch that fails
   * as a whole) is re-sent on its own, so callers see exactly the response or
   * error they would have seen without batching. Writes never batch.
   */
  batchReads?: boolean
  /**
   * Collection metadata reads (`GET /collections/<name>`) asked for within
   * ~10 ms ride one `GET /collections?names=`. On by default; an older server
   * without the batch is detected and the loader steps aside. `false` opts out.
   */
  batchCollections?: boolean
}

/** The most reads one batch carries (the server's own cap). */
export const BATCH_READ_LIMIT = 20

const ITEM_READ_PATH = /^\/items\/([A-Za-z_][A-Za-z0-9_]*)(?:\/([^/?#]+))?$/
/** Second path segments that are routes, not record ids. */
const NOT_A_RECORD = new Set(['aggregate', 'export', 'distinct', 'resolve-paths', 'batch-read'])
/** The query keys the batch endpoint understands — the list route's own. */
const BATCH_QUERY_KEYS = new Set([
  'fields',
  'filter',
  'sort',
  'limit',
  'offset',
  'page',
  'search',
  'after',
  'count',
  'conditions',
  'labels'
])

export interface BatchableRead {
  collection: string
  id?: string
  query: Record<string, unknown>
}

/** The batch-read entry a GET command stands for, or null when it cannot batch. */
export function batchableRead(command: unknown): BatchableRead | null {
  const c = command as AnyCommand
  if ((c._method ?? 'GET').toUpperCase() !== 'GET') return null
  const m = ITEM_READ_PATH.exec(c._path ?? '')
  if (!m) return null
  const [, collection, id] = m
  if (id !== undefined && NOT_A_RECORD.has(id)) return null
  const params = (c._params ?? {}) as Record<string, unknown>
  const query: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    if (!BATCH_QUERY_KEYS.has(k)) return null
    query[k] = v
  }
  return id === undefined ? { collection, query } : { collection, id, query }
}

interface PendingRead {
  read: BatchableRead
  command: Command<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

interface BatchResult {
  status?: number
  data?: unknown
  meta?: Record<string, unknown>
}

function readBatcher(client: NivaroClient) {
  let pending: PendingRead[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const alone = (p: PendingRead) => client.request(p.command).then(p.resolve, p.reject)
  const send = async (group: PendingRead[]) => {
    if (group.length === 1) return alone(group[0])
    let results: BatchResult[] | undefined
    try {
      const body = (await client.request({
        _method: 'POST',
        _path: '/items/batch-read',
        _body: {
          reads: group.map((p, i) => ({
            key: String(i),
            collection: p.read.collection,
            ...(p.read.id !== undefined ? { id: p.read.id } : {}),
            query: p.read.query
          }))
        }
      } as Command<{ results: BatchResult[] }>)) as { results?: BatchResult[] }
      results = Array.isArray(body?.results) ? body.results : undefined
    } catch {
      results = undefined
    }
    group.forEach((p, i) => {
      const r = results?.[i]
      if (r?.status !== 200 || r === undefined) {
        void alone(p)
        return
      }
      p.resolve(p.read.id !== undefined ? { data: r.data } : { data: r.data, ...(r.meta ?? {}) })
    })
  }
  const flush = () => {
    timer = undefined
    const all = pending
    pending = []
    for (let i = 0; i < all.length; i += BATCH_READ_LIMIT)
      void send(all.slice(i, i + BATCH_READ_LIMIT))
  }
  return <T>(command: Command<T>, read: BatchableRead): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.push({
        read,
        command: command as Command<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject
      })
      if (timer === undefined) timer = setTimeout(flush, 0)
    })
}

// ─── Collection metadata batching ──────────────────────────────────────────

/** The most collections one `GET /collections?names=` carries (the server's cap). */
export const COLLECTION_BATCH_LIMIT = 50
/** How long the loader collects names before it sends. */
export const COLLECTION_BATCH_WINDOW_MS = 10

const COLLECTION_META_PATH = /^\/collections\/([A-Za-z_][A-Za-z0-9_-]{0,127})$/

/**
 * The collection a GET command reads the metadata of (`GET /collections/<name>`
 * with no query), or null. Sub-routes (`/collections/x/fields`) and reads with
 * params never batch.
 */
export function batchableCollectionMeta(command: unknown): string | null {
  const c = command as AnyCommand
  if ((c._method ?? 'GET').toUpperCase() !== 'GET') return null
  if (paramsKey(c._params) !== '') return null
  const m = COLLECTION_META_PATH.exec(c._path ?? '')
  return m ? m[1] : null
}

interface PendingMeta {
  name: string
  command: Command<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

/** The error the SDK throws for the single read's 404 — callers see no difference. */
function notFoundError(): Error {
  return Object.assign(new Error('Not found'), { status: 404, response: { error: 'Not found' } })
}

/**
 * Names asked for within COLLECTION_BATCH_WINDOW_MS ride one
 * `GET /collections?names=a,b,c` (chunks of COLLECTION_BATCH_LIMIT); each
 * caller still gets `{ data }` exactly as its own single read answers it.
 * A name the server lists as missing rejects like the single read's 404; a
 * name whose read failed server-side, and every name of a batch that failed
 * as a whole, is re-sent on its own — so one bad collection never fails the
 * others and errors keep their native shape. A server without the batch
 * (its list route answers an ARRAY) switches the loader off for good.
 */
function collectionMetaBatcher(client: NivaroClient) {
  let supported = true
  let pending: PendingMeta[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const alone = (p: PendingMeta) => client.request(p.command).then(p.resolve, p.reject)
  const send = async (group: PendingMeta[]) => {
    const names = [...new Set(group.map((p) => p.name))]
    if (names.length === 1 || !supported) {
      for (const p of group) void alone(p)
      return
    }
    let body: { data?: unknown; missing?: unknown; errors?: unknown } | undefined
    try {
      body = (await client.request({
        _method: 'GET',
        _path: '/collections',
        _params: { names: names.join(',') }
      } as Command<unknown>)) as typeof body
    } catch (err) {
      // An older server refuses the param outright — stop asking it.
      const status = (err as { status?: number })?.status
      if (status === 400 || status === 404 || status === 405) supported = false
      // A busy or failing server: re-sending every name alone would only add load to it.
      else if (status === 429 || (status !== undefined && status >= 500)) {
        for (const p of group) p.reject(err)
        return
      }
      body = undefined
    }
    const data = body?.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      if (Array.isArray(data)) supported = false
      for (const p of group) void alone(p)
      return
    }
    const byName = data as Record<string, unknown>
    const missing = new Set(Array.isArray(body?.missing) ? (body.missing as string[]) : [])
    for (const p of group) {
      if (Object.hasOwn(byName, p.name)) p.resolve({ data: cloneResult(byName[p.name]) })
      else if (missing.has(p.name)) p.reject(notFoundError())
      else void alone(p)
    }
  }
  const flush = () => {
    timer = undefined
    const all = pending
    pending = []
    // Chunk by distinct name; a name asked twice stays in one chunk.
    const chunks: PendingMeta[][] = []
    const chunkOf = new Map<string, PendingMeta[]>()
    for (const p of all) {
      let chunk = chunkOf.get(p.name)
      if (!chunk) {
        const last = chunks[chunks.length - 1]
        const lastNames = last ? new Set(last.map((x) => x.name)).size : COLLECTION_BATCH_LIMIT
        chunk = last && lastNames < COLLECTION_BATCH_LIMIT ? last : []
        if (chunk !== last) chunks.push(chunk)
        chunkOf.set(p.name, chunk)
      }
      chunk.push(p)
    }
    for (const chunk of chunks) void send(chunk)
  }
  return <T>(command: Command<T>, name: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.push({
        name,
        command: command as Command<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject
      })
      if (timer === undefined) timer = setTimeout(flush, COLLECTION_BATCH_WINDOW_MS)
    })
}

// ─── Settled metadata reads ────────────────────────────────────────────────

/**
 * Configuration reads a record page asks for from many components under many
 * query keys (different cache SHAPES, so the keys cannot merge), and not all
 * at the same moment — a panel that mounts after the record landed asks
 * again. Their answers change only when someone edits configuration, so an
 * answer is reused for SETTLED_READ_MS after it arrives. Any write through
 * this client (and `forgetSettledReads()`, which hosts with a second
 * transport call on their own writes) drops every settled answer at once.
 * Record data is never settled — a refetch after a live event must reach the
 * server.
 */
export const SETTLED_READ_MS = 3000
// `/users/me` too: the form (role), chat (preferences) and presence (id) each
// read it under their own key and shape, a few hundred ms apart on one load.
const SETTLED_READ_PATHS =
  /^\/(collections\/[A-Za-z_][A-Za-z0-9_-]*|field-config\/[A-Za-z_][A-Za-z0-9_-]*|collection-layouts(\/active|\/summary\/[A-Za-z_][A-Za-z0-9_-]*)?|chat\/room-types|users\/me)$/

/**
 * Writes a record page makes all the time that can never change
 * configuration (record data outside system tables, view/lock/draft/presence
 * bookkeeping, chat, rule evaluation, read-like POSTs — the people-card batch
 * and the file check are reads by POST, and each used to drop every settled
 * answer mid-load). Every other write drops the settled answers — erring wide
 * only costs a re-read.
 */
const NON_CONFIG_WRITES =
  /^\/(record-views|item-locks|drafts|presence|rum|comments|notifications|tasks|field-rules\/evaluate|chat\/(?!room-types)|field-config\/[^/]+\/(evaluate-visibility|evaluate-defaults|evaluate-lock|cascade|project)$|items\/(?!nivaro_|directus_)[^/]+|users\/cards$|files\/verify$)/

function cannotChangeConfig(c: AnyCommand): boolean {
  const path = (c._path ?? '').split('?')[0]
  if ((c._method ?? 'GET').toUpperCase() === 'POST' && READ_LIKE_POSTS.test(path)) return true
  return NON_CONFIG_WRITES.test(path)
}

/** Whether a GET command's answer may be reused for SETTLED_READ_MS. */
export function isSettledRead(command: unknown): boolean {
  const c = command as AnyCommand
  if (!isRead(c) || !SETTLED_READ_PATHS.test(c._path ?? '')) return false
  // `collection-layouts/active?item=` picks the layout from the record's values, which a
  // record save (never a config write) can change — that answer is record data.
  const params = c._params as Record<string, unknown> | undefined
  return !(params && params.item != null && /^\/collection-layouts\/active$/.test(c._path ?? ''))
}

/** Moves on every write (any client in this page) — an answer is reused only within its epoch. */
let settledEpoch = 0

/** Drop every settled metadata answer (call after a configuration write made outside the SDK client). */
export function forgetSettledReads(): void {
  settledEpoch++
}

interface SettledEntry {
  at: number
  epoch: number
  value: unknown
}

export function withGetCoalescing(
  client: NivaroClient,
  opts: CoalescingOptions = {}
): NivaroClient {
  if (isCoalesced(client)) return client
  const inflight = new Map<string, Promise<unknown>>()
  const batch = opts.batchReads ? readBatcher(client) : null
  const metaBatch = opts.batchCollections === false ? null : collectionMetaBatcher(client)
  const settled = new Map<string, SettledEntry>()
  let settledFor = settledEpoch
  const settle = (key: string, epoch: number, value: unknown) => {
    // An answer that was in flight across a write is not kept.
    if (epoch !== settledEpoch) return
    // A write since the last answer made every kept one useless: free them.
    if (settledFor !== settledEpoch) {
      settled.clear()
      settledFor = settledEpoch
    }
    const now = Date.now()
    for (const [k, e] of settled) if (now - e.at >= SETTLED_READ_MS) settled.delete(k)
    settled.set(key, { at: now, epoch, value })
  }
  const request = <T>(command: Command<T>): Promise<T> => {
    const c = command as unknown as AnyCommand
    if (!isRead(c)) {
      // Live hooks (lib/live.ts) drop events for records this tab just wrote —
      // noted before sending (the event can beat the response) and again with
      // the response so a create's new id counts.
      noteOwnWriteFromCommand(c._method, c._path, c._body)
      // A write that may change configuration drops settled answers, both now
      // and when it lands (a read sent meanwhile must not settle).
      const busts = !cannotChangeConfig(c)
      if (busts) forgetSettledReads()
      const sent = client.request<T>(command)
      return (busts ? sent.finally(forgetSettledReads) : sent).then((res) => {
        noteOwnWriteFromCommand(c._method, c._path, c._body, res)
        return res
      })
    }
    const key = commandKey(c)
    const settles = isSettledRead(c)
    if (settles) {
      const hit = settled.get(key)
      if (hit && hit.epoch === settledEpoch && Date.now() - hit.at < SETTLED_READ_MS)
        return Promise.resolve(cloneResult(hit.value as T))
    }
    const current = inflight.get(key)
    if (current) return (current as Promise<T>).then(cloneResult)
    const read = batch ? batchableRead(c) : null
    const metaName = !read && metaBatch ? batchableCollectionMeta(c) : null
    const sent =
      read && batch
        ? batch<T>(command, read)
        : metaName && metaBatch
          ? metaBatch<T>(command, metaName)
          : client.request<T>(command)
    const epoch = settledEpoch
    const p = sent
      .then((res) => {
        if (settles) settle(key, epoch, cloneResult(res))
        return res
      })
      .finally(() => {
        if (inflight.get(key) === p) inflight.delete(key)
      })
    inflight.set(key, p)
    return p
  }
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'request') return request
      if (prop === COALESCED) return true
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
}

export interface GatedClient extends NivaroClient {
  /** Open = pass everything through; closed = queue reads. */
  setOpen(open: boolean): void
  readonly open: boolean
  /**
   * Release everything still queued and stop gating. Call from the host's
   * unmount: react-query keeps an in-flight fetch alive after its observers
   * leave, so a queued request that is never released is a query stuck
   * "fetching" forever — a remount under the same keys dedupes onto it and
   * shows skeletons until the page reloads.
   */
  dispose(): void
}

const ALWAYS_PASS = /^\/(item-locks|drafts|auth)\b/

// Every closed gate's "release what you are holding" — see releaseGatedReads.
const gateReleasers = new Set<() => void>()

/**
 * Release every read that closed gates are holding, leaving each gate closed for
 * what comes next. The hosts share ONE react-query cache across their record
 * tabs, so a hidden tab's queued read and the visible tab's identical query are
 * the same query: the visible tab joins the fetch the hidden tab started and
 * waits on a gate nobody will open — a form stuck on skeletons with no error
 * until the hidden tab is shown (staging, 2026-10-22). releaseGatedReadsOnSharedFetch
 * calls this whenever an observer joins a query that is already fetching.
 */
export function releaseGatedReads(): void {
  for (const release of [...gateReleasers]) release()
}

type QueryCacheLike = {
  subscribe(
    listener: (event: { type: string; query: { state: { fetchStatus?: string } } }) => void
  ): () => void
}

/**
 * Wire releaseGatedReads to a react-query cache: when a component starts
 * observing a query that is already fetching, that fetch may be one a closed
 * gate is holding, so release the gates' queues. Returns the unsubscribe; call
 * it once at the host that mounts gated tabs (e.g. in an effect over the
 * QueryClient's getQueryCache()).
 */
export function releaseGatedReadsOnSharedFetch(cache: QueryCacheLike): () => void {
  return cache.subscribe((event) => {
    if (event.type !== 'observerAdded') return
    if (event.query.state.fetchStatus !== 'fetching') return
    if (gateReleasers.size === 0) return
    releaseGatedReads()
  })
}

/**
 * `opts.open` is the gate's state AT CONSTRUCTION. A host that starts a
 * hidden tab must pass `false` here rather than calling `setOpen(false)`
 * from an effect: React runs children's effects before the parent's, so
 * every react-query fetch under the provider has already fired by the time
 * a parent effect closes the gate — the first paint of a hidden tab would
 * still cost a full record load.
 */
export function createGatedClient(
  client: NivaroClient,
  opts: { open?: boolean } = {}
): GatedClient {
  let open = opts.open ?? true
  let disposeTimer: ReturnType<typeof setTimeout> | undefined
  const waiting = new Map<string, { promise: Promise<unknown>; release: () => void }>()
  const flush = () => {
    const entries = [...waiting.values()]
    waiting.clear()
    for (const w of entries) w.release()
  }
  // Registered only while something is queued, so releaseGatedReads touches
  // nothing when every gate is empty.
  const releaseHeld = () => {
    gateReleasers.delete(releaseHeld)
    flush()
  }
  const request = <T>(command: Command<T>): Promise<T> => {
    const c = command as unknown as AnyCommand
    if (open || !isGateable(c) || ALWAYS_PASS.test(c._path ?? '')) return client.request<T>(command)
    const key = commandKey(c)
    const existing = waiting.get(key)
    if (existing) return (existing.promise as Promise<T>).then(cloneResult)
    let release: () => void = () => {}
    const gateOpened = new Promise<void>((resolve) => {
      release = resolve
    })
    const promise = gateOpened.then(() => client.request<T>(command))
    waiting.set(key, { promise, release })
    gateReleasers.add(releaseHeld)
    return promise
  }
  const proxied = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'request') return request
      if (prop === 'open') return open
      if (prop === 'setOpen')
        return (next: boolean) => {
          // A setOpen right after dispose means the host was only
          // simulating an unmount (React StrictMode runs every effect's
          // cleanup and re-runs it on mount) — keep the queue.
          if (disposeTimer !== undefined) {
            clearTimeout(disposeTimer)
            disposeTimer = undefined
          }
          const was = open
          open = next
          if (next && !was) {
            gateReleasers.delete(releaseHeld)
            flush()
          }
        }
      if (prop === 'dispose')
        return () => {
          if (disposeTimer !== undefined) return
          disposeTimer = setTimeout(() => {
            disposeTimer = undefined
            open = true
            gateReleasers.delete(releaseHeld)
            flush()
          }, 0)
        }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  return proxied as GatedClient
}
