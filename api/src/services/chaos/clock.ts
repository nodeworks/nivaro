/**
 * The application clock (#2835). Decisions that compare "now" with a stored time — session
 * and API-key expiry, SLA timers, maintenance windows, the cron fire-time slot — read it here
 * instead of `Date.now()`, so the clock-skew drill can move ONE replica's idea of now without
 * touching `Date` (a global monkeypatch would also skew timers, logs and the drill's own end).
 *
 * Leaf module: no imports. The offset is 0 except while a `clock_skew` fault is armed on this
 * replica; the fault's release puts it back. Logging timestamps keep using `Date`.
 */

/** Never more than a day either way, whatever a caller asks for. */
export const MAX_SKEW_MS = 24 * 3_600_000

let offsetMs = 0

/** Epoch ms as the application sees it (real time plus the drill's skew). */
export function appNow(): number {
  return offsetMs === 0 ? Date.now() : Date.now() + offsetMs
}

/**
 * Now for authentication and expiry checks (API keys, sessions, share links, delegations, media
 * tickets): the skew may only make them stricter. A clock set back must never accept what real
 * time rejects, so a negative skew is ignored here (F3).
 */
export function appNowForAuth(): number {
  return offsetMs > 0 ? Date.now() + offsetMs : Date.now()
}

/** `new Date()` as the application sees it. */
export function appDate(): Date {
  return new Date(appNow())
}

/** The current skew in ms (0 = none). */
export function clockSkewMs(): number {
  return offsetMs
}

/** Set this replica's skew (clamped to ±24 h). Only the clock-skew fault calls it. */
export function setClockSkew(ms: number): void {
  const n = Number.isFinite(ms) ? Math.round(ms) : 0
  offsetMs = Math.max(-MAX_SKEW_MS, Math.min(MAX_SKEW_MS, n))
}
