/**
 * Uptime + SLO arithmetic over probe samples. Pure: counts in, figures out.
 *
 * One sample = one probe (hub-fleet-probe, every minute). Uptime = answered samples / samples. An
 * environment with no samples in a window has no uptime (null), never 100 %. Windows are UTC
 * calendar months for the SLO; the fleet page also shows the last 24 hours and 30 days.
 */

export interface UptimeCounts {
  samples: number
  up: number
}

/** Uptime percent with three decimals, or null without samples. */
export function uptimePercent(c: UptimeCounts): number | null {
  if (!c.samples) return null
  return Math.round((c.up / c.samples) * 100_000) / 1000
}

/** Percent → basis points (99.5 → 9950). */
export function toBp(pct: number): number {
  return Math.round(pct * 100)
}

export interface SloFigures {
  uptime: number | null
  target: number
  met: boolean | null
  /** Down samples the target allows in this window, those used, and what is left (≥ 0 or less). */
  budget_samples: number
  used_samples: number
  left_samples: number
}

export function sloFigures(c: UptimeCounts, target: number): SloFigures {
  const uptime = uptimePercent(c)
  const budget = Math.floor(c.samples * (1 - target / 100))
  const used = c.samples - c.up
  return {
    uptime,
    target,
    met: uptime === null ? null : uptime >= target,
    budget_samples: budget,
    used_samples: used,
    left_samples: budget - used
  }
}

const MONTH_RE = /^(\d{4})-(\d{2})$/

/** 'YYYY-MM' → [start, end) in UTC, or null for a malformed month. */
export function monthBounds(month: string): { from: Date; to: Date } | null {
  const m = MONTH_RE.exec(month)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  return { from: new Date(Date.UTC(y, mo - 1, 1)), to: new Date(Date.UTC(y, mo, 1)) }
}

/** The UTC month `now` is in, as 'YYYY-MM'. */
export function monthOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** The UTC month before the one `now` is in. */
export function previousMonth(now: Date): string {
  return monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))
}
