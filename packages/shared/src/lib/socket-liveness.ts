import { clientSocketGone } from './client-chaos'

/**
 * Silent connection self-repair (realtime 24).
 *
 * A socket can say "connected" while nothing reaches it any more: the machine slept, the Wi-Fi
 * changed, a proxy dropped the TCP connection without a close. socket.io notices only when its
 * heartbeat runs out (up to 45 s, longer while a background tab's timers are throttled), and a
 * plain drop waits out the reconnect backoff — long enough for the "Live updates paused" banner.
 *
 * This watches one connection and repairs it before anyone sees anything:
 * - it remembers when the server was last heard (socket.io's heartbeat and every packet);
 * - silence past `silenceMs`, a timer that fired far too late (the machine slept), the tab
 *   coming back after a while out of sight, the browser going online again or the network
 *   changing each send one PROBE — a `time:sync`, which every server version answers;
 * - no answer within `probeTimeoutMs`, a heartbeat timeout, or a drop right after a wake is
 *   repaired at once: close, open, sign in again, and the normal catch-up replays what was
 *   missed from the journal. While a repair runs the realtime status carries `repair:
 *   'silent'`, which the banner and the "May be stale" marks ignore;
 * - a repair that has not signed in again within `repairWindowMs` tries once more; after
 *   `maxRepairs` failures it stops being quiet (the banner shows, socket.io keeps retrying)
 *   until the connection comes back on its own.
 *
 * It never repairs a socket the app closed on purpose (`io client disconnect`: sign-out, the
 * browser chaos drill), one the server sent away (`io server disconnect`: session ended,
 * unauthenticated), or one that never signed in. Twin: the shared worker's copy in
 * api/src/services/realtime-worker-source.ts (the one socket of every tab in worker mode).
 */

export interface LivenessPort {
  connected(): boolean
  /** Ask the server something it always answers; call `answered` when it does. */
  probe(answered: () => void): void
  /** Close the connection and open it again now. */
  reconnect(): void
}

export interface LivenessOptions {
  /** Nothing heard for this long while connected = probe (default 40 s; heartbeats are 25 s). */
  silenceMs?: number
  /** A probe with no answer after this = the connection is dead (default 5 s). */
  probeTimeoutMs?: number
  /** How often the watch runs (default 5 s). */
  tickMs?: number
  /**
   * A watch tick this late = the machine slept or the tab was frozen (default 75 s: above the
   * one-minute timer throttling of a background tab, so a hidden tab is not probed every minute).
   */
  sleepGapMs?: number
  /** A drop this soon after a wake signal is repaired quietly (default 15 s). */
  wakeWindowMs?: number
  /** A repair not signed in again after this has failed (default 12 s). */
  repairWindowMs?: number
  /** Quiet repairs in a row before the banner is allowed (default 2). */
  maxRepairs?: number
  now?: () => number
  /** True while the socket is kept down on purpose (a browser chaos drill). */
  held?: () => boolean
}

export interface LivenessStats {
  probes: number
  failedProbes: number
  repairs: number
  repaired: number
  gaveUp: number
}

/** How a quiet repair ended: signed in again, or it stopped being quiet. */
export type RepairOutcome = 'repaired' | 'gave-up'

export interface LivenessHandle {
  /** A quiet repair is running. */
  repairing(): boolean
  /**
   * Told on every change of `repairing()`; an end says how it ended. Hosts keep the status quiet
   * after `repaired` until the reconnect's catch-up has answered (its "resumed" line included).
   * Returns unsubscribe.
   */
  onRepairing(cb: (on: boolean, outcome?: RepairOutcome) => void): () => void
  stats(): LivenessStats
}

export interface Liveness extends LivenessHandle {
  /** The server was heard (a heartbeat or any packet). */
  heard(): void
  /** The connection is signed in (`auth:ok`). */
  up(): void
  /** The connection dropped, with socket.io's reason. */
  down(reason?: string): void
  /** Something suggests the connection may be dead: check it now. */
  wake(reason: string): void
  /** Run one watch tick now (tests; the interval calls it). */
  tick(): void
  stop(): void
}

/** Drops the app or the server meant: never repaired. */
const INTENTIONAL = new Set(['io client disconnect', 'io server disconnect'])

