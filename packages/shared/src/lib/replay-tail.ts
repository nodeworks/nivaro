import { instrumentConsole, instrumentRequests, type RequestEvent } from './replay-context'

/**
 * The last few things the page said and asked (#1377, #1390): a small ring
 * buffer of console warnings/errors and requests, for the support request and
 * Report a problem to attach without anyone recording anything.
 *
 * Fed by the same watchers the session recorder uses (replay-context.ts:
 * redacted console lines, request route patterns with no query string, no
 * bodies or headers) — one extra listener, installed once per page by
 * `installReplayTail()`. The support surfaces install it when they mount; a
 * host can call it at startup so the tail covers the whole visit.
 */

export const TAIL_CONSOLE = 30
export const TAIL_REQUESTS = 20

export interface TailConsoleLine {
  at: number
  level: string
  msg: string
}
export interface TailRequest {
  at: number
  method: string
  route: string
  status: number
  ms: number
}
export interface ReplayTail {
  console: TailConsoleLine[]
  requests: TailRequest[]
}

const consoleRing: TailConsoleLine[] = []
const requestRing: TailRequest[] = []
let installed = false

function push<T>(ring: T[], item: T, cap: number) {
  ring.push(item)
  if (ring.length > cap) ring.splice(0, ring.length - cap)
}

/** Feed one watcher event into the rings (exported for tests). */
export function noteTailEvent(tag: string, payload: unknown, at = Date.now()): void {
  if (tag === 'console') {
    const p = payload as { level?: string; msg?: string }
    push(
      consoleRing,
      { at, level: String(p.level ?? 'error'), msg: String(p.msg ?? '') },
      TAIL_CONSOLE
    )
  } else if (tag === 'request') {
    const p = payload as RequestEvent
    push(
      requestRing,
      { at, method: p.method, route: p.route, status: p.status, ms: p.duration_ms },
      TAIL_REQUESTS
    )
  }
}

/** Idempotent; a no-op outside a browser. Watches for the rest of the page's life. */
export function installReplayTail(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  try {
    // No cap: the rings bound memory, and a long visit must keep its latest lines.
    instrumentConsole(noteTailEvent, Number.POSITIVE_INFINITY)
    instrumentRequests(noteTailEvent, Number.POSITIVE_INFINITY)
  } catch {
    /* best-effort */
  }
}

/** A copy of the rings, oldest first. */
export function getReplayTail(): ReplayTail {
  return { console: [...consoleRing], requests: [...requestRing] }
}

/** Test seam. */
export function resetReplayTail(): void {
  consoleRing.length = 0
  requestRing.length = 0
}

/**
 * The tail as a plain-text attachment a person can open from the ticket:
 * where they were, the console lines and the request log (route, status, ms).
 */
export function formatReplayTail(
  tail: ReplayTail,
  ctx: { route: string; when?: Date; userAgent?: string | null }
): string {
  const t = (ms: number) => new Date(ms).toISOString().slice(11, 19)
  const lines = [
    `Page: ${ctx.route}`,
    `When: ${(ctx.when ?? new Date()).toISOString()}`,
    ...(ctx.userAgent ? [`Browser: ${ctx.userAgent}`] : []),
    '',
    `Console (last ${tail.console.length}, warnings and errors):`,
    ...(tail.console.length
      ? tail.console.map((c) => `  ${t(c.at)} [${c.level}] ${c.msg}`)
      : ['  (nothing)']),
    '',
    `Requests (last ${tail.requests.length}):`,
    ...(tail.requests.length
      ? tail.requests.map(
          (r) =>
            `  ${t(r.at)} ${r.method.padEnd(6)} ${String(r.status || 'ERR').padEnd(4)} ${String(r.ms).padStart(6)}ms  ${r.route}`
        )
      : ['  (nothing)'])
  ]
  return `${lines.join('\n')}\n`
}
