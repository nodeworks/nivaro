import { type DeadlineLines, dueInText, liveDeadlineStatus } from '../../lib/deadline-ticker'

/**
 * The record room chip's step clock in words — the SAME figure the record's SLA banner shows
 * ("Due in 1 h 59 m", "Overdue by 17 d 14 h"): calendar time to the clock's own due instant
 * (`due_at`, api services/sla-deadline.ts), counted on the shared page clock. Never derived
 * from `remaining_hours` (on a business-hours clock those are working hours, so dividing them
 * by 24 gave "4d overdue" beside a banner saying 17 days). Null without a due instant.
 */
export function dueText(sla: DeadlineLines | null | undefined, now: number): string | null {
  if (!sla) return null
  const t = dueInText(sla, now)
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null
}

/** Where the clock stands now (moves on between reads); null without a due instant. */
export function dueStatus(
  sla: DeadlineLines | null | undefined,
  now: number
): 'on_track' | 'warning' | 'breached' | null {
  return sla ? liveDeadlineStatus(sla, now) : null
}
