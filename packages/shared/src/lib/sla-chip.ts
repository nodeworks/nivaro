// Pure formatting for an SLA reading — no React, no fetch. Twin of
// efp-new's src/features/dashboard-canvas/lib/sla-chips.ts (#853, #881);
// keep both byte-identical, since shared cannot import from efp-new.

export interface SlaLike {
  status: 'ok' | 'warning' | 'breached' | null
  remaining_hours: number | null
  elapsed_hours?: number | null
}

export interface SlaChip {
  label: string
  tone: 'ok' | 'warn' | 'alert' | 'neutral'
}

const HOURS_PER_DAY = 24

// Formats a positive magnitude of hours as "Nh" (rounded, floored at 1) below
// the 24h boundary, else "Nd" (floored, floored at 1) — the same threshold a
// caller uses to decide alert-eta tone, so the unit choice always agrees with
// the tone.
function formatMagnitude(hours: number): { text: string; isHours: boolean } {
  if (hours < HOURS_PER_DAY) {
    const h = Math.max(1, Math.round(hours))
    return { text: `${h}h`, isHours: true }
  }
  const d = Math.max(1, Math.floor(hours / HOURS_PER_DAY))
  return { text: `${d}d`, isHours: false }
}

/**
 * Renders an SLA reading as a short chip: how long ago it breached, or how
 * long until it does. `_now` is accepted for a future freshness check but the
 * current formatting is entirely derived from the already-computed
 * remaining_hours, so it is unused today.
 */
export function slaChip(s: SlaLike | null | undefined, _now?: number): SlaChip | null {
  if (!s?.status) return null

  if (s.status === 'breached') {
    if (s.remaining_hours == null || !Number.isFinite(s.remaining_hours)) {
      return { label: 'breached', tone: 'alert' }
    }
    const { text } = formatMagnitude(-s.remaining_hours)
    return { label: `breached ${text} ago`, tone: 'alert' }
  }

  if (s.remaining_hours == null || !Number.isFinite(s.remaining_hours)) return null

  const { text, isHours } = formatMagnitude(s.remaining_hours)
  return { label: `breaches in ${text}`, tone: isHours ? 'warn' : 'neutral' }
}

/** True for a not-yet-breached reading due within the next day. */
export function withinDay(s: SlaLike | null | undefined): boolean {
  if (!s) return false
  return s.status !== 'breached' && s.remaining_hours != null && s.remaining_hours <= 24
}
