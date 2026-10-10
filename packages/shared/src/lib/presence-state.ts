/**
 * Idle or stuck (#1394). /presence/online, the people page and the team view
 * answer `stuck: { minutes, label }` for someone at the keyboard, on the same
 * route, with nothing saved for ten minutes — shown to admins and the
 * person's manager only. One wording everywhere.
 */
export interface StuckState {
  minutes: number
  /** The record's friendly id ("CM26-80332") or the page path. */
  label: string | null
}

/** "stuck on CM26-80332 for 12m" (or "stuck for 12m" with no page). */
export function stuckText(s: StuckState): string {
  const m = Math.max(0, Math.floor(s.minutes))
  const span = m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
  return s.label ? `stuck on ${s.label} for ${span}` : `stuck for ${span}`
}
