import type { PresetSpec } from './presets.js'

/**
 * Shipped fault presets (#2855): one per common degradation claim (#2830). Each names the fault
 * by key — a preset whose fault this instance does not have is listed with "not installed here"
 * and cannot run. Strength and duration stay small: a preset is the safe first run of a claim,
 * not the worst case. Keys are stable (people override a shipped preset by saving one with the
 * same key); never rename one.
 *
 * A preset with no target takes the fault's first target kind; for a replica-only fault that is
 * "one replica" — the builder fills in the first replica and POST /presets/:key/run without a
 * target picks the replica that answers. Faults that need a game day or a host runbook
 * (kill_web_task) have no preset. presets-shipped.test.ts proves every preset against the real
 * catalog: the fault and its claims exist, the params pass the fault's schema unchanged, and the
 * window stays at or under two minutes.
 */

export interface ShippedPreset {
  key: string
  label: string
  description?: string
  proves: string
  claim_keys: string[]
  spec: PresetSpec
}

const p5xx = { sampler: 'http.5xx_pct', op: '<' as const, limit: 1, tolerance: 0.5 }
const p95 = (limit: number) => ({
  sampler: 'http.p95_ms',
  op: '<' as const,
  limit,
  tolerance: Math.round(limit / 4)
})
const savesOk = { sampler: 'records.save_failures', op: '<' as const, limit: 1, tolerance: 1 }
const redisErrors = { sampler: 'redis.errors_per_min', op: '<' as const, limit: 5, tolerance: 5 }

