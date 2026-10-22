/**
 * Browser chaos mode (#2840) — this tab's own requests fail or slow down for a set time, so a
 * tester can watch error boundaries, retry UI, autosave and the offline outbox do their job
 * without injecting anything on the server or for anyone else.
 *
 * One engine, every request path:
 * - `installClientChaosFetch()` wraps `window.fetch` (the SDK clients, widget renderers and raw
 *   fetches). Install it FIRST at boot, before any module creates an SDK client: a client keeps
 *   the fetch it saw when it was created.
 * - `clientChaosAxiosInterceptor(AxiosError)` is a request interceptor for an axios instance
 *   (admin's lib/api.ts); a faked failure swaps the adapter so the response interceptors run on
 *   it exactly as on a real one.
 * - `bindClientChaosSocket(socket)` drops the realtime socket for "socket gone" and lets it
 *   reconnect when the window ends. The SharedWorker's socket is shared by every tab, so the
 *   worker is never told: the tab's own facade (worker-socket.ts `chaosPause`) goes quiet
 *   instead, which is all this tab can see of the socket anyway.
 *
 * Faked failures look exactly like real ones to app code (a fetch TypeError, a proxy's 503,
 * Fastify's 500 body, axios's own AxiosError shapes). What tells them apart is the
 * `x-nivaro-client-chaos` header: on a faked Response, and on the error reporter's own requests
 * (`/issues/client`, `/rum`, `/connection-reports`) while chaos is on, so crashes it provokes are
 * not filed as real bugs.
 *
 * State lives in sessionStorage (this tab, survives a reload) with a hard expiry; every read
 * checks it, so a fault never outlives its window even if no timer fires. Never faked: sign-in
 * and sign-out, `/api/chaos/*` (the gate), and the error reporter.
 *
 * "Pretend down" (#2858) rides the same engine: a design-mode surface names the dependencies it
 * pretends are down as URL patterns (memory only, gone on reload or when the surface closes)
 * and the matching requests fail through the real error paths.
 */

export const CLIENT_CHAOS_HEADER = 'x-nivaro-client-chaos'
export const CLIENT_CHAOS_STORAGE_KEY = 'nvr-client-chaos'

export type ClientChaosPreset = 'flaky' | 'api-down' | 'slow' | 'offline' | 'socket-gone'

export interface ClientChaosState {
  v: 1
  /** null when only "fail my next N saves" is on. */
  preset: ClientChaosPreset | null
  /** flaky: share of requests that fail (%); slow: added milliseconds. Ignored otherwise. */
  strength: number
  /** Writes (POST/PATCH/PUT/DELETE that save something) still to fail. */
  failWrites: number
  startedAt: number
  endsAt: number
}

export interface ClientChaosStart {
  preset: ClientChaosPreset | null
  durationMs: number
  strength?: number
  failWrites?: number
}

export const CLIENT_CHAOS_MIN_MS = 10_000
export const CLIENT_CHAOS_MAX_MS = 30 * 60_000
export const CLIENT_CHAOS_MAX_FAIL_WRITES = 50

/** The strength each preset starts with, and its range. */
export const CLIENT_CHAOS_STRENGTH: Record<
  'flaky' | 'slow',
  { min: number; max: number; step: number; initial: number }
> = {
  flaky: { min: 5, max: 90, step: 5, initial: 30 },
  slow: { min: 250, max: 10_000, step: 250, initial: 2000 }
}

/** Who may turn browser chaos on. #2862 widens this to chaos operators. */
export function canUseClientChaos(
  user: { is_admin?: boolean | null; masquerade?: boolean | null } | null | undefined
): boolean {
  // A View-as tab acts as someone else: their requests are not the tester's to break.
  return !!user?.is_admin && !user.masquerade
}

// ── State ─────────────────────────────────────────────────────────────────────

let state: ClientChaosState | null = null
let loaded = false
let endTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

/** Pretend-down layers, by the surface that set them (#2858). Memory only. */
export interface PretendDownDependency {
  id: string
  label: string
  /** Request paths (after `/api`) this dependency serves. */
  patterns: RegExp[]
  /** The status a request to it answers with while pretended down (default 503). */
  status?: number
  /** Pretending this one down also drops the realtime socket. */
  socket?: boolean
}
const pretend = new Map<string, PretendDownDependency[]>()
let pretendVersion = 0

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function persist(): void {
  const s = storage()
  if (!s) return
  try {
    if (state) s.setItem(CLIENT_CHAOS_STORAGE_KEY, JSON.stringify(state))
    else s.removeItem(CLIENT_CHAOS_STORAGE_KEY)
  } catch {
    /* storage full or blocked: memory still holds it, for this page only */
  }
}

