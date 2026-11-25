/** A `?recent_minutes=` value, clamped to 1–60; null when absent or not a number (pure leaf). */
export function recentMinutesParam(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{1,4}$/.test(v)) return null
  const n = Number(v)
  return n >= 1 ? Math.min(60, n) : null
}
