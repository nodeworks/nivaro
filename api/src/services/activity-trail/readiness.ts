import { registerReadinessCheck } from '../readiness.js'
import { trailStatus } from './status.js'

/**
 * Readiness check `activity-trail` (#16): fail on an open (unacknowledged) break, warn while no
 * check has run, while the last check is over two days old, or while the sealer is behind by
 * more than an hour (the first backfill reads as "sealing existing entries").
 */
let registered = false
const STALE_CHECK_MS = 48 * 3600_000
const BACKLOG_WARN_MS = 3600_000

export function registerTrailReadiness(): void {
  if (registered) return
  registered = true
  registerReadinessCheck({
    id: 'activity-trail',
    label: 'Activity log trail is intact',
    group: 'Security',
    description:
      'Every activity log entry is sealed into a hash chain by the activity-seal job; the daily activity-trail-verify job recomputes it from the last good checkpoint. Fails when an entry no longer matches its seal or entries are missing outside the retention purge (until an administrator acknowledges it under Security & privacy → Log retention); warns while no check has run, the last one is over two days old, or entries wait more than an hour to be sealed.',
    ttlMs: 10 * 60_000,
    run: async () => {
      const s = await trailStatus()
      if (s.state === 'not_migrated') return { status: 'skip', detail: 'Migration 518 has not run' }
      if (s.state === 'broken' && s.broken)
        return {
          status: 'fail',
          detail: `Broken at entry ${s.broken.mismatch_first_id ?? '?'}: ${s.broken.mismatch_reason ?? 'mismatch'}`,
          blockers: [
            `${s.broken.mismatch_count} entr${s.broken.mismatch_count === 1 ? 'y' : 'ies'} do not verify (check ${s.broken.id})`
          ]
        }
      const oldestMs = s.oldest_unsealed_at ? Date.now() - Date.parse(s.oldest_unsealed_at) : 0
      if (oldestMs > BACKLOG_WARN_MS)
        return {
          status: 'warn',
          detail: `Sealing existing entries: ${s.unsealed ?? '?'} left (oldest waiting since ${s.oldest_unsealed_at})`
        }
      if (s.state === 'not_verified')
        return { status: 'warn', detail: 'Sealed, not verified yet — the daily check has not run' }
      const lastMs = s.last_verified_at ? Date.now() - Date.parse(s.last_verified_at) : Infinity
      if (lastMs > STALE_CHECK_MS)
        return { status: 'warn', detail: `Last checked ${s.last_verified_at ?? 'never'}` }
      return {
        status: 'pass',
        detail: `Intact through ${s.intact_through ?? 'the start'}${s.state === 'acknowledged' ? ' (a break was acknowledged)' : ''}`
      }
    }
  })
}