function isState(v: unknown): v is ClientChaosState {
  const o = v as ClientChaosState | null
  return (
    !!o &&
    o.v === 1 &&
    typeof o.endsAt === 'number' &&
    typeof o.startedAt === 'number' &&
    typeof o.strength === 'number' &&
    typeof o.failWrites === 'number' &&
    (o.preset === null ||
      o.preset === 'flaky' ||
      o.preset === 'api-down' ||
      o.preset === 'slow' ||
      o.preset === 'offline' ||
      o.preset === 'socket-gone')
  )
}

function load(now: number): void {
  if (loaded) return
  loaded = true
  const s = storage()
  if (!s) return
  try {
    const raw = s.getItem(CLIENT_CHAOS_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    // A window that ended while the tab was closed, or one longer than any start allows
    // (a hand-edited value), is dropped on sight.
    if (
      isState(parsed) &&
      parsed.endsAt > now &&
      parsed.endsAt - parsed.startedAt <= CLIENT_CHAOS_MAX_MS
    ) {
      state = parsed
      scheduleEnd(now)
    } else s.removeItem(CLIENT_CHAOS_STORAGE_KEY)
  } catch {
    /* unreadable: nothing is on */
  }
}

function emit(): void {
  for (const l of [...listeners]) {
    try {
      l()
    } catch {
      /* one listener must not stop the rest */
    }
  }
}

function scheduleEnd(now: number): void {
  if (endTimer) clearTimeout(endTimer)
  endTimer = null
  if (!state) return
  endTimer = setTimeout(
    () => {
      endTimer = null
      // getClientChaos() clears an expired window and tells everyone.
      getClientChaos()
    },
    Math.max(0, state.endsAt - now) + 5
  )
}

/**
 * `sync` false = tell listeners on the next microtask: an expiry noticed inside a render (a
 * snapshot read) must not update other components during it.
 */
function clear(sync = true): void {
  if (endTimer) clearTimeout(endTimer)
  endTimer = null
  const had = state !== null
  state = null
  persist()
  if (!had) return
  if (sync) emit()
  else void Promise.resolve().then(emit)
}

/** The live window, or null. An ended window is cleared here, whoever asks first. */
export function getClientChaos(now = Date.now()): ClientChaosState | null {
  load(now)
  if (state && now >= state.endsAt) clear(false)
  // "Fail my next N saves" alone ends once the N are used up.
  if (state && state.preset === null && state.failWrites <= 0) clear(false)
  return state
}

export function startClientChaos(opts: ClientChaosStart, now = Date.now()): ClientChaosState {
  load(now)
  const durationMs = Math.min(
    CLIENT_CHAOS_MAX_MS,
    Math.max(CLIENT_CHAOS_MIN_MS, Math.round(opts.durationMs) || 0)
  )
  const range =
    opts.preset === 'flaky' || opts.preset === 'slow' ? CLIENT_CHAOS_STRENGTH[opts.preset] : null
  const strength = range
    ? Math.min(range.max, Math.max(range.min, Math.round(opts.strength ?? range.initial)))
    : 0
  const failWrites = Math.min(
    CLIENT_CHAOS_MAX_FAIL_WRITES,
    Math.max(0, Math.floor(opts.failWrites ?? 0))
  )
  state = {
    v: 1,
    preset: opts.preset,
    strength,
    failWrites,
    startedAt: now,
    endsAt: now + durationMs
  }
  persist()
  scheduleEnd(now)
  emit()
  return state
}

/** Stop: always clears this tab, whatever else is down. */
export function stopClientChaos(): void {
  load(Date.now())
  clear()
}

export function subscribeClientChaos(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Set (or with an empty list, clear) the dependencies one design surface pretends are down. */
export function setPretendDown(scope: string, deps: PretendDownDependency[]): void {
  const before = pretend.get(scope)
  if (!deps.length && !before) return
  if (deps.length) pretend.set(scope, deps)
  else pretend.delete(scope)
  pretendVersion += 1
  emit()
}

/** Window event after a pretend-down toggle: views that fetch outside react-query ask again. */
export const PRETEND_DOWN_EVENT = 'nvr:pretend-down'

/** The dependencies one surface pretends are down right now. */
export function getPretendDown(scope: string): PretendDownDependency[] {
  return pretend.get(scope) ?? []
}

export function clearPretendDown(scope: string): void {
  setPretendDown(scope, [])
}

/** Bumps whenever any surface changes what it pretends is down (for useSyncExternalStore). */
export function pretendDownVersion(): number {
  return pretendVersion
}

/** Whether the realtime socket should be down for this tab right now. */
export function clientSocketGone(now = Date.now()): boolean {
  if (getClientChaos(now)?.preset === 'socket-gone') return true
  for (const deps of pretend.values()) if (deps.some((d) => d.socket)) return true
  return false
}

/** True when anything at all is faked in this tab (the header marks telemetry then). */
export function clientChaosActive(now = Date.now()): boolean {
  return getClientChaos(now) !== null || pretend.size > 0
}

/** Test seam: forget everything, including what sessionStorage held. */
export function resetClientChaosForTests(): void {
  if (endTimer) clearTimeout(endTimer)
  endTimer = null
  state = null
  loaded = false
  pretend.clear()
  pretendVersion = 0
  listeners.clear()
}

// ── Deciding one request ──────────────────────────────────────────────────────

export type ClientChaosDecision =
  /** Untouched. `mark` set = add the chaos header (telemetry while chaos is on). */
  | { kind: 'pass'; mark: string | null }
  | { kind: 'delay'; ms: number }
  /** Rejects as the network would: no response at all. */
  | { kind: 'network'; delayMs: number; mark: string }
  /** A response the server or its proxy could have sent. */
  | {
      kind: 'status'
      delayMs: number
      status: number
      statusText: string
      body: string
      contentType: string
      mark: string
    }

/** The API path a URL addresses (`/items/x` for `…/api/items/x?…`), or null when not the API. */
export function clientChaosApiPath(url: string): string | null {
  let path = url
  try {
    path = new URL(
      url,
      typeof window !== 'undefined' && window.location ? window.location.href : 'http://local/'
    ).pathname
  } catch {
    path = url.split(/[?#]/)[0]
  }
  if (path === '/api') return '/'
  if (!path.startsWith('/api/')) return null
  return path.slice(4)
}

/** Requests chaos never touches: the gate, signing in and out, and the error reporter. */
const NEVER_FAKED =
  /^\/(chaos(\/|$)|auth\/(login|logout|callback|me)(\/|$)|issues\/client$|rum$|connection-reports$)/
/** The ones among them that report errors: marked while chaos is on. */
const TELEMETRY = /^\/(issues\/client|rum|connection-reports)$/

/** POSTs that read (a widget render, a batch read, a beacon) are not saves. */
const READ_POSTS =
  /^\/(items\/batch-read|items\/[^/]+\/aggregate|users\/cards|graphql(\/|$)|widgets-internal\/[^/]+\/render|record-views\/|presence\/|page-at|field-rules\/(evaluate|explain)|custom-queries\/[^/]+\/(run|execute)|search(\/|$)|realtime\/)/

export function isClientChaosWrite(method: string, apiPath: string): boolean {
  const m = method.toUpperCase()
  if (m === 'PATCH' || m === 'PUT' || m === 'DELETE') return true
  return m === 'POST' && !READ_POSTS.test(apiPath)
}

const PROXY_DOWN = { status: 503, statusText: 'Service Unavailable' }
const STATUS_TEXT: Record<number, string> = {
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
}

function jitter(rand: () => number, min: number, max: number): number {
  return Math.round(min + rand() * (max - min))
}

/**
 * What chaos does to one request. Counts a "fail my next save" when it uses one, so call it
 * once per request. `rand` and `now` are injectable for tests.
 */
export function decideClientChaos(
  req: { method?: string; url: string },
  rand: () => number = Math.random,
  now = Date.now()
): ClientChaosDecision {
  const s = getClientChaos(now)
  if (!s && pretend.size === 0) return { kind: 'pass', mark: null }
  const apiPath = clientChaosApiPath(req.url)
  if (apiPath === null) return { kind: 'pass', mark: null }
  const mark = s?.preset ?? (s ? 'fail-saves' : 'pretend-down')
  if (NEVER_FAKED.test(apiPath))
    return { kind: 'pass', mark: TELEMETRY.test(apiPath) ? mark : null }
  const method = (req.method ?? 'GET').toUpperCase()

  // Pretend down (#2858) first: a design surface asked for exactly these.
  for (const deps of pretend.values()) {
    const dep = deps.find((d) => d.patterns.some((p) => p.test(apiPath)))
    if (dep) {
      const status = dep.status ?? 503
      return {
        kind: 'status',
        delayMs: jitter(rand, 150, 600),
        status,
        statusText: STATUS_TEXT[status] ?? 'Service Unavailable',
        body: JSON.stringify({ error: `${dep.label} is unavailable` }),
        contentType: 'application/json; charset=utf-8',
        mark: 'pretend-down'
      }
    }
  }
  if (!s) return { kind: 'pass', mark: null }

  if (s.failWrites > 0 && isClientChaosWrite(method, apiPath)) {
    // A new object: the toolbar's snapshot changes with the count.
    state = { ...s, failWrites: s.failWrites - 1 }
    persist()
    emit()
    // Fastify's own 500 body: what an unhandled server error looks like.
    return {
      kind: 'status',
      delayMs: jitter(rand, 100, 400),
      status: 500,
      statusText: 'Internal Server Error',
      body: JSON.stringify({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal Server Error'
      }),
      contentType: 'application/json; charset=utf-8',
      mark: 'fail-saves'
    }
  }

  switch (s.preset) {
    case 'offline':
      return { kind: 'network', delayMs: 0, mark }
    case 'api-down':
      // What the proxy answers when no API instance is behind it.
      return {
        kind: 'status',
        delayMs: jitter(rand, 20, 120),
        ...PROXY_DOWN,
        body: 'Service Unavailable',
        contentType: 'text/plain; charset=utf-8',
        mark
      }
    case 'slow': {
      const ms = Math.max(0, Math.round(s.strength * (0.8 + rand() * 0.4)))
      return { kind: 'delay', ms }
    }
    case 'flaky': {
      if (rand() * 100 < s.strength)
        return { kind: 'network', delayMs: jitter(rand, 100, 1500), mark }
      return { kind: 'delay', ms: jitter(rand, 50, 800) }
    }
    default:
      return { kind: 'pass', mark: null }
  }
}

// ── Transports ────────────────────────────────────────────────────────────────

function abortError(): Error {
  try {
    return new DOMException('The user aborted a request.', 'AbortError')
  } catch {
    const e = new Error('The user aborted a request.')
    e.name = 'AbortError'
    return e
  }
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(abortError()) : Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return (input as Request).url
}

/** A fetch that applies this tab's chaos before handing off to `base`. */
export function withClientChaos(base: typeof fetch): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // The quiet path: nothing on, one map lookup and a storage read on first use only.
    if (!clientChaosActive()) return base(input, init)
    const method =
      init?.method ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
    const d = decideClientChaos({ method, url: requestUrl(input) })
    const signal =
      init?.signal ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null)
    switch (d.kind) {
      case 'pass': {
        if (!d.mark) return base(input, init)
        const headers = new Headers(
          init?.headers ??
            (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
        )
        headers.set(CLIENT_CHAOS_HEADER, d.mark)
        return base(input, { ...init, headers })
      }
      case 'delay':
        await sleep(d.ms, signal)
        return base(input, init)
      case 'network':
        await sleep(d.delayMs, signal)
        // Chromium's words for a request that never reached anything.
        throw new TypeError('Failed to fetch')
      case 'status':
        await sleep(d.delayMs, signal)
        return new Response(d.body, {
          status: d.status,
          statusText: d.statusText,
          headers: { 'content-type': d.contentType, [CLIENT_CHAOS_HEADER]: d.mark }
        })
    }
  }
  return wrapped as typeof fetch
}

let fetchInstalled = false

/**
 * Wrap `window.fetch` once. Call it before anything creates an SDK client (a client keeps the
 * fetch it was created with). Also keeps `navigator.onLine` honest for the offline preset.
 */
export function installClientChaosFetch(): void {
  if (fetchInstalled || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  fetchInstalled = true
  window.fetch = withClientChaos(window.fetch.bind(window))
  let wasOffline = false
  const syncOffline = () => {
    const offline = getClientChaos()?.preset === 'offline'
    if (offline === wasOffline) return
    wasOffline = offline
    setNavigatorOffline(offline)
  }
  subscribeClientChaos(syncOffline)
  syncOffline()
}

/** Make `navigator.onLine` read false (and fire `offline`) for the offline preset; undo after. */
function setNavigatorOffline(offline: boolean): void {
  try {
    if (offline)
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    else delete (navigator as unknown as Record<string, unknown>).onLine
  } catch {
    /* a browser that will not let us: the events alone still drive the banners */
  }
  try {
    window.dispatchEvent(new Event(offline ? 'offline' : 'online'))
  } catch {
    /* no window events here */
  }
}

/** The slice of an axios request config the interceptor reads and writes. */
interface AxiosLikeConfig {
  method?: string
  url?: string
  baseURL?: string
  headers?: Record<string, unknown> & { set?: (k: string, v: string) => unknown }
  signal?: AbortSignal | { aborted?: boolean } | null
  adapter?: unknown
}

type AxiosErrorCtor = new (
  message?: string,
  code?: string,
  config?: any,
  request?: any,
  response?: any
) => Error

function axiosUrl(c: AxiosLikeConfig): string {
  const url = c.url ?? ''
  if (/^https?:\/\//i.test(url) || !c.baseURL) return url
  return `${c.baseURL.replace(/\/$/, '')}/${url.replace(/^\//, '')}`
}

/**
 * A request interceptor for an axios instance. Pass the instance's `AxiosError` class so faked
 * failures are the same objects axios itself throws (this package does not depend on axios):
 *
 *   api.interceptors.request.use(clientChaosAxiosInterceptor(AxiosError))
 */
export function clientChaosAxiosInterceptor(AxiosError: AxiosErrorCtor) {
  return async <C extends AxiosLikeConfig>(config: C): Promise<C> => {
    if (!clientChaosActive()) return config
    const d = decideClientChaos({ method: config.method ?? 'get', url: axiosUrl(config) })
    const signal = (config.signal as AbortSignal | null | undefined) ?? null
    switch (d.kind) {
      case 'pass':
        if (d.mark && config.headers) {
          if (typeof config.headers.set === 'function')
            config.headers.set(CLIENT_CHAOS_HEADER, d.mark)
          else config.headers[CLIENT_CHAOS_HEADER] = d.mark
        }
        return config
      case 'delay':
        await sleep(d.ms, signal)
        return config
      case 'network':
        config.adapter = async () => {
          await sleep(d.delayMs, signal)
          // axios's xhr adapter, word for word.
          throw new AxiosError('Network Error', 'ERR_NETWORK', config, {})
        }
        return config
      case 'status':
        config.adapter = async () => {
          await sleep(d.delayMs, signal)
          let data: unknown = d.body
          if (d.contentType.startsWith('application/json')) {
            try {
              data = JSON.parse(d.body)
            } catch {
              /* stays text */
            }
          }
          const response = {
            data,
            status: d.status,
            statusText: d.statusText,
            headers: { 'content-type': d.contentType, [CLIENT_CHAOS_HEADER]: d.mark },
            config,
            request: {}
          }
          throw new AxiosError(
            `Request failed with status code ${d.status}`,
            d.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
            config,
            {},
            response
          )
        }
        return config
    }
  }
}

/** The socket surface chaos needs: a facade's `chaosPause`, else disconnect/connect. */
export interface ClientChaosSocket {
  chaosPause?: (down: boolean) => void
  connect?: () => unknown
  disconnect?: () => unknown
}

const boundSockets = new WeakSet<object>()

/**
 * Drop this socket while "socket gone" is on (or a pretend-down dependency asks for it) and let
 * it reconnect when that ends — through the host's own reconnect and catch-up paths. Idempotent
 * per socket; returns an unbind.
 */
export function bindClientChaosSocket(socket: ClientChaosSocket | null | undefined): () => void {
  if (!socket || boundSockets.has(socket)) return () => {}
  boundSockets.add(socket)
  let down = false
  const apply = () => {
    const want = clientSocketGone()
    if (want === down) return
    down = want
    try {
      if (typeof socket.chaosPause === 'function') socket.chaosPause(want)
      else if (want) socket.disconnect?.()
      else socket.connect?.()
    } catch {
      /* a socket that is already gone */
    }
  }
  const off = subscribeClientChaos(apply)
  apply()
  return () => {
    off()
    boundSockets.delete(socket)
  }
}
