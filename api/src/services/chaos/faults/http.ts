import { registerFault } from '../catalog.js'

/**
 * The three original drills (#333), on the registry (#2827). Their hook points stay where they
 * were — `server.ts` (onRequest) and `services/mail.ts` (sendMail / sendRawMail) — and now ask
 * `chaosPoint('http.request')` / `chaosPoint('mail.send')`.
 */

registerFault({
  key: 'slow_requests',
  label: 'Slow requests',
  area: 'http',
  proves:
    'Slow answers stay honest: the admin shows its loading states, the Traffic Map and the slow-request trace ring see the latency, nothing times out silently.',
  claim_keys: ['http.slow_honest'],
  targets: ['all', 'route', 'share'],
  params: {
    delay_ms: { type: 'number', label: 'Delay', min: 100, max: 5000, default: 1500, unit: 'ms' }
  },
  max_seconds: 300,
  default_seconds: 30,
  points: ['http.request'],
  danger: 'low',
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }]
})

registerFault({
  key: 'mail_down',
  label: 'Mail transport down',
  area: 'http',
  proves:
    'Mail is a no-op that fails cleanly: sends land in the mail log and the outbox retries, nothing crashes, nobody waits on SMTP.',
  claim_keys: ['mail.fails_clean'],
  targets: ['all'],
  params: {},
  max_seconds: 300,
  default_seconds: 60,
  points: ['mail.send'],
  danger: 'low'
})

registerFault({
  key: 'redis_pause',
  label: 'Redis unreachable',
  area: 'http',
  proves:
    'Redis fails open: requests keep answering, sessions already signed in hold, caches miss instead of erroring, crons pause without the lease.',
  claim_keys: ['redis.fails_open'],
  targets: ['all', 'node'],
  params: {},
  max_seconds: 300,
  default_seconds: 30,
  points: ['redis.command'],
  danger: 'medium',
  apply_scope: 'every',
  async apply(fault, { app }) {
    const a = app as { redis?: { disconnect(): void; connect(): Promise<unknown> } } | null
    const redis = a?.redis
    if (!redis) return
    if (fault.target.kind === 'node') {
      const { CHAOS_NODE } = await import('../registry.js')
      if (fault.target.node !== CHAOS_NODE) return
    }
    redis.disconnect()
    return () => {
      void redis.connect().catch(() => {})
    }
  },
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }]
})
