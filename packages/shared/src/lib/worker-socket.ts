import { bindClientChaosSocket } from './client-chaos'
import { isSignedOut, onSignedIn, signedOutBackoff } from './signed-out'
import type { SocketLike } from './socket-realtime'

/**
 * One socket per browser (#2475): a socket.io-shaped object over a SharedWorker port.
 *
 * Every tab of one app attaches to the same SharedWorker (served by the API at
 * `/api/realtime/worker.js`), which owns the ONE Socket.io connection, signs it in, keeps the
 * union of every tab's rooms, runs one catch-up and routes events to the tabs that hold them.
 * This object is what a tab sees: `on/off/emit/once/onAny/connected`, the same surface the
 * host's real socket had, so chat, presence, the shared realtime adapter
 * (`createSocketRealtime`) and every other consumer keep working unchanged.
 *
 *   const socket = createWorkerSocket({
 *     url: '/api/realtime/worker.js', name: 'admin', app: 'admin',
 *     authToken: () => mintWsToken(),
 *     fallback: () => io(origin, options)
 *   })
 *
 * Fallback is first-class: no SharedWorker (Safari < 16, a cross-origin API, a View-as tab the
 * host excludes), a worker that never answers, a worker speaking another protocol, a worker
 * that goes silent, or a worker whose socket cannot connect while the API answers HTTP (only a
 * tab can read the SSE stream) — each swaps in the host's own socket, replaying the listeners
 * registered so far. The leader-tab model the host already has keeps working on that path.
 */

/** Must match REALTIME_WORKER_PROTO in api/src/services/realtime-worker-source.ts. */
export const WORKER_SOCKET_PROTO = 1

/** localStorage override: `nvr-realtime-worker` = 'off' keeps one socket per tab, 'on' forces a try. */
export const WORKER_SOCKET_PREF_KEY = 'nvr-realtime-worker'

type Listener = (...args: any[]) => void

export interface FallbackSocket extends SocketLike {
  once?(event: string, cb: Listener): unknown
  connect?(): unknown
  disconnect?(): unknown
}

export interface WorkerSocketOptions {
  /** Same-origin URL of the worker script. */
  url: string
  /** SharedWorker name: one worker per app on an origin (`admin`, `efp-new`). */
  name?: string
  /** `client:hello` app label. */
  app: string
  /** Extra `client:hello` features (the worker always adds `coalesce`). */
  features?: string[]
  /** Build fields for `client:hello` (client-version.ts `clientVersion()`). */
  version?: Record<string, unknown>
  /**
   * Mint a `/auth/ws-token` for the worker's socket (the worker asks one tab per connect). A
   * null answer (signed out, or no token to be had) backs this tab off: the worker's next asks
   * are answered null without calling this until the wait (1 s doubling to 5 min, jittered)
   * passes, or the tab hears a sign-in (signed-out.ts).
   */
  authToken: () => Promise<string | null>
  /** The host's own socket, created only when the worker cannot serve this tab. */
  fallback: () => FallbackSocket
  /** Told once when the mode settles, and again if the worker is abandoned later. */
  onMode?: (mode: 'worker' | 'fallback', reason: string) => void
  /**
   * How long to wait for the worker's greeting before falling back (default 15000: a cold
   * worker fetches its script and socket.io's client first, slow on a dev proxy).
   */
  readyTimeoutMs?: number
  /** No ping from the worker for this long = it is gone (default 20000). */
  silentMs?: number
}

