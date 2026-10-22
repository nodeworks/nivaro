import { registerFault } from '../catalog.js'

/**
 * Database faults (#1773). Both act at the driver seam (`db/chaos-seam.ts` →
 * `services/chaos/db-point.ts`), on the main pool, the background pool or both (the `pool`
 * parameter), for everything, one table (the statement's first FROM / UPDATE / INTO target),
 * a route pattern (the request the statement runs for), one person or a share of statements.
 * The drill's own bookkeeping (chaos runs and events, job runs) is never touched.
 */

const POOL = {
  type: 'enum' as const,
  label: 'Pool',
  options: ['any', 'main', 'background'],
  default: 'any'
}

registerFault({
  key: 'db_latency',
  label: 'Slow database',
  area: 'db',
  proves:
    'A slow database stays honest: requests slow down but answer, heavy reads queue at the read gate instead of piling onto the pool, the slow-request traces name the statements, and nothing times out silently.',
  claim_keys: ['db.transient_retry', 'readgate.fails_open'],
  targets: ['all', 'table', 'route', 'user', 'share'],
  params: {
    delay_ms: {
      type: 'number',
      label: 'Added per statement',
      min: 10,
      max: 5000,
      default: 250,
      unit: 'ms'
    },
    pool: POOL
  },
  max_seconds: 300,
  default_seconds: 30,
  points: ['db.query'],
  danger: 'medium',
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }]
})

registerFault({
  key: 'db_errors',
  label: 'Database errors',
  area: 'db',
  proves:
    'A failing statement fails one request, not the process: the caller gets a clear error (or a retry where one exists), transactions roll back, the error tracker and DB Health see it, and the next statement works.',
  claim_keys: ['db.transient_retry'],
  targets: ['all', 'table', 'route', 'user', 'share'],
  params: {
    error: {
      type: 'enum',
      label: 'Error',
      options: ['deadlock', 'timeout', 'reset'],
      default: 'deadlock'
    },
    rate_pct: {
      type: 'number',
      label: 'Statements that fail',
      min: 1,
      max: 100,
      default: 10,
      unit: '%'
    },
    wait_ms: {
      type: 'number',
      label: 'Wait before failing',
      min: 0,
      max: 15000,
      default: 0,
      unit: 'ms'
    },
    pool: POOL
  },
  max_seconds: 180,
  default_seconds: 30,
  points: ['db.error'],
  danger: 'high',
  hypothesis_defaults: [{ sampler: 'http.p95_ms', op: '<', limit: 5000, tolerance: 1000 }]
})
