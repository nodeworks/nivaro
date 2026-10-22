import { type ArmedFault, registerFault } from '../catalog.js'
import { MAX_SKEW_MS, setClockSkew } from '../clock.js'
import { CHAOS_NODE } from '../registry.js'

/**
 * Clock skew on one replica (#2835). Moves `appNow()` (services/chaos/clock.ts) on the
 * targeted replica only — never `Date` itself — so the decisions that read the application
 * clock see a different now: session and API-key expiry, SLA timers, maintenance windows, the
 * cron fire-time slot the leader claims a run under. The timestamps such a replica writes
 * (session last-seen stamps) are what the others then disagree with.
 */

export function applyClockSkew(fault: ArmedFault): (() => void) | undefined {
  if (fault.target.kind !== 'node' || fault.target.node !== CHAOS_NODE) return
  const ms = Math.max(
    -MAX_SKEW_MS,
    Math.min(MAX_SKEW_MS, (Number(fault.params.offset_minutes) || 0) * 60_000)
  )
  setClockSkew(ms)
  return () => setClockSkew(0)
}

registerFault({
  key: 'clock_skew',
  label: 'Clock skew',
  area: 'process',
  proves:
    'A replica whose clock is off does not expire sessions early, double-fire scheduled jobs or move SLA timers: expiry and scheduling decisions agree with the other replicas or fail safe.',
  claim_keys: ['process.clock_skew_safe'],
  targets: ['node'],
  params: {
    offset_minutes: {
      type: 'number',
      label: 'Offset',
      min: -1440,
      max: 1440,
      default: 10,
      unit: 'min'
    }
  },
  max_seconds: 600,
  default_seconds: 60,
  points: ['clock.now'],
  danger: 'medium',
  apply_scope: 'every',
  apply: (fault) => applyClockSkew(fault),
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }]
})
