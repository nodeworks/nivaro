import { AsyncLocalStorage } from 'node:async_hooks'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Ask AI's own lane for tool runs (2026-11-18): one long AI turn — or twenty people asking at
 * once — must never crowd out people clicking around. A tool run (query_items, aggregate,
 * run_custom_query, …) holds a lane slot for its whole run:
 *
 *  - at most AI_TOOL_CONCURRENCY runs at once per process (default 8; per tenant in cloud),
 *  - at most AI_TOOL_PER_USER of them for one person (default 2) while others wait — alone, a
 *    person still gets only their share, so a burst of their tabs queues behind itself,
 *  - a run that waited AI_TOOL_MAX_WAIT_MS (default 30 s) goes ahead anyway (fail-open, like
 *    the heavy-read gate): an answer late is better than an answer that never comes.
 *
 * One conversation already runs its tools one at a time (ai-chat-loop.ts), so the per-person
 * share is what limits a person with several conversations or tabs. The lane is not a database
 * resource: a run holding a lane slot may still wait for a heavy-read slot (services/read-gate.ts)
 * inside it, never the other way round. Re-entrant: a tool that runs another tool does not
 * take a second slot.
 */

function num(name: string, fallback: number, min: number, max: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= min ? Math.min(Math.floor(v), max) : fallback
}

export function laneLimits(): { total: number; perUser: number; maxWaitMs: number } {
  const total = num('AI_TOOL_CONCURRENCY', 8, 1, 64)
  return {
    total,
    perUser: Math.min(num('AI_TOOL_PER_USER', 2, 1, 64), total),
    maxWaitMs: num('AI_TOOL_MAX_WAIT_MS', 30_000, 0, 600_000)
  }
}

interface Waiter {
  who: string
  wake: () => void
}

interface Lane {
  active: number
  byUser: Map<string, number>
  queue: Waiter[]
  waitedTotal: number
  failOpen: number
}

const lanes = new Map<string, Lane>()

function laneFor(key: string): Lane {
  let l = lanes.get(key)
  if (!l) {
    l = { active: 0, byUser: new Map(), queue: [], waitedTotal: 0, failOpen: 0 }
    lanes.set(key, l)
  }
  return l
}

function fits(l: Lane, who: string): boolean {
  const { total, perUser } = laneLimits()
  return l.active < total && (l.byUser.get(who) ?? 0) < perUser
}

function take(l: Lane, who: string): void {
  l.active++
  l.byUser.set(who, (l.byUser.get(who) ?? 0) + 1)
}

function give(l: Lane, who: string): void {
  l.active = Math.max(0, l.active - 1)
  const n = (l.byUser.get(who) ?? 1) - 1
  if (n <= 0) l.byUser.delete(who)
  else l.byUser.set(who, n)
  // Wake the first waiters that now fit (a person at their share is skipped, not blocking).
  for (let i = 0; i < l.queue.length; ) {
    const w = l.queue[i]
    if (fits(l, w.who)) {
      l.queue.splice(i, 1)
      take(l, w.who)
      w.wake()
    } else i++
  }
}

const inLane = new AsyncLocalStorage<true>()

/** True while the current async context runs a tool inside the lane. */
export function holdsAiToolSlot(): boolean {
  return inLane.getStore() === true
}

/**
 * Run one Ask AI tool body in the lane. `who` = the asker's user id. Rejects with an
 * AbortError when `signal` aborts while still waiting.
 */
export async function withAiToolLane<T>(
  who: string | null | undefined,
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal; onWait?: (ms: number) => void } = {}
): Promise<T> {
  if (holdsAiToolSlot()) return fn()
  const id = String(who ?? 'anon').toUpperCase()
  const l = laneFor(currentTenantKey() ?? '')
  let counted = true
  if (fits(l, id)) take(l, id)
  else {
    const started = Date.now()
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const w: Waiter = {
        who: id,
        wake: () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
          resolve()
        }
      }
      const leave = () => {
        const i = l.queue.indexOf(w)
        if (i >= 0) l.queue.splice(i, 1)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        leave()
        // Fail open: run without a slot (not counted, so nothing to give back).
        counted = false
        l.failOpen++
        opts.signal?.removeEventListener('abort', onAbort)
        resolve()
      }, laneLimits().maxWaitMs)
      const onAbort = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        leave()
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      }
      if (opts.signal?.aborted) return onAbort()
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      l.queue.push(w)
    })
    const waited = Date.now() - started
    l.waitedTotal += waited
    opts.onWait?.(waited)
  }
  try {
    return await inLane.run(true, fn)
  } finally {
    if (counted) give(l, id)
  }
}

/** Who holds the lane right now (for the connections view and tests). */
export function aiToolLaneStats(): {
  limits: ReturnType<typeof laneLimits>
  lanes: Array<{
    tenant: string
    active: number
    waiting: number
    byUser: Record<string, number>
    failOpen: number
  }>
} {
  return {
    limits: laneLimits(),
    lanes: [...lanes.entries()].map(([tenant, l]) => ({
      tenant,
      active: l.active,
      waiting: l.queue.length,
      byUser: Object.fromEntries(l.byUser),
      failOpen: l.failOpen
    }))
  }
}

/** Tests only. */
export function resetAiToolLane(): void {
  lanes.clear()
}
