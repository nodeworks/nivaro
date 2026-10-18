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
 *     (the cq: key carries the caller's scope values; the tenant is prefixed
 *     by the caller of this module). Authorisation stays per caller, BEFORE
 *     joining — only the run is shared.
 *   - Nothing is remembered once the run settles: a rejected run reaches the
 *     callers already waiting on it and nobody after. A resolved one is not
 *     reused either; caching stays the cache's job.
 *   - The map is bounded; past MAX_FLIGHTS a caller simply runs alone.
 *
 * Abort: a flight aborts its run's signal only when EVERY caller attached to
 * it has gone (each passes its request's signal; a caller without one pins
 * the flight). One viewer closing a tab never cancels another's answer.
 */

export interface FlightRun {
  /** Aborted once every caller of this flight has gone away. */
  signal: AbortSignal
  /** The run has got past any queueing and is doing real work (see joinPending). */
  markStarted: () => void
}

export interface FlightOptions {
  /** The caller's own abort signal (client disconnect). */
  signal?: AbortSignal
  /** false = join an existing flight only once it has started real work —
   *  a caller that already holds a read-gate slot must never wait on a
   *  flight that is itself still queued for one (#2452: no nested waits). */
  joinPending?: boolean
}

interface Flight {
  promise: Promise<unknown>
  started: boolean
  controller: AbortController
  live: number
  pinned: boolean
}

const MAX_FLIGHTS = 500
const flights = new Map<string, Flight>()
const stats = { led: 0, joined: 0, alone: 0 }
const NEVER = new AbortController().signal

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

/**
 * Run `run` once for every concurrent caller of `key`. `shared` is true for a
 * caller that joined someone else's run.
 */
export function singleFlight<T>(
  key: string,
  run: (ctl: FlightRun) => Promise<T>,
  opts: FlightOptions = {}
): { promise: Promise<T>; shared: boolean } {
  const existing = flights.get(key)
  if (existing && (existing.started || opts.joinPending !== false)) {
    stats.joined++
    attach(existing, opts.signal)
    return { promise: existing.promise as Promise<T>, shared: true }
  }
  if (existing || flights.size >= MAX_FLIGHTS) {
    stats.alone++
    return {
      promise: Promise.resolve().then(() =>
        run({ signal: opts.signal ?? NEVER, markStarted: () => {} })
      ),
      shared: false
    }
  }
  const flight: Flight = {
    promise: Promise.resolve(),
    started: false,
    controller: new AbortController(),
    live: 0,
    pinned: false
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
        }
      })
    } finally {
      if (flights.get(key) === flight) flights.delete(key)
    }
  })()
  flight.promise = promise
  return { promise, shared: false }
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
