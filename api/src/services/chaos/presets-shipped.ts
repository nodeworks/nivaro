import type { PresetSpec } from './presets.js'

/**
 * Shipped fault presets (#2855): one per common degradation claim (#2830). Each names the fault
 * by key — a preset whose fault this instance does not have is listed with "not installed here"
 * and cannot run. Strength and duration stay small: a preset is the safe first run of a claim,
 * not the worst case. Keys are stable (people override a shipped preset by saving one with the
 * same key); never rename one.
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
  }
]
