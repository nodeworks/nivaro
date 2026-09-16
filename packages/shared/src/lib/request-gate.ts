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

export function withGetCoalescing(client: NivaroClient): NivaroClient {
  if (isCoalesced(client)) return client
  const inflight = new Map<string, Promise<unknown>>()
  const request = <T>(command: Command<T>): Promise<T> => {
    const c = command as unknown as AnyCommand
    if (!isRead(c)) return client.request<T>(command)
    const key = commandKey(c)
    const current = inflight.get(key)
    if (current) return (current as Promise<T>).then(cloneResult)
    const p = client.request<T>(command).finally(() => {
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