export const SHIPPED_PRESETS: ShippedPreset[] = [
  {
    key: 'slow-answers-stay-honest',
    label: 'Slow answers stay honest',
    description: 'A quarter of requests answer 1.5 s late for a minute.',
    proves:
      'Screens show their loading states instead of freezing, the Traffic Map and the slow-trace ring see the latency, and nothing times out silently.',
    claim_keys: ['http.slow_honest'],
    spec: {
      fault_key: 'slow_requests',
      target: { kind: 'share', share_pct: 25 },
      params: { delay_ms: 1500 },
      seconds: 60,
      hypothesis: [p5xx]
    }
  },
  {
    key: 'mail-down-fails-clean',
    label: 'Mail down fails clean',
    description: 'Every send fails for a minute.',
    proves:
      'Sends land in the mail log as failed and are retried, saves that send mail still succeed, and nobody waits on SMTP.',
    claim_keys: ['mail.fails_clean'],
    spec: {
      fault_key: 'mail_down',
      target: { kind: 'all' },
      params: {},
      seconds: 60,
      hypothesis: [p5xx]
    }
  },
  {
    key: 'redis-outage-fails-open',
    label: 'Redis outage fails open',
    description: 'Redis is unreachable from every replica for 30 seconds.',
    proves:
      'Requests keep answering, signed-in sessions hold, caches miss instead of erroring and scheduled jobs pause without the lease.',
    claim_keys: ['redis.fails_open'],
    spec: {
      fault_key: 'redis_pause',
      target: { kind: 'all' },
      params: {},
      seconds: 30,
      hypothesis: [p5xx, p95(2000)]
    }
  },
  {
    key: 'sockets-reconnect-catch-up',
    label: 'Sockets reconnect and catch up',
    description: 'One in ten sockets is dropped once.',
    proves:
      'Dropped sockets show the reconnect banner, reconnect on their own and catch up on what they missed, with nothing lost or doubled.',
    claim_keys: ['sockets.reconnect_catchup'],
    spec: {
      fault_key: 'socket_drill',
      target: { kind: 'share', share_pct: 10 },
      params: { latency_ms: 0, drop_pct: 0, disconnect: 'once', disconnect_every_s: 30 },
      seconds: 60,
      hypothesis: [{ sampler: 'socket.reconnects', op: '<', limit: 500, tolerance: 100 }]
    }
  },

  // ─── Database (#2831) ──────────────────────────────────────────────────────
  {
    key: 'slow-database-queues-at-read-gate',
    label: 'Slow database queues at the read gate',
    description: 'One statement in ten waits an extra quarter second for a minute.',
    proves:
      'Requests slow down but answer, heavy reads queue at the read gate and proceed after their maximum wait instead of hanging, and the slow-request traces name the statements.',
    claim_keys: ['readgate.fails_open'],
    spec: {
      fault_key: 'db_latency',
      target: { kind: 'share', share_pct: 10 },
      params: { delay_ms: 250, pool: 'any' },
      seconds: 60,
      hypothesis: [p5xx, p95(3000)]
    }
  },
  {
    key: 'database-errors-fail-one-request',
    label: 'Database errors fail one request',
    description:
      'In a tenth of traffic, one statement in twenty fails as a deadlock victim, for 30 seconds.',
    proves:
      'A deadlock victim is retried or fails only its own request with a clear error, the transaction rolls back, and the next statement works — no hung page.',
    claim_keys: ['db.transient_retry'],
    spec: {
      fault_key: 'db_errors',
      target: { kind: 'share', share_pct: 10 },
      params: { error: 'deadlock', rate_pct: 5, wait_ms: 0, pool: 'any' },
      seconds: 30,
      hypothesis: [p95(5000), { sampler: 'http.5xx_pct', op: '<', limit: 5, tolerance: 2 }]
    }
  },
  {
    key: 'background-pool-hold-spares-requests',
    label: 'Background pool held, requests stay fast',
    description: 'Two background-pool connections are held for 45 seconds.',
    proves:
      'Holding the background pool slows crons, imports and warms while requests keep their usual speed: the two pools stay apart and pool pressure shows the hold.',
    claim_keys: ['pools.isolated'],
    spec: {
      fault_key: 'pool_hold',
      target: { kind: 'all' },
      params: { pool: 'background', connections: 2 },
      seconds: 45,
      hypothesis: [{ sampler: 'pool.main_wait_p95_ms', op: '<', limit: 250, tolerance: 250 }, p5xx]
    }
  },

  // ─── Redis (#2832, #2833) ──────────────────────────────────────────────────
  {
    key: 'slow-redis-tolerated',
    label: 'Slow Redis is tolerated',
    description: 'Every Redis command waits about a tenth of a second longer for a minute.',
    proves:
      'Sessions, caches, rate limits and the scheduler lease keep working, only later; nothing errors because Redis is slow.',
    claim_keys: ['redis.latency_tolerated'],
    spec: {
      fault_key: 'redis_latency',
      target: { kind: 'all' },
      params: { delay_ms: 100, jitter_ms: 25 },
      seconds: 60,
      hypothesis: [p5xx, redisErrors]
    }
  },
  {
    key: 'redis-readonly-survived',
    label: 'Read-only Redis is survived',
    description: 'Redis refuses writes (READONLY, as after a failover) for 20 seconds.',
    proves:
      'Writes that Redis refuses fail open: requests keep answering, caches skip their writes, and everything recovers when the replica takes writes again.',
    claim_keys: ['redis.readonly_survived'],
    spec: {
      fault_key: 'redis_readonly',
      target: { kind: 'all' },
      params: {},
      seconds: 20,
      hypothesis: [{ sampler: 'http.5xx_pct', op: '<', limit: 5, tolerance: 2 }]
    }
  },
  {
    key: 'query-cache-loss-rebuilds',
    label: 'Lost query cache rebuilds',
    description:
      'Up to 500 custom-query cache keys are deleted, then brought back after a minute. Refused on Redis database 0 on development.',
    proves:
      'Cached custom queries recompute on the next read instead of erroring, and old keys coming back at the end do no harm.',
    claim_keys: ['redis.key_loss_rebuilds'],
    spec: {
      fault_key: 'redis_key_loss',
      target: { kind: 'all' },
      params: { family: 'query_cache', restore: true, max_keys: 500 },
      seconds: 60,
      hypothesis: [p5xx]
    }
  },
  {
    key: 'signed-out-stays-signed-out',
    label: 'Signed-out sessions stay signed out',
    description:
      'Up to 25 session keys are deleted and brought back after a minute, as a lagging replica would after a failover. Refused on Redis database 0 on development.',
    proves:
      'A session someone signed out of stays signed out when its old key comes back; the people whose sessions were dropped sign in again once and carry on.',
    claim_keys: ['auth.logout_holds'],
    spec: {
      fault_key: 'redis_key_loss',
      target: { kind: 'all' },
      params: { family: 'sessions', restore: true, max_keys: 25 },
      seconds: 60,
      hypothesis: [p5xx]
    }
  },
  {
    key: 'redis-eviction-tolerated',
    label: 'Redis eviction is tolerated',
    description:
      'Every 15 seconds a tenth of nvr:* keys (at most 100) is evicted, for a minute. Refused on Redis database 0 on development.',
    proves:
      'Every key family rebuilds or fails open: a lost lease is re-taken, a lost cache recomputes, a lost lock is re-acquired.',
    claim_keys: ['redis.eviction_tolerated'],
    spec: {
      fault_key: 'redis_evict',
      target: { kind: 'all' },
      params: { share_pct: 10, interval_s: 15, max_keys: 100 },
      seconds: 60,
      hypothesis: [p5xx]
    }
  },
  {
    key: 'replica-partition-catches-up',
    label: 'Cut-off replica catches up',
    description: 'One replica loses Redis pub/sub for 30 seconds.',
    proves:
      'The replica loses no record event and doubles none: its stream reader catches up from its offset when the link returns, and presence rebuilds on the next change.',
    claim_keys: ['realtime.partition_catch_up'],
    spec: {
      fault_key: 'redis_partition',
      params: { stream: 'pause' },
      seconds: 30,
      hypothesis: [p5xx]
    }
  },
  {
    key: 'scheduler-lease-expiry-pauses',
    label: 'Scheduler pauses when its lease expires',
    description: 'The scheduler lease expires on one replica for a minute.',
    proves:
      'Without the lease, scheduled jobs pause instead of running unled, and another replica (or the same one) takes the lease back.',
    claim_keys: ['cron.lease_pause'],
    spec: {
      fault_key: 'cron_lease_split',
      params: { mode: 'expire' },
      seconds: 60,
      hypothesis: [p5xx]
    }
  },
  {
    key: 'scheduler-lease-split-no-double-run',
    label: 'No job runs twice when the lease splits',
    description: 'Two replicas both believe they hold the scheduler lease for a minute.',
    proves:
      'When the lease moves in the middle of a run, no job runs twice at once — or the check names every job that did and every job not safe to.',
    claim_keys: ['cron.no_double_run'],
    spec: {
      fault_key: 'cron_lease_split',
      params: { mode: 'split' },
      seconds: 60,
      hypothesis: [p5xx]
    }
  },

  // ─── Partners, storage, AI, sign-in (#2834–#2837) ──────────────────────────
  {
    key: 'partner-errors-contained',
    label: 'Partner errors are contained',
    description: 'A fifth of calls to external APIs answer 500 for a minute.',
    proves:
      'Inline retries recover what they may, failures land as clear errors in the call log and the Integrations console, and the record that triggered the call stays saved.',
    claim_keys: ['partners.breaker_retry'],
    spec: {
      fault_key: 'partner_faults',
      target: { kind: 'share', share_pct: 20 },
      params: {
        api: '',
        mode: 'error_500',
        delay_ms: 0,
        retry_after_s: 30,
        error_body: ''
      },
      seconds: 60,
      hypothesis: [p5xx, savesOk]
    }
  },
  {
    key: 'full-disk-fails-uploads-clean',
    label: 'Full disk fails uploads cleanly',
    description: 'A quarter of file writes find the disk full for a minute.',
    proves:
      'An upload that cannot be stored fails with a clear message, records still save, and reads of existing files keep working.',
    claim_keys: ['files.share_503'],
    spec: {
      fault_key: 'storage_faults',
      target: { kind: 'share', share_pct: 25 },
      params: { mode: 'disk_full', delay_ms: 0, ops: 'writes' },
      seconds: 60,
      hypothesis: [p5xx, savesOk]
    }
  },
  {
    key: 'ai-down-answers-503',
    label: 'AI down answers 503',
    description: 'Every AI gateway call fails with 503 for a minute.',
    proves:
      'AI features answer the plain "AI is unavailable" message instead of an error page, and nothing else in Nivaro slows down.',
    claim_keys: ['ai.unavailable_503'],
    spec: {
      fault_key: 'ai_gateway_fault',
      target: { kind: 'all' },
      params: { mode: 'error_5xx', status: 503, delay_ms: 10_000 },
      seconds: 60,
      hypothesis: [p95(2000)]
    }
  },
  {
    key: 'ai-model-refused-falls-back',
    label: 'Refused AI model falls back',
    description: 'The gateway refuses the configured model id for a minute.',
    proves:
      'A refused model id falls back to the next model in the chain and the fallback is counted; people still get their answer.',
    claim_keys: ['ai.model_fallback'],
    spec: {
      fault_key: 'ai_gateway_fault',
      target: { kind: 'all' },
      params: { mode: 'model_refused', status: 503, delay_ms: 10_000 },
      seconds: 60,
      hypothesis: [p95(2000)]
    }
  },
  {
    key: 'sign-in-down-sessions-hold',
    label: 'Sign-in down, sessions hold',
    description: 'The identity provider does not answer at all for a minute.',
    proves: 'Everyone already signed in keeps working, because a session never calls the provider.',
    claim_keys: ['signin.idp_down_sessions_hold'],
    spec: {
      fault_key: 'oidc_down',
      target: { kind: 'all' },
      params: { mode: 'down', step: 'both', delay_ms: 8000 },
      seconds: 60,
      hypothesis: [p5xx]
    }
  },
  {
    key: 'slow-sign-in-says-so',
    label: 'Slow sign-in says so',
    description: 'The identity provider takes 8 seconds to answer discovery for a minute.',
    proves:
      'The sign-in page says the provider is not answering — no raw error, no redirect loop — and sign-in completes once it answers.',
    claim_keys: ['auth.signin_clear_error'],
    spec: {
      fault_key: 'oidc_down',
      target: { kind: 'all' },
      params: { mode: 'slow', step: 'discovery', delay_ms: 8000 },
      seconds: 60,
      hypothesis: [p5xx]
    }
  },
  {
    key: 'graph-down-fails-clean',
    label: 'Microsoft Graph down fails clean',
    description: 'Microsoft Graph does not answer for a minute.',
    proves:
      'Directory lookups answer a clear "Graph did not answer" error, sign-in still completes without the org profile or photo, and saves keep working.',
    claim_keys: ['graph.fails_clean'],
    spec: {
      fault_key: 'graph_down',
      target: { kind: 'all' },
      params: { mode: 'down', delay_ms: 6000 },
      seconds: 60,
      hypothesis: [p5xx, savesOk]
    }
  },

  // ─── One replica's process (#2838, #2839) ──────────────────────────────────
  {
    key: 'stalled-replica-is-drained',
    label: 'A stalled replica is drained',
    description: "One replica's event loop stalls for 200 ms every 10 seconds, for 30 seconds.",
    proves:
      'Event-loop lag and request p95 show the stall, readiness flips so the proxy stops sending the replica traffic, and the others carry the load.',
    claim_keys: ['process.loop_block_drained'],
    spec: {
      fault_key: 'event_loop_block',
      params: { block_ms: 200, every_s: 10 },
      seconds: 30,
      hypothesis: [{ sampler: 'loop.lag_ms', op: '<', limit: 2500, tolerance: 500 }, p5xx]
    }
  },
  {
    key: 'heap-guard-catches-pressure',
    label: 'The heap guard catches memory pressure',
    description: "One replica's heap grows to 40% of its limit, 16 MB at a time, for a minute.",
    proves:
      'The heap figures show the growth, the guard sheds before the process dies mid-request, and the memory comes back when the pressure ends.',
    claim_keys: ['process.heap_guard'],
    spec: {
      fault_key: 'memory_pressure',
      params: { target_pct: 40, step_mb: 16, step_s: 2 },
      seconds: 60,
      hypothesis: [p5xx]
    }
  },
  {
    key: 'clock-skew-is-safe',
    label: 'Clock skew is safe',
    description: "One replica's clock runs 5 minutes fast for a minute.",
    proves:
      'Sessions do not expire early, scheduled jobs do not double-fire and SLA timers do not move: decisions agree with the other replicas or fail safe.',
    claim_keys: ['process.clock_skew_safe'],
    spec: {
      fault_key: 'clock_skew',
      params: { offset_minutes: 5 },
      seconds: 60,
      hypothesis: [p5xx]
    }
  }
]
