import type { ServerResponse } from 'node:http'

/**
 * Responses that never end on their own (SSE subscriptions: live events, view streams, GraphQL
 * over SSE, MCP live sessions, public signal streams). A shutdown ends these at once — their
 * clients reconnect to another server — and lets every other in-flight request finish within
 * the drain deadline (index.ts).
 *
 * Before 2026-11-20 the drain cut EVERY open connection 3 s after it began, so a file download,
 * a Fusion push, a long list read or a streamed Ask AI answer still running then was dropped
 * mid-way. A finite streamed answer (ai-stream-delivery.ts) is NOT marked: it ends when its
 * answer does.
 */
const endless = new Set<ServerResponse>()

/** Mark a hijacked SSE response as a subscription a shutdown may end at once. */
export function markEndlessStream(res: ServerResponse): void {
  endless.add(res)
  res.once('close', () => endless.delete(res))
}

/** End every marked stream (graceful end, then a hard close if the socket hangs). Returns how many. */
export function endEndlessStreams(): number {
  let n = 0
  for (const res of [...endless]) {
    endless.delete(res)
    n++
    try {
      res.end()
    } catch {
      /* already gone */
    }
    const t = setTimeout(() => {
      try {
        res.socket?.destroy()
      } catch {
        /* already gone */
      }
    }, 1_000)
    t.unref()
  }
  return n
}

/** How many marked streams are open (tests, diagnostics). */
export function endlessStreamCount(): number {
  return endless.size
}

/**
 * The drain deadline: SHUTDOWN_DRAIN_TIMEOUT_MS when set; else 12 s behind a proxy that needs a
 * drain delay (its stop grace already covers the delay plus the drain — EFP: 15 s + 12 s under a
 * 30 s stop_grace_period), 8 s without one (a plain container stop is 10 s), 3 s in development.
 */
export function drainDeadlineMs(env: NodeJS.ProcessEnv, drainDelayMs: number): number {
  const set = Number(env.SHUTDOWN_DRAIN_TIMEOUT_MS)
  if (env.SHUTDOWN_DRAIN_TIMEOUT_MS && Number.isFinite(set) && set >= 1_000) return Math.floor(set)
  if (env.NODE_ENV === 'development') return 3_000
  return drainDelayMs > 0 ? 12_000 : 8_000
}