export interface WorkerSocket extends FallbackSocket {
  once(event: string, cb: Listener): unknown
  onAny(cb: (event: string, ...args: any[]) => void): unknown
  offAny(cb: (event: string, ...args: any[]) => void): unknown
  listeners(event: string): Listener[]
  connect(): void
  disconnect(): void
  /** 'pending' until the worker greets or the fallback is taken. */
  mode(): 'pending' | 'worker' | 'fallback'
  /**
   * Browser chaos "socket gone" (#2840) for THIS tab: the worker's socket serves every tab, so
   * it is never touched — this tab hears a disconnect, gets no events and sends nothing until
   * the pause ends, then re-greets the worker (connect + auth:ok, as a new tab would) and
   * reloads what it may have missed (`nvr:catchup-full`). On the fallback socket it is a real
   * disconnect and connect.
   */
  chaosPause(down: boolean): void
  /**
   * The person signed in (a host that learns it outside the signed-out gate calls this; the gate's
   * own `noteSignedIn` does it for every worker socket): the worker asks this tab for a token now
   * instead of staying parked or waiting out its backoff.
   */
  signedIn(): void
  /** The transport the worker's socket uses (for status displays). */
  io: { engine: { transport: { name?: string }; once(ev: string, cb: () => void): void } }
}

/** True when this browser can share a socket between tabs. */
export function sharedWorkerSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).SharedWorker === 'function'
}

/** The person's override for this browser, when they set one (a support step). */
export function workerSocketPreference(): 'on' | 'off' | null {
  try {
    const v = localStorage.getItem(WORKER_SOCKET_PREF_KEY)
    return v === 'on' || v === 'off' ? v : null
  } catch {
    return null
  }
}

/**
 * Whether a host should try the worker: supported, not switched off for this browser, and the
 * worker URL on this page's origin (a SharedWorker script must be same-origin).
 */
