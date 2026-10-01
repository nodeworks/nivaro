/**
 * Whether this process fires scheduled jobs on the clock.
 *
 * A development process shares its database with a deployed instance (the
 * dev laptop and staging both point at one database), so every clock-driven
 * job — digests, escalations, partner polls, the import worker, scheduled
 * flows — would run twice and mail people twice. Development processes
 * therefore keep their schedules registered (the roster, dry runs and
 * run-now all still work) but never tick; deployed instances tick.
 *
 * CRON_TICKS=on|off overrides either way (a self-hosted developer with their
 * own database sets `on`; a throwaway production-mode boot sets `off`).
 *
 * Leaf module (no imports) — job bookkeeping reads it without a cycle through
 * the cron plugin (#1051).
 */
export function cronTicksEnabled(): boolean {
  const raw = (process.env.CRON_TICKS ?? '').trim().toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(raw)) return true
  if (['off', 'false', '0', 'no'].includes(raw)) return false
  return process.env.NODE_ENV !== 'development'
}
