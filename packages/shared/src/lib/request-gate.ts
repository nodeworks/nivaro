import type { Command, NivaroClient } from '@nivaro/sdk'

/**
 * Two transport-level wrappers over a NivaroClient.
 *
 * `withGetCoalescing` — identical GETs in flight at the same moment share one
 * HTTP request. A record page mounts a dozen components that each ask for
 * the same collection metadata under their own query key (different cache
 * SHAPES, so the keys cannot merge); the wire request can. Only concurrent
 * calls coalesce — a repeat after the first resolves is a fresh request, so a
 * read that follows a write is never served a pre-write body. Followers get
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

function commandKey(c: AnyCommand): string {
  const method = (c._method ?? 'GET').toUpperCase()
  const body = method === 'GET' || c._body === undefined ? '' : JSON.stringify(c._body)
  return `${method} ${c._path ?? ''} ${c._params ? JSON.stringify(c._params) : ''} ${body}`
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
  'conditions'
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

export function withGetCoalescing(
  client: NivaroClient,
  opts: CoalescingOptions = {}
): NivaroClient {
  if (isCoalesced(client)) return client
  const inflight = new Map<string, Promise<unknown>>()
  const batch = opts.batchReads ? readBatcher(client) : null
  const request = <T>(command: Command<T>): Promise<T> => {
    const c = command as unknown as AnyCommand
    if (!isRead(c)) return client.request<T>(command)
    const key = commandKey(c)
    const current = inflight.get(key)
    if (current) return (current as Promise<T>).then(cloneResult)
    const read = batch ? batchableRead(c) : null
    const sent = read && batch ? batch<T>(command, read) : client.request<T>(command)
    const p = sent.finally(() => {
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
          if (next && !was) flush()
        }
      if (prop === 'dispose')
        return () => {
          if (disposeTimer !== undefined) return
          disposeTimer = setTimeout(() => {
            disposeTimer = undefined
            open = true
            flush()
          }, 0)
        }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  return proxied as GatedClient
}
