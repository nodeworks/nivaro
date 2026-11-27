import { contextFor, openConnection, regionFor } from './engine/plan.js'
import { type HubResourceRow, listResources, readConnection } from './store.js'

/**
 * Task 43: the health tick. Nothing else calls an adapter's `health()` on a schedule except the
 * domain watch (domains.ts, registrar types), so a budget whose `health()` is where it notices it
 * went over (Azure `azure.budget` fires `cost.over_budget` from there; `aws.budget` reports its
 * figures) was never asked. This asks it once an hour, inside the observe job
 * (`hub-resources-observe`, Hub only, cronTicksEnabled(), its leader lease).
 *
 *  - Only the types in HEALTH_TICK_TYPES (whose health carries budget / alert figures).
 *  - Bounded: at most HEALTH_TICK_MAX resources a tick, HEALTH_AT_ONCE at once, each call
 *    HEALTH_CALL_MS; one connection that fails is skipped, never the others.
 *  - The row's own app goes with the call (`{appId}`), never an app read back from the provider.
 *  - It never writes anything itself: what a health answer causes is the adapter's notify path.
 */

export const HEALTH_TICK_TYPES: readonly string[] = Object.freeze(['azure.budget', 'aws.budget'])
export const HEALTH_TICK_MAX = 50
const HEALTH_AT_ONCE = 3
const HEALTH_CALL_MS = 20_000

/** The observe job ticks every 15 minutes; health runs in the first one of each hour (UTC). */
export function healthTickDue(now: Date): boolean {
  return now.getUTCMinutes() < 15
}

export interface HealthTickSummary {
  asked: number
  failed: number
  skipped: number
}

function withTimeout<T>(p: Promise<T>, ms: number, ac: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      ac.abort()
      reject(new Error('health timed out'))
    }, ms)
    t.unref?.()
    p.then(resolve, reject).finally(() => clearTimeout(t))
  })
}

export async function healthTick(
  opts: { types?: readonly string[]; max?: number; callMs?: number } = {}
): Promise<HealthTickSummary> {
  const types = opts.types ?? HEALTH_TICK_TYPES
  const sum: HealthTickSummary = { asked: 0, failed: 0, skipped: 0 }
  const rows: HubResourceRow[] = []
  for (const type of types) {
    try {
      rows.push(...(await listResources({ type })).filter((r) => r.external_id))
    } catch {
      sum.failed += 1
    }
  }
  // Stalest observation first, so a cut tick still rotates through all of them.
  rows.sort((a, b) => (a.observed_at ?? '').localeCompare(b.observed_at ?? ''))
  const todo = rows.slice(0, opts.max ?? HEALTH_TICK_MAX)
  sum.skipped = rows.length - todo.length
  const conns = new Map<number, Promise<Awaited<ReturnType<typeof openConnection>> | null>>()
  const open = (id: number) => {
    let p = conns.get(id)
    if (!p) {
      p = (async () => {
        const row = await readConnection(id)
        if (!row || row.status === 'disabled') return null
        return openConnection(id)
      })().catch(() => null)
      conns.set(id, p)
    }
    return p
  }
  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const row = todo[next++]
      const conn = await open(row.connection_id)
      if (!conn?.adapter.health) {
        sum.skipped += 1
        continue
      }
      const ac = new AbortController()
      try {
        const ctx = contextFor(conn, regionFor(conn.row.config, row.desired, row.observed), {
          signal: ac.signal
        })
        await withTimeout(
          conn.adapter.health(ctx, row.type, String(row.external_id), { appId: row.app_id }),
          opts.callMs ?? HEALTH_CALL_MS,
          ac
        )
        sum.asked += 1
      } catch {
        sum.failed += 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(HEALTH_AT_ONCE, todo.length) }, worker))
  return sum
}
