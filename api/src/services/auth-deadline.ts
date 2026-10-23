/**
 * A time limit for the Redis reads that sign a request in (the session load, masquerade /
 * run-as-key / OAuth token lookups). The shared ioredis client has no command timeout and
 * queues commands while it reconnects, so a Redis that stops answering without dropping the
 * connection held every signed-in request open with no end. Past the limit the request fails
 * with 503 AUTH_BACKEND_TIMEOUT — a clean answer the client can retry — instead of hanging.
 *
 * Costs one timer per read; an answer inside the limit is returned unchanged.
 */

export const AUTH_READ_TIMEOUT_MS = 5000

export function authBackendTimeout(what: string): Error & { statusCode: number; code: string } {
  return Object.assign(
    new Error(`Signing in is unavailable right now (${what} did not answer). Try again shortly.`),
    { statusCode: 503, code: 'AUTH_BACKEND_TIMEOUT' }
  )
}

/** `work`, or a 503 AUTH_BACKEND_TIMEOUT once `ms` pass without an answer. */
export function withAuthDeadline<T>(
  work: Promise<T>,
  what: string,
  ms: number = AUTH_READ_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(authBackendTimeout(what)), ms)
    timer.unref?.()
  })
  // A late rejection from `work` after the deadline won must not surface as unhandled.
  work.catch(() => {})
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}
