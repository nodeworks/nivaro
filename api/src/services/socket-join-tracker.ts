/**
 * Joins before catch-up (post-mortem 3.3, found by the realtime CI failover suite).
 *
 * After a reconnect a client re-sends its joins (`collection:join`, `record:join`, `chat:join`
 * …) and then, at once, `catchup {cursor}`. The joins are asynchronous on the server (each
 * checks the room's gate first), so the catch-up used to read `socket.rooms` before any of them
 * had landed, replay nothing, and every event written during the reconnect was lost — on every
 * reconnect, and to everyone at once when a realtime process restarts.
 *
 * `trackJoins` wraps the socket's handlers for join events so each call's promise is kept until
 * it settles; the catch-up handler awaits `joinsSettled` (time-boxed) before it reads the rooms.
 * Old clients are fixed too: nothing changes on the wire.
 */

type Listener = (...args: unknown[]) => unknown

/** Events that put a socket in a room the catch-up replays. */
export function isJoinEvent(event: string): boolean {
  return event.endsWith(':join')
}

/** Wrap join handlers registered on `socket` from now on; returns the in-flight set. */
export function trackJoins(socket: {
  on(event: string, fn: Listener): unknown
}): Set<Promise<unknown>> {
  const pending = new Set<Promise<unknown>>()
  const origOn = socket.on.bind(socket)
  socket.on = (event: string, fn: Listener) => {
    if (!isJoinEvent(event) || typeof fn !== 'function') return origOn(event, fn)
    return origOn(event, function (this: unknown, ...args: unknown[]) {
      const r = fn.apply(this, args)
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        const p = Promise.resolve(r).catch(() => {})
        pending.add(p)
        void p.finally(() => pending.delete(p))
      }
      return r
    })
  }
  return pending
}

/** Wait until the joins in flight now have settled, at most `maxMs`. */
export async function joinsSettled(pending: Set<Promise<unknown>>, maxMs = 3_000): Promise<void> {
  if (pending.size === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxMs)
    })
  ])
  clearTimeout(timer)
}
