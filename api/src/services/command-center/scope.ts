/**
 * The two lenses every Command Center read takes from its query string:
 *   region — a region row id (CcConfig.region) the whole board is focused on; null = everywhere.
 *   at     — an ISO instant the board is rewound to; null = live. A read that cannot answer for a
 *            past instant answers live and says so (`live_only: true` in its body).
 * Readers never trust these past this parse: ids are bound, never inlined.
 */
export interface CcScope {
  region: string | null
  at: Date | null
}

const MAX_REWIND_MS = 31 * 86_400_000
/** A rewind instant is rounded down to this step, so free-form `at` values share cache entries. */
export const REWIND_STEP_MS = 5 * 60_000

export function readCcScope(query: unknown): CcScope {
  const q = (query ?? {}) as Record<string, unknown>
  const region =
    typeof q.region === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(q.region) ? q.region : null
  let at: Date | null = null
  if (typeof q.at === 'string' && q.at) {
    const d = new Date(q.at)
    const now = Date.now()
    if (Number.isFinite(d.getTime()) && d.getTime() < now && now - d.getTime() <= MAX_REWIND_MS)
      at = new Date(Math.floor(d.getTime() / REWIND_STEP_MS) * REWIND_STEP_MS)
  }
  return { region, at }
}
