/**
 * Frustration score display helpers (#1388). The score and its components
 * come from api/src/services/session-frustration.ts.
 */

export const FRUSTRATION_COMPONENTS = [
  'rage_clicks',
  'dead_clicks',
  'client_errors',
  'loops',
  'slow_actions',
  'abandoned_forms'
] as const
export type FrustrationComponent = (typeof FRUSTRATION_COMPONENTS)[number]

export const COMPONENT_LABELS: Record<
  FrustrationComponent,
  { one: string; many: string; hint: string }
> = {
  rage_clicks: {
    one: 'rage click',
    many: 'rage clicks',
    hint: 'Three or more clicks on one element within 600 ms'
  },
  dead_clicks: {
    one: 'dead click',
    many: 'dead clicks',
    hint: 'A click that changed nothing on the page'
  },
  client_errors: {
    one: 'client error',
    many: 'client errors',
    hint: 'Errors the page reported to the issue log'
  },
  loops: {
    one: 'back-and-forth',
    many: 'back-and-forths',
    hint: 'Page A → B → A → B within two minutes'
  },
  slow_actions: {
    one: 'slow call',
    many: 'slow calls',
    hint: 'Requests slower than that route’s 95th percentile (and over a second)'
  },
  abandoned_forms: {
    one: 'abandoned form',
    many: 'abandoned forms',
    hint: 'A new record held 10 s, or a record held a minute, left without a save'
  }
}

export interface FrustrationComponents {
  counts?: Partial<Record<FrustrationComponent, number>>
  points?: Partial<Record<FrustrationComponent, number>>
  abandoned_routes?: string[]
}

/** Non-zero components, biggest contribution first, as chip text. */
export function componentChips(
  c: FrustrationComponents | null | undefined
): Array<{ key: FrustrationComponent; text: string; hint: string; points: number }> {
  const counts = c?.counts ?? {}
  return FRUSTRATION_COMPONENTS.filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => {
      const n = counts[k] ?? 0
      const l = COMPONENT_LABELS[k]
      return {
        key: k,
        text: `${n} ${n === 1 ? l.one : l.many}`,
        hint: l.hint,
        points: c?.points?.[k] ?? 0
      }
    })
    .sort((a, b) => b.points - a.points)
}

/** Milliseconds into a recording that a session starts at (for the replay deep link), or null. */
export function offsetInto(
  sessionStart: string | null,
  recordingStart: string | null
): number | null {
  if (!sessionStart || !recordingStart) return null
  const d = Date.parse(sessionStart) - Date.parse(recordingStart)
  return Number.isFinite(d) ? Math.max(0, d) : null
}

export type Weights = Record<FrustrationComponent, number> & { scale: number }
