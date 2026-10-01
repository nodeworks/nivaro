// api/src/services/traffic-taps/pool.ts
/**
 * Topology tap `pool` (#1109): connection-pool pressure on the map's database node — p95 acquire
 * wait and the share of samples with every connection busy (poolPressure(), the same rolling
 * five minutes the pool-monitor cron judges), with the monitor's thresholds as amber and twice
 * them as red.
 */
import { type PoolPressure, poolPressure } from '../pool-attribution.js'
import { registerTrafficTap } from '../traffic-taps.js'

export const POOL_TAP = 'pool'
/** The pool-monitor cron's thresholds (server.ts): warn at these, error at twice them. */
export const POOL_WARN = { wait_p95_ms: 500, saturated_pct: 25, min_acquires: 50 }

export type PoolLevel = 'ok' | 'warn' | 'error'

/** Amber/red for the db node. Waits only count with enough acquires to be a real p95. */
export function poolLevel(
  p: Pick<PoolPressure, 'acquires' | 'wait_p95_ms' | 'saturated_pct'>
): PoolLevel {
  const waited = p.acquires >= POOL_WARN.min_acquires
  if ((waited && p.wait_p95_ms >= POOL_WARN.wait_p95_ms * 2) || p.saturated_pct >= 50)
    return 'error'
  if (
    (waited && p.wait_p95_ms >= POOL_WARN.wait_p95_ms) ||
    p.saturated_pct >= POOL_WARN.saturated_pct
  )
    return 'warn'
  return 'ok'
}

function read(): (PoolPressure & { level: PoolLevel }) | undefined {
  try {
    const p = poolPressure()
    if (!p.max && !p.acquires) return undefined
    return { ...p, level: poolLevel(p) }
  } catch {
    return undefined
  }
}

registerTrafficTap({
  id: POOL_TAP,
  // every 5 s is plenty: the figures are a 5-minute rolling window
  frame: (sec) => (sec % 5 === 0 ? read() : undefined),
  snapshot: () => read()
})
