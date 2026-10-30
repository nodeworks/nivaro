import { resolveDb } from '../db/index.js'

/**
 * Open a few database connections BEFORE the process starts serving. A freshly deployed
 * replica starts with an empty pool, and its first burst of requests all try to log in to SQL
 * Server at once; on 2026-10-30 those logins took 15 s+ ("Failed to connect … in 15000ms"),
 * every request queued behind them for ~50 s and a portal deploy gate rolled back. Warming here
 * spreads the logins out and lets the replica answer its health check only once it can reach
 * the database. Never fails boot: a warm-up that cannot finish in its time box just stops.
 *
 *   DB_POOL_WARM=<n>  connections to open (default 6, capped at the pool's max; 0 = off)
 */
export async function warmDbPool(opts: { max: number; timeMs?: number }): Promise<number> {
  const raw = process.env.DB_POOL_WARM
  const wanted = raw == null || raw === '' ? 6 : Number(raw)
  const n = Math.max(0, Math.min(Number.isFinite(wanted) ? Math.floor(wanted) : 6, opts.max))
  if (n === 0) return 0
  const knex = resolveDb()
  const client = knex.client as {
    acquireConnection: () => Promise<unknown>
    releaseConnection: (c: unknown) => Promise<void>
  }
  const held: unknown[] = []
  const deadline = Date.now() + (opts.timeMs ?? 30_000)
  try {
    // Two at a time: a login storm is what this avoids, so the warm-up must not be one.
    for (let i = 0; i < n && Date.now() < deadline; i += 2) {
      const batch = await Promise.allSettled(
        // lint-traps-ok: every acquired connection goes into `held`, released in the finally below.
        Array.from({ length: Math.min(2, n - i) }, () => client.acquireConnection())
      )
      for (const r of batch) if (r.status === 'fulfilled') held.push(r.value)
    }
  } finally {
    await Promise.allSettled(held.map((c) => client.releaseConnection(c)))
  }
  return held.length
}
