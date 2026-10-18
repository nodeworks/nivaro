/**
 * In-process single-flight (#2452).
 *
 * The home dashboard asks the same question several times at once (two tiles
 * on one custom query, the same widget in two slots); every concurrent cache
 * miss used to run the SQL again. Callers that resolve to the SAME key while a
 * run is in flight now share that one run's promise.
 *
 * Rules that keep sharing exactly as safe as the cache it sits in front of:
 *   - The key must already encode everything that makes two answers differ
 *     (the cq: key carries the caller's scope values; read-gate prefixes the
 *     tenant). Authorisation stays per caller, BEFORE joining — only the run
 *     is shared.
 *   - Nothing is remembered once the run settles: a rejected run reaches the
 *     callers already waiting on it and nobody after. A resolved one is not
 *     reused either; caching stays the cache's job.
 *   - The map is bounded; past MAX_FLIGHTS a caller simply runs alone.
 *
 * Abort: each caller stops waiting when ITS signal aborts (its promise
 * rejects with AbortError) without touching the run. The run's own signal
 * aborts only once every attached caller has gone. Work already running is
 * never interrupted by this module — the signal is for work still queued.
 */

export interface FlightRun<C> {
  /** Aborted once every caller of this flight has gone away. */
  signal: AbortSignal
  /** The run has got past any queueing and is doing real work (see joinPending). */
  markStarted: () => void
  /** Per-flight context from opts.ctx (shared with every joiner). */
  ctx: C
}

export interface FlightOptions<C> {
  /** The caller's own abort signal (client disconnect). */
  signal?: AbortSignal
  /** false = join an existing flight only once it has started real work —
   *  a caller that already holds a read-gate slot must never wait on a
   *  flight that is itself still queued for one (#2452: no nested waits). */
  joinPending?: boolean
  /** Build the context of a NEW flight (not called for joiners). */
  ctx?: () => C
  /** A caller joined an existing flight; `started` says whether it already
   *  does real work (a joiner can still help a queued flight start). */
  onJoin?: (ctx: C, started: boolean) => void
}

interface Flight {
  promise: Promise<unknown>
  started: boolean
  controller: AbortController
  live: number
  pinned: boolean
  ctx: unknown
}

const MAX_FLIGHTS = 500
const flights = new Map<string, Flight>()
const stats = { led: 0, joined: 0, alone: 0 }
const NEVER = new AbortController().signal

export function abortError(message = 'Client went away while waiting'): Error {
  return Object.assign(new Error(message), { name: 'AbortError', statusCode: 499 })
}

function attach(flight: Flight, signal?: AbortSignal): void {
  if (!signal) {
    flight.pinned = true
    return
  }
  if (signal.aborted) return
  flight.live++
  signal.addEventListener(
    'abort',
    () => {
      flight.live--
      if (!flight.pinned && flight.live <= 0) flight.controller.abort()
    },
    { once: true }
  )
}

/** The caller's view of a shared promise: rejects when ITS signal aborts. */
function forCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

/**
 * Run `run` once for every concurrent caller of `key`. `shared` is true for a
 * caller that joined someone else's run; `ctx` is the flight's context.
 */
export function singleFlight<T, C = undefined>(
  key: string,
  run: (ctl: FlightRun<C>) => Promise<T>,
  opts: FlightOptions<C> = {}
): { promise: Promise<T>; shared: boolean; ctx: C } {
  const existing = flights.get(key)
  if (existing && (existing.started || opts.joinPending !== false)) {
    stats.joined++
    attach(existing, opts.signal)
    opts.onJoin?.(existing.ctx as C, existing.started)
    return {
      promise: forCaller(existing.promise as Promise<T>, opts.signal),
      shared: true,
      ctx: existing.ctx as C
    }
  }
  const ctx = (opts.ctx ? opts.ctx() : undefined) as C
  if (existing || flights.size >= MAX_FLIGHTS) {
    stats.alone++
    return {
      promise: forCaller(
        Promise.resolve().then(() =>
          run({ signal: opts.signal ?? NEVER, markStarted: () => {}, ctx })
        ),
        opts.signal
      ),
      shared: false,
      ctx
    }
  }
  const flight: Flight = {
    promise: Promise.resolve(),
    started: false,
    controller: new AbortController(),
    live: 0,
    pinned: false,
    ctx
  }
  attach(flight, opts.signal)
  if (!flight.pinned && flight.live === 0) flight.controller.abort()
  flights.set(key, flight)
  stats.led++
  const promise = (async () => {
    try {
      return await run({
        signal: flight.controller.signal,
        markStarted: () => {
          flight.started = true
        },
        ctx
      })
    } finally {
      if (flights.get(key) === flight) flights.delete(key)
    }
  })()
  // Every caller may have raced away on its own signal; the run's outcome
  // must never surface as an unhandled rejection.
  promise.catch(() => {})
  flight.promise = promise
  return { promise: forCaller(promise, opts.signal), shared: false, ctx }
}

export function singleFlightStats(): {
  in_flight: number
  led: number
  joined: number
  alone: number
} {
  return { in_flight: flights.size, ...stats }
}

/** Tests only. */
export function resetSingleFlight(): void {
  flights.clear()
  stats.led = 0
  stats.joined = 0
  stats.alone = 0
}