export function createLiveness(port: LivenessPort, opts: LivenessOptions = {}): Liveness {
  const now = opts.now ?? Date.now
  const silenceMs = opts.silenceMs ?? 40_000
  const probeTimeoutMs = opts.probeTimeoutMs ?? 5000
  const tickMs = opts.tickMs ?? 5000
  const sleepGapMs = opts.sleepGapMs ?? 75_000
  const wakeWindowMs = opts.wakeWindowMs ?? 15_000
  const repairWindowMs = opts.repairWindowMs ?? 12_000
  const maxRepairs = opts.maxRepairs ?? 2
  const held = () => {
    try {
      return opts.held?.() === true
    } catch {
      return false
    }
  }

  let everUp = false
  let isUp = false
  let lastHeard = now()
  let lastTick = now()
  let lastWakeAt = 0
  let lastDownReason: string | undefined
  let probing = false
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  let repairing = false
  let attempts = 0
  let gaveUp = false
  let repairTimer: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<(on: boolean, outcome?: RepairOutcome) => void>()
  const stats: LivenessStats = { probes: 0, failedProbes: 0, repairs: 0, repaired: 0, gaveUp: 0 }

  const setRepairing = (on: boolean, outcome?: RepairOutcome) => {
    if (on === repairing) return
    repairing = on
    for (const l of [...listeners]) {
      try {
        l(on, outcome)
      } catch {
        /* one listener must not stop the rest */
      }
    }
  }

  const clearRepairTimer = () => {
    if (repairTimer) clearTimeout(repairTimer)
    repairTimer = null
  }

  const giveUp = () => {
    gaveUp = true
    attempts = 0
    clearRepairTimer()
    stats.gaveUp++
    setRepairing(false, 'gave-up')
  }

  const repair = () => {
    if (gaveUp || held()) return
    if (attempts >= maxRepairs) {
      giveUp()
      return
    }
    attempts++
    stats.repairs++
    // Flag first: the drop our own reconnect causes must read as part of this repair.
    setRepairing(true)
    clearRepairTimer()
    repairTimer = setTimeout(() => {
      repairTimer = null
      if (repairing) repair()
    }, repairWindowMs)
    try {
      port.reconnect()
    } catch {
      /* the window timer tries again */
    }
  }

  const check = () => {
    if (probing || repairing || gaveUp || held()) return
    probing = true
    stats.probes++
    let settled = false
    probeTimer = setTimeout(() => {
      probeTimer = null
      if (settled) return
      settled = true
      probing = false
      // Dropped while asking: the drop is handled on its own.
      if (!port.connected()) return
      stats.failedProbes++
      repair()
    }, probeTimeoutMs)
    try {
      port.probe(() => {
        if (settled) return
        settled = true
        probing = false
        if (probeTimer) clearTimeout(probeTimer)
        probeTimer = null
        lastHeard = now()
      })
    } catch {
      /* the timer decides */
    }
  }

  const wake = () => {
    lastWakeAt = now()
    if (!everUp || gaveUp || repairing || held()) return
    if (port.connected()) {
      if (isUp) check()
      return
    }
    // Down already (it died while asleep): reconnect now instead of waiting out the backoff —
    // unless the app or the server closed it on purpose.
    if (lastDownReason && INTENTIONAL.has(lastDownReason)) return
    repair()
  }

  const interval = setInterval(() => api.tick(), tickMs)
  ;(interval as { unref?: () => void }).unref?.()

  const api: Liveness = {
    heard() {
      lastHeard = now()
    },
    up() {
      everUp = true
      isUp = true
      lastHeard = now()
      lastDownReason = undefined
      gaveUp = false
      if (repairing) {
        stats.repaired++
        attempts = 0
        clearRepairTimer()
        setRepairing(false, 'repaired')
      } else attempts = 0
    },
    down(reason) {
      isUp = false
      lastDownReason = reason
      if (probeTimer) clearTimeout(probeTimer)
      probeTimer = null
      probing = false
      // Our own reconnect, or an attempt that failed: the repair window judges it.
      if (repairing || !everUp || gaveUp || held()) return
      if (reason && INTENTIONAL.has(reason)) return
      if (reason === 'ping timeout' || now() - lastWakeAt <= wakeWindowMs) repair()
    },
    wake() {
      wake()
    },
    tick() {
      const t = now()
      const gap = t - lastTick
      lastTick = t
      if (gap > sleepGapMs) {
        wake()
        return
      }
      if (isUp && port.connected() && t - lastHeard > silenceMs) check()
    },
    repairing: () => repairing,
    onRepairing(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    stats: () => ({ ...stats }),
    stop() {
      clearInterval(interval)
      clearRepairTimer()
      if (probeTimer) clearTimeout(probeTimer)
      probeTimer = null
      listeners.clear()
    }
  }
  return api
}

// ─── Wake signals from the page ────────────────────────────────────────────────────────────

/** Back in sight after at least this long hidden = a wake (timers were throttled meanwhile). */
export const HIDDEN_WAKE_MS = 30_000

/**
 * The browser's hints that a connection may have died: online again, the network changed, the
 * page restored from the back/forward cache or resumed from a freeze, or the tab back in sight
 * after `HIDDEN_WAKE_MS`. Returns unsubscribe. A no-op outside a browser page.
 */
export function onWakeSignals(cb: (reason: string) => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const offs: Array<() => void> = []
  const on = (
    target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | undefined | null,
    type: string,
    fn: (e: any) => void
  ) => {
    if (!target) return
    target.addEventListener(type, fn)
    offs.push(() => target.removeEventListener(type, fn))
  }
  let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : 0
  on(window, 'online', () => cb('online'))
  on(window, 'pageshow', (e: { persisted?: boolean }) => {
    if (e?.persisted) cb('restored')
  })
  on(document, 'resume', () => cb('resumed'))
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0
    hiddenAt = 0
    if (away >= HIDDEN_WAKE_MS) cb('visible')
  })
  const conn = (navigator as { connection?: EventTarget }).connection
  on(conn, 'change', () => cb('network'))
  return () => {
    for (const off of offs) off()
  }
}

