import type { Redis } from 'ioredis'
import { db } from '../db/index.js'

/**
 * Transition double-fire guard.
 *
 * Two identical transition requests for one record — a double-click, a
 * client retry after a slow response — both pass every gate, because both
 * read the record BEFORE either has moved it. The second then repeats the
 * side effects (partner pushes, emails) or fails halfway. The guard lets one
 * through and refuses the twin with a 409 that names the first.
 *
 * The claim is a Redis SET NX, so it holds across replicas. Without Redis
 * the guard falls back to the history row alone, which catches a repeat that
 * arrives after the first finished but not one running at the same moment.
 */

const DEFAULT_SECONDS = 10

let _redis: Redis | null = null
/** Wired once at boot, beside the event journal's Redis handle. */
export function setTransitionGuardRedis(redis: Redis | null): void {
  _redis = redis
}
let cached: { at: number; seconds: number } | null = null

export async function transitionGuardSeconds(): Promise<number> {
  if (cached && Date.now() - cached.at < 60_000) return cached.seconds
  let seconds = DEFAULT_SECONDS
  const env = process.env.TRANSITION_GUARD_SECONDS
  if (env != null && env !== '' && Number.isFinite(Number(env))) seconds = Number(env)
  try {
    const row = (await db('nivaro_settings').where({ id: 1 }).first('transition_guard_seconds')) as
      | { transition_guard_seconds: number | null }
      | undefined
    if (row?.transition_guard_seconds != null) seconds = Number(row.transition_guard_seconds)
  } catch {
    // column not there yet — the default stands
  }
  seconds = Math.max(0, Math.min(300, Math.round(seconds)))
  cached = { at: Date.now(), seconds }
  return seconds
}

export function bustTransitionGuardCache(): void {
  cached = null
}

export interface TransitionTwin {
  history_id: number | null
  at: string | null
  user: string | null
  user_name: string | null
  seconds_ago: number | null
}

export class TransitionDuplicateError extends Error {
  statusCode = 409
  code = 'TRANSITION_DUPLICATE'
  first: TransitionTwin
  constructor(first: TransitionTwin, label: string | null) {
    const who = first.user_name ? ` by ${first.user_name}` : ''
    const when =
      first.seconds_ago != null
        ? ` ${first.seconds_ago} second${first.seconds_ago === 1 ? '' : 's'} ago`
        : ' a moment ago'
    super(
      first.history_id != null
        ? `${label ? `"${label}"` : 'This transition'} was already made${when}${who}. Nothing was done twice.`
        : `${label ? `"${label}"` : 'This transition'} is already being made. Nothing was done twice.`
    )
    this.first = first
  }
}

async function recentTwin(
  instanceId: string,
  transitionId: string,
  seconds: number
): Promise<TransitionTwin | null> {
  const since = new Date(Date.now() - seconds * 1000)
  // The guard's own lookup must never be what stops a transition.
  const row = (await Promise.resolve()
    .then(() =>
      db('nivaro_workflow_history as h')
        .leftJoin('nivaro_users as u', 'u.id', 'h.user')
        .where('h.instance', instanceId)
        .where('h.transition', transitionId)
        .where('h.timestamp', '>=', since)
        .orderBy('h.id', 'desc')
        .first('h.id', 'h.timestamp', 'h.user', 'u.first_name', 'u.last_name')
    )
    .catch(() => undefined)) as
    | {
        id: number
        timestamp: Date
        user: string | null
        first_name: string | null
        last_name: string | null
      }
    | undefined
  if (!row) return null
  const at = new Date(row.timestamp)
  return {
    history_id: Number(row.id),
    at: at.toISOString(),
    user: row.user,
    user_name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    seconds_ago: Math.max(0, Math.round((Date.now() - at.getTime()) / 1000))
  }
}

export interface TransitionClaim {
  /** Give the claim back — the transition did not happen (a blocked push, a
   *  thrown error), so an immediate retry must be allowed. */
  release(): Promise<void>
}

const NOOP: TransitionClaim = { release: async () => {} }

/**
 * Claim the right to make this transition now. Throws
 * TransitionDuplicateError when a twin holds the claim or just finished.
 */
export async function claimTransition(opts: {
  instanceId: string
  transitionId: string
  label?: string | null
}): Promise<TransitionClaim> {
  const seconds = await transitionGuardSeconds()
  if (seconds <= 0) return NOOP
  const key = `nvr:transition:${String(opts.instanceId).toUpperCase()}:${String(opts.transitionId).toUpperCase()}`
  let claimed = false
  const redis = _redis
  if (redis) {
    try {
      const res = await redis.set(key, new Date().toISOString(), 'EX', seconds, 'NX')
      if (res !== 'OK') {
        const twin = await recentTwin(opts.instanceId, opts.transitionId, seconds)
        throw new TransitionDuplicateError(
          twin ?? { history_id: null, at: null, user: null, user_name: null, seconds_ago: null },
          opts.label ?? null
        )
      }
      claimed = true
    } catch (err) {
      if (err instanceof TransitionDuplicateError) throw err
      // Redis trouble — fall through to the history check
    }
  }
  if (!claimed) {
    const twin = await recentTwin(opts.instanceId, opts.transitionId, seconds)
    if (twin) throw new TransitionDuplicateError(twin, opts.label ?? null)
    return NOOP
  }
  return {
    release: async () => {
      await redis?.del(key).catch(() => {})
    }
  }
}