export function shouldUseWorkerSocket(url: string): boolean {
  if (!sharedWorkerSupported()) return false
  const pref = workerSocketPreference()
  if (pref === 'off') return false
  try {
    return new URL(url, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

export function createWorkerSocket(opts: WorkerSocketOptions): WorkerSocket {
  const listeners = new Map<string, Set<Listener>>()
  const anyListeners = new Set<(event: string, ...args: any[]) => void>()
  let mode: 'pending' | 'worker' | 'fallback' = 'pending'
  let port: MessagePort | null = null
  let real: FallbackSocket | null = null
  let connected = false
  let transport: string | null = null
  let ackId = 0
  const acks = new Map<number, Listener>()
  const upgradeWaiters: Array<() => void> = []
  let lastPing = 0
  let readyTimer: ReturnType<typeof setTimeout> | null = null
  let silenceTimer: ReturnType<typeof setInterval> | null = null
  let closed = false
  let chaosDown = false
  // ws-token backoff (staging 2026-10-23: signed-out tabs sent ~35 token 401s a minute).
  let tokenFailures = 0
  let tokenRetryAt = 0
  let stopSignedIn: (() => void) | null = null

  const fire = (event: string, args: any[]) => {
    for (const cb of [...(listeners.get(event) ?? [])]) {
      try {
        cb(...args)
      } catch {
        /* one listener must not break the rest */
      }
    }
    for (const cb of [...anyListeners]) {
      try {
        cb(event, ...args)
      } catch {
        /* same */
      }
    }
  }

  const stopWorker = () => {
    if (readyTimer) clearTimeout(readyTimer)
    readyTimer = null
    if (silenceTimer) clearInterval(silenceTimer)
    silenceTimer = null
    if (port) {
      try {
        port.postMessage({ t: 'bye' })
        port.close()
      } catch {
        /* already gone */
      }
    }
    port = null
  }

  /** Swap in the host's own socket; everything registered so far moves over. */
  const fallbackNow = (reason: string) => {
    if (mode === 'fallback' || closed) return
    const wasConnected = connected
    stopWorker()
    mode = 'fallback'
    connected = false
    const s = opts.fallback()
    real = s
    // Socket gone (#2840) was already on for this tab: the new socket stays down with it.
    if (chaosDown) s.disconnect?.()
    for (const [event, set] of listeners) for (const cb of set) s.on(event, cb)
    // Named listeners sit on the real socket now; its onAny serves only the any-listeners.
    if (anyListeners.size) s.onAny?.((event, ...args) => fireAnyOnly(event, args))
    // A tab that was live through the worker hears the gap like a reconnect.
    if (wasConnected) fire('disconnect', ['worker-fallback'])
    opts.onMode?.('fallback', reason)
  }
  function fireAnyOnly(event: string, args: any[]) {
    for (const cb of [...anyListeners]) {
      try {
        cb(event, ...args)
      } catch {
        /* noop */
      }
    }
  }

  const greet = () =>
    post({
      t: 'hello',
      app: opts.app,
      features: opts.features ?? [],
      version: opts.version ?? {},
      active: typeof document === 'undefined' || document.visibilityState === 'visible'
    })

  const post = (msg: Record<string, unknown>) => {
    try {
      port?.postMessage(msg)
    } catch {
      fallbackNow('port-closed')
    }
  }

  const onWorkerMessage = (ev: MessageEvent) => {
    const msg = ev.data as Record<string, any> | undefined
    if (!msg || typeof msg !== 'object' || closed) return
    lastPing = Date.now()
    switch (msg.t) {
      case 'ready': {
        if (readyTimer) clearTimeout(readyTimer)
        readyTimer = null
        if (msg.proto !== WORKER_SOCKET_PROTO) return fallbackNow(`proto-${String(msg.proto)}`)
        mode = 'worker'
        if (!chaosDown) greet()
        silenceTimer = setInterval(() => {
          if (Date.now() - lastPing > (opts.silentMs ?? 20_000)) fallbackNow('worker-silent')
        }, 5_000)
        opts.onMode?.('worker', 'ready')
        return
      }
      case 'ping':
        post({ t: 'pong' })
        return
      case 'status': {
        connected = !!msg.connected
        const next = typeof msg.transport === 'string' ? msg.transport : null
        const upgraded = next === 'websocket' && transport !== 'websocket'
        transport = next
        if (upgraded) for (const cb of upgradeWaiters.splice(0)) cb()
        return
      }
      case 'need-token':
        // `signedOut` (worker proto 1, additive): this tab knows it is signed out, so the worker
        // parks until a `signed-in`; a bare null only backs it off. Older workers ignore it.
        void mintToken().then((token) =>
          post({ t: 'token', req: msg.req, token, ...(token ? {} : { signedOut: isSignedOut() }) })
        )
        return
      case 'ev': {
        // Socket gone for this tab (#2840): the worker's events are not this tab's to hear.
        if (chaosDown) return
        if (msg.event === 'connect') connected = true
        if (msg.event === 'disconnect') connected = false
        fire(String(msg.event), Array.isArray(msg.args) ? msg.args : [])
        return
      }
      case 'ack': {
        const cb = acks.get(msg.id)
        acks.delete(msg.id)
        cb?.(...(Array.isArray(msg.args) ? msg.args : []))
        return
      }
      case 'fallback':
        fallbackNow(String(msg.reason ?? 'worker'))
        return
      default:
        return
    }
  }

  /** The worker wants a token: ask the host, unless this tab is backing off after a refusal. */
  const mintToken = async (): Promise<string | null> => {
    if (Date.now() < tokenRetryAt) return null
    const token = await opts.authToken().catch(() => null)
    if (token) {
      tokenFailures = 0
      tokenRetryAt = 0
      return token
    }
    tokenFailures += 1
    tokenRetryAt = Date.now() + signedOutBackoff(tokenFailures)
    return null
  }

  const start = () => {
    if (!shouldUseWorkerSocket(opts.url)) return fallbackNow('unsupported')
    try {
      const worker = new SharedWorker(opts.url, { name: opts.name ?? opts.app })
      port = worker.port
      port.onmessage = onWorkerMessage
      port.onmessageerror = () => fallbackNow('message-error')
      worker.onerror = () => fallbackNow('worker-error')
      port.start()
      readyTimer = setTimeout(() => fallbackNow('no-greeting'), opts.readyTimeoutMs ?? 15_000)
    } catch {
      fallbackNow('construct-failed')
    }
    if (typeof window !== 'undefined') {
      const active = () => {
        if (mode === 'worker' && document.visibilityState === 'visible') post({ t: 'active' })
      }
      document.addEventListener('visibilitychange', active)
      window.addEventListener('focus', active)
      window.addEventListener('pagehide', () => {
        if (mode === 'worker') post({ t: 'bye' })
      })
    }
  }

  const socket: WorkerSocket = {
    get connected() {
      if (chaosDown && mode !== 'fallback') return false
      return mode === 'fallback' ? !!real?.connected : connected
    },
    on(event, cb) {
      const set = listeners.get(event) ?? new Set<Listener>()
      listeners.set(event, set)
      set.add(cb)
      if (mode === 'fallback') real?.on(event, cb)
      return socket
    },
    off(event, cb) {
      if (cb) listeners.get(event)?.delete(cb)
      else listeners.delete(event)
      if (mode === 'fallback') real?.off(event, cb)
      return socket
    },
    once(event, cb) {
      const wrapped: Listener = (...args) => {
        socket.off(event, wrapped)
        cb(...args)
      }
      return socket.on(event, wrapped)
    },
    onAny(cb) {
      const first = anyListeners.size === 0
      anyListeners.add(cb)
      if (mode === 'fallback' && first) real?.onAny?.((event, ...args) => fireAnyOnly(event, args))
      return socket
    },
    offAny(cb) {
      anyListeners.delete(cb)
      return socket
    },
    listeners(event) {
      return [...(listeners.get(event) ?? [])]
    },
    emit(event, ...args) {
      if (mode === 'fallback') return real?.emit(event, ...args)
      const last = args[args.length - 1]
      if (chaosDown) {
        // What the worker answers while its own socket is down: an empty ack, nothing sent.
        if (typeof last === 'function') setTimeout(() => (last as Listener)(), 0)
        return socket
      }
      if (typeof last === 'function') {
        const id = ++ackId
        acks.set(id, last as Listener)
        post({ t: 'emit', event, payload: args[0], ack: id })
      } else post({ t: 'emit', event, payload: args[0] })
      return socket
    },
    connect() {
      if (mode === 'fallback') real?.connect?.()
      else post({ t: 'connect' })
    },
    disconnect() {
      closed = true
      stopSignedIn?.()
      stopWorker()
      real?.disconnect?.()
    },
    signedIn() {
      tokenFailures = 0
      tokenRetryAt = 0
      if (mode !== 'worker' || closed) return
      // The worker parked or backed off its token asks: ask again now. An older worker does not
      // know `signed-in`; for it a visible tab's `active` restarts the asking.
      post({ t: 'signed-in' })
      if (typeof document === 'undefined' || document.visibilityState === 'visible')
        post({ t: 'active' })
    },
    mode: () => mode,
    chaosPause(down) {
      if (down === chaosDown || closed) return
      chaosDown = down
      if (mode === 'fallback') {
        if (down) real?.disconnect?.()
        else real?.connect?.()
        return
      }
      if (down) {
        const was = connected
        connected = false
        if (was) fire('disconnect', ['transport close'])
        return
      }
      // Back: greet the worker again (it answers status, connect and auth:ok to this tab only),
      // then reload what this tab missed while it was not listening.
      if (mode === 'worker') greet()
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nvr:catchup-full'))
    },
    io: {
      engine: {
        get transport() {
          return {
            get name() {
              return mode === 'fallback'
                ? real?.io?.engine?.transport?.name
                : (transport ?? undefined)
            }
          }
        },
        once(ev, cb) {
          if (ev === 'upgrade') upgradeWaiters.push(cb)
        }
      }
    }
  }

  // Signed in again (here or in another tab): ask for a token now, not when the wait ends.
  stopSignedIn = onSignedIn(() => socket.signedIn())

  start()
  bindClientChaosSocket(socket)
  return socket
}
