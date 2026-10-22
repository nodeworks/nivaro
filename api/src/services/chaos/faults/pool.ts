import { type ArmedFault, registerFault } from '../catalog.js'
import { CHAOS_NODE } from '../registry.js'

/**
 * Pool exhaustion (#2831): hold N connections of the main or the background pool
 * (db/pool-context.ts, #1321) for the drill window. It only checks connections out — no
 * statement ever runs on them — and hands every one back on expiry, Stop all, abort, or the
 * replica's own cap, whichever comes first. A connection the pool hands over after the fault
 * ended goes straight back.
 *
 * Proves the two-pool split: hold the background pool and crons, imports and warms starve
 * while requests stay fast; hold the main pool and requests queue while background work
 * carries on. The steady-state samplers `pool.main_wait_p95_ms` / `pool.background_wait_p95_ms`
 * (#2828) and `poolHoldStatus()` read the effect.
 */

export type PoolName = 'main' | 'background'

/** Connections one replica may hold: 5 off production (the shared dev database), 10 on it. */
export function holdCap(env: NodeJS.ProcessEnv = process.env): number {
  return env.NODE_ENV === 'production' ? 10 : 5
}

/** Seconds one hold may last: 60 off production, the fault's own window on it. */
export function holdSecondsCap(env: NodeJS.ProcessEnv = process.env): number | null {
  return env.NODE_ENV === 'production' ? null : 60
}

interface KnexLike {
  client: {
    acquireConnection(): Promise<unknown>
    releaseConnection(conn: unknown): unknown
  }
}

type PoolSource = (pool: PoolName) => Promise<KnexLike | null>

let source: PoolSource = async (pool) => {
  const m = await import('../../../db/index.js')
  return (pool === 'background' ? m._backgroundDb : m._staticDb) as unknown as KnexLike | null
}

/** Tests: where connections come from. */
export function _setPoolSourceForTests(fn: PoolSource): void {
  source = fn
}

interface Hold {
  pool: PoolName
  held: unknown[]
  closed: boolean
}

const holds = new Map<string, Hold>()

/** Connections this replica's pool-hold faults hold right now, per pool. */
export function poolHoldStatus(): Record<PoolName, number> {
  const out: Record<PoolName, number> = { main: 0, background: 0 }
  for (const h of holds.values()) out[h.pool] += h.held.length
  return out
}

function giveBack(k: KnexLike, conn: unknown): void {
  try {
    void Promise.resolve(k.client.releaseConnection(conn)).catch(() => {})
  } catch {
    /* the pool already dropped it */
  }
}

export async function applyPoolHold(fault: ArmedFault): Promise<(() => void) | undefined> {
  if (fault.target.kind === 'node' && fault.target.node !== CHAOS_NODE) return
  const pool: PoolName = fault.params.pool === 'background' ? 'background' : 'main'
  const k = await source(pool)
  if (!k) {
    throw new Error(
      pool === 'background'
        ? 'this replica has no separate background pool (DB_POOL_BACKGROUND_MAX=0)'
        : 'no database pool on this replica'
    )
  }
  const n = Math.max(1, Math.min(holdCap(), Math.floor(Number(fault.params.connections) || 1)))
  const hold: Hold = { pool, held: [], closed: false }
  holds.set(fault.id, hold)
  // Never awaited: a saturated pool answers late (or times out), and the drill must not wait.
  for (let i = 0; i < n; i++) {
    k.client
      .acquireConnection()
      .then((conn) => {
        if (hold.closed) giveBack(k, conn)
        else hold.held.push(conn)
      })
      .catch(() => {
        /* the pool refused (timeout): nothing held */
      })
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const release = () => {
    if (hold.closed) return
    hold.closed = true
    if (timer) clearTimeout(timer)
    holds.delete(fault.id)
    for (const conn of hold.held.splice(0)) giveBack(k, conn)
  }
  const capS = holdSecondsCap()
  if (capS != null) {
    timer = setTimeout(release, capS * 1000)
    timer.unref?.()
  }
  return release
}

registerFault({
  key: 'pool_hold',
  label: 'Pool exhaustion',
  area: 'db',
  proves:
    'The two connection pools stay apart: holding the background pool starves crons, imports and warms while requests stay fast; holding the main pool slows requests while background work carries on; pool pressure and DB Health raise the alarm within a minute.',
  claim_keys: ['pools.isolated', 'readgate.fails_open'],
  targets: ['all', 'node'],
  params: {
    pool: { type: 'enum', label: 'Pool', options: ['background', 'main'], default: 'background' },
    connections: {
      type: 'number',
      label: 'Connections held',
      min: 1,
      max: 10,
      default: 3,
      unit: 'connections'
    }
  },
  max_seconds: 300,
  default_seconds: 30,
  points: ['db.pool'],
  danger: 'high',
  apply_scope: 'every',
  apply: (fault) => applyPoolHold(fault),
  hypothesis_defaults: [
    { sampler: 'pool.main_wait_p95_ms', op: '<', limit: 250, tolerance: 250 },
    { sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }
  ]
})

/** Tests only. */
export function _resetPoolHoldsForTests(): void {
  holds.clear()
}
