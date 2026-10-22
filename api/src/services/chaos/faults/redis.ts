import { type ArmedFault, registerFault } from '../catalog.js'
import { ChaosError } from '../gate.js'
import {
  dropFamily,
  evictShare,
  KEY_FAMILIES,
  type KeyClient,
  keyFamily,
  redisDbIndex,
  restoreSnapshot,
  sessionLossRefusal
} from '../redis-keys.js'
import { registerRedisSamplers } from '../redis-samplers.js'

/**
 * The Redis fault set (#2832), beside the original pause (`redis_pause`, faults/http.ts).
 * Latency and READONLY act at the command seam (services/chaos/redis-hook.ts) on every replica
 * the target reaches; key loss and eviction run once, on the replica that armed them, against
 * this instance's own Redis database only.
 */

function appRedis(app: unknown): (KeyClient & { options?: unknown }) | null {
  return ((app as { redis?: KeyClient } | null)?.redis ?? null) as
    | (KeyClient & { options?: unknown })
    | null
}

async function note(fault: ArmedFault, data: Record<string, unknown>): Promise<void> {
  if (!fault.run_id) return
  try {
    const { addRunEvent } = await import('../drill.js')
    await addRunEvent(fault.run_id, 'note', data)
  } catch {
    /* the drill still runs without its note */
  }
}

registerRedisSamplers()

registerFault({
  key: 'redis_latency',
  label: 'Slow Redis',
  area: 'redis',
  proves:
    'A slow Redis slows answers but breaks nothing: sessions, caches, rate limits and the scheduler lease keep working, only later.',
  claim_keys: ['redis.latency_tolerated'],
  targets: ['all', 'node'],
  params: {
    delay_ms: {
      type: 'number',
      label: 'Added latency',
      min: 5,
      max: 2000,
      default: 150,
      unit: 'ms'
    },
    jitter_ms: { type: 'number', label: 'Jitter', min: 0, max: 1000, default: 50, unit: 'ms' }
  },
  max_seconds: 300,
  default_seconds: 60,
  points: ['redis.latency'],
  danger: 'medium',
  hypothesis_defaults: [
    { sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 },
    { sampler: 'redis.errors_per_min', op: '<', limit: 5, tolerance: 5 }
  ]
})

registerFault({
  key: 'redis_readonly',
  label: 'Redis read-only (failover)',
  area: 'redis',
  proves:
    'During a failover every write to Redis answers READONLY: requests still answer, sign-in fails cleanly instead of half-saving, caches serve misses, the scheduler lease stops renewing and ticks pause.',
  claim_keys: ['redis.readonly_survived'],
  targets: ['all', 'node'],
  params: {},
  max_seconds: 120,
  default_seconds: 30,
  points: ['redis.readonly'],
  danger: 'high',
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 5, tolerance: 2 }]
})

const LOSS_CAP_MAX = 20_000

registerFault({
  key: 'redis_key_loss',
  label: 'Redis keys lost',
  area: 'redis',
  proves:
    'Losing one family of keys is survivable: caches rebuild, the scheduler lease is re-taken, and when old keys come back (a lagging replica after a failover) a signed-out session stays signed out. Sessions are dropped only on a Redis database other than 0 (or a deployed stack that sets REDIS_CHANNEL_PREFIX) — on a shared development Redis, db 0 holds everyone’s sign-ins.',
  claim_keys: ['redis.key_loss_rebuilds', 'auth.logout_holds'],
  targets: ['all'],
  params: {
    family: {
      type: 'enum',
      label: 'Keys',
      options: KEY_FAMILIES.map((f) => f.key),
      default: 'query_cache'
    },
    restore: { type: 'boolean', label: 'Bring old keys back at the end', default: true },
    max_keys: {
      type: 'number',
      label: 'At most',
      min: 1,
      max: LOSS_CAP_MAX,
      default: 2000,
      unit: 'keys'
    }
  },
  max_seconds: 300,
  default_seconds: 60,
  points: [],
  danger: 'high',
  // The keys are shared by every replica: one replica does the deleting.
  apply_scope: 'origin',
  async apply(fault, { app }) {
    const redis = appRedis(app)
    if (!redis) return
    const family = keyFamily(String(fault.params.family ?? ''))
    if (!family) throw new ChaosError('unknown key family', 400, 'CHAOS_BAD_PARAMS')
    if (family.sessions) {
      const why = sessionLossRefusal(redisDbIndex(redis))
      if (why) throw new ChaosError(why, 400, 'CHAOS_REFUSED')
    }
    const cap = Math.min(LOSS_CAP_MAX, Number(fault.params.max_keys) || 2000)
    const keep = fault.params.restore !== false
    const { deleted, snapshot } = await dropFamily(redis, family, cap, keep)
    await note(fault, { redis_keys_deleted: deleted, family: family.key, kept: snapshot.length })
    if (!keep) return
    return async () => {
      const back = await restoreSnapshot(redis, snapshot)
      await note(fault, { redis_keys_restored: back, family: family.key })
    }
  },
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }]
})

registerFault({
  key: 'redis_evict',
  label: 'Redis evicting keys',
  area: 'redis',
  proves:
    'Under memory pressure Redis evicts nvr:* keys at random: every family rebuilds or fails open — a lost lease is re-taken, a lost cache recomputes, a lost lock is re-acquired.',
  claim_keys: ['redis.eviction_tolerated'],
  targets: ['all'],
  params: {
    share_pct: {
      type: 'number',
      label: 'Share evicted per sweep',
      min: 1,
      max: 100,
      default: 20,
      unit: '%'
    },
    interval_s: { type: 'number', label: 'Sweep every', min: 2, max: 60, default: 10, unit: 's' },
    max_keys: {
      type: 'number',
      label: 'At most per sweep',
      min: 1,
      max: 5000,
      default: 500,
      unit: 'keys'
    }
  },
  max_seconds: 300,
  default_seconds: 60,
  points: [],
  danger: 'high',
  apply_scope: 'origin',
  apply(fault, { app }) {
    const redis = appRedis(app)
    if (!redis) return
    const share = Number(fault.params.share_pct) || 20
    const cap = Number(fault.params.max_keys) || 500
    let round = 0
    let evicted = 0
    let busy = false
    const sweep = async () => {
      if (busy || Date.now() >= fault.ends_at) return
      busy = true
      try {
        evicted += await evictShare(redis, share, cap, `${fault.id}:${round++}`)
      } catch {
        /* Redis down: nothing to evict this round */
      } finally {
        busy = false
      }
    }
    void sweep()
    const timer = setInterval(() => void sweep(), (Number(fault.params.interval_s) || 10) * 1000)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      void note(fault, { redis_keys_evicted: evicted, sweeps: round })
    }
  },
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }]
})
