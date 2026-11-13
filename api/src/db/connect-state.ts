/**
 * What a pool knows about OPENING connections, kept so that a request which could not get
 * one can be answered truthfully.
 *
 * Why: when a request gives up waiting for a connection, knex says one thing whatever the
 * cause — "Timeout acquiring a connection. The pool is probably full". Two very different
 * situations hide behind it. Every connection is in use and the request must wait its turn
 * (the server is busy; the database is fine). Or the pool keeps trying to open a connection
 * for the waiting request and the database will not give it one (refused logins once the
 * retry has run out, a server that is not there). A full pool is not a dead database, and a
 * dead database is not a full pool: the first answers 503 SERVER_BUSY, the second 503
 * DB_UNAVAILABLE (lib/db-unavailable.ts reads the note this module leaves on the error).
 *
 * How they are told apart: by what the pool's own opens did while this request waited.
 * A failed open with none succeeding since, or an open that has been in flight far longer
 * than a healthy one takes, means the pool could not connect. A pool at its maximum opens
 * nothing, so it never looks like that.
 *
 * Every error thrown while acquiring a connection is stamped, not only the timeout: an
 * error from this seam is proof that the request never held a connection, so nothing of its
 * statement was sent.
 *
 * Per pool, on the knex instance (like db/connect-retry.ts): the health probe's own pool is
 * left alone. Attach this BEFORE the connect retry, so each retried attempt is counted.
 */
import { markNoConnection } from '../lib/db-unavailable.js'

export interface OpenState {
  /** When an open last succeeded / failed (ms; 0 = never). */
  okAt: number
  failAt: number
  /** Failed opens since the last one that succeeded. */
  failsSinceOk: number
  /** Opens that have neither answered nor failed yet. */
  inFlight: Set<{ at: number }>
}

/** A healthy open takes well under a second; one still in flight after this is not coming. */
const STUCK_OPEN_MS = 5000

export interface ConnectStateOptions {
  stuckOpenMs?: number
  /** Tests: a clock. */
  now?: () => number
}

/**
 * Whether the pool was failing to open connections for a request that has been waiting
 * since `waitingSince`.
 */
export function opensFailing(
  state: OpenState,
  waitingSince: number,
  now: number,
  stuckOpenMs: number = STUCK_OPEN_MS
): boolean {
  if (state.failsSinceOk > 0 && state.failAt >= waitingSince) return true
  for (const open of state.inFlight) if (now - open.at >= stuckOpenMs) return true
  return false
}

const STATE = Symbol.for('nivaro.connectState')
type Driver = {
  acquireRawConnection?: () => Promise<unknown>
  acquireConnection?: () => Promise<unknown>
  [STATE]?: OpenState
}

/** The open state of this knex instance's pool (null when nothing was attached). */
export function connectStateOf(knexInstance: { client?: unknown }): OpenState | null {
  return (knexInstance.client as Driver | undefined)?.[STATE] ?? null
}

/**
 * Track THIS knex instance's connection opens and stamp the errors its pool throws while a
 * caller is acquiring a connection. `pool` names it in the note ('main', 'background', 'read').
 */
export function attachConnectState(
  knexInstance: { client?: unknown },
  pool: string,
  opts: ConnectStateOptions = {}
): void {
  const client = knexInstance.client as Driver | undefined
  if (!client || typeof client.acquireRawConnection !== 'function' || client[STATE]) return
  const now = opts.now ?? Date.now
  const stuckOpenMs = opts.stuckOpenMs ?? STUCK_OPEN_MS
  const state: OpenState = { okAt: 0, failAt: 0, failsSinceOk: 0, inFlight: new Set() }
  client[STATE] = state

  const rawOpen = client.acquireRawConnection
  client.acquireRawConnection = async function trackedOpen(this: Driver) {
    const flight = { at: now() }
    state.inFlight.add(flight)
    try {
      const conn = await rawOpen.call(this)
      state.okAt = now()
      state.failsSinceOk = 0
      return conn
    } catch (err) {
      state.failAt = now()
      state.failsSinceOk++
      throw err
    } finally {
      state.inFlight.delete(flight)
    }
  }

  const acquire = client.acquireConnection
  if (typeof acquire !== 'function') return
  client.acquireConnection = async function notedAcquire(this: Driver) {
    const waitingSince = now()
    try {
      return await acquire.call(this)
    } catch (err) {
      throw markNoConnection(err, {
        pool,
        opensFailing: opensFailing(state, waitingSince, now(), stuckOpenMs)
      })
    }
  }
}