// ─── One watch per socket ──────────────────────────────────────────────────────────────────

const handles = new WeakMap<object, LivenessHandle>()

/** The repair state of a socket, when one is watched (a real socket or a worker facade). */
export function livenessOf(socket: object | null | undefined): LivenessHandle | null {
  return socket ? (handles.get(socket) ?? null) : null
}

/** A socket-shaped object that watches elsewhere (the shared worker facade) says so here. */
export function registerLiveness(socket: object, handle: LivenessHandle): void {
  handles.set(socket, handle)
}

/** The slice of a socket.io-client `Socket` the watch uses. */
export interface LivenessSocket {
  connected: boolean
  on(event: string, cb: (...args: any[]) => void): unknown
  emit(event: string, ...args: any[]): unknown
  connect(): unknown
  disconnect(): unknown
  volatile?: { emit(event: string, ...args: any[]): unknown }
  /** socket.io's Manager (typed loosely: its `on` takes only its own reserved event names). */
  io?: object
}

/**
 * Watch a real socket.io-client socket (idempotent; returns the existing watch). A socket-shaped
 * object without socket.io's manager (a worker facade, a test double) gets none unless it
 * registered its own — null then.
 */
export function attachSocketLiveness(
  socket: LivenessSocket | null | undefined,
  opts: LivenessOptions = {}
): LivenessHandle | null {
  if (!socket) return null
  const known = handles.get(socket)
  if (known) return known
  const manager = socket.io as
    | { on?: (event: string, cb: (...args: any[]) => void) => unknown }
    | undefined
  if (!manager || typeof manager.on !== 'function') return null
  const onManager = manager.on.bind(manager)
  const live = createLiveness(
    {
      connected: () => socket.connected,
      probe: (answered) => {
        // `time:sync` is answered by every server version (clock sync, #2132). Volatile: a
        // probe never queues up behind a dead connection to be sent after the reconnect.
        const target = socket.volatile ?? socket
        target.emit('time:sync', { c: Date.now() }, () => answered())
      },
      reconnect: () => {
        socket.disconnect()
        socket.connect()
      }
    },
    { held: clientSocketGone, ...opts }
  )
  onManager('ping', () => live.heard())
  onManager('packet', () => live.heard())
  socket.on('auth:ok', () => live.up())
  socket.on('disconnect', (reason?: string) => live.down(reason))
  onWakeSignals((reason) => live.wake(reason))
  handles.set(socket, live)
  return live
}
