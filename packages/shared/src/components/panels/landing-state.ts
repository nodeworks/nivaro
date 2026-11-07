/**
 * Where a forward move will actually land (army 8 b06-N-U): the confirm panel
 * said "Waiting on Level 2 → Waiting on Level 3" while Levels 3 and 4 were
 * below their thresholds, and the record went to Level 5. The server's chain
 * read (`/owners/all`) already marks the states the engine will pass through
 * (`skipped`) and the ones on this record's path (`on_path`); from the
 * transition's target, each skipped state hands over to the next state on the
 * path in pipeline order — the engine's own skip route (pickSkipTransition:
 * the first forward route by sort). Pure.
 */
export interface LandingStateRow {
  id: string
  label: string
  sort?: number | null
  is_terminal?: boolean | number | null
}

export interface Landing<S extends LandingStateRow> {
  /** Where the record ends up. */
  state: S
  /** The states it passes through on the way, with the engine's reasons. */
  skipped: Array<{ state: S; reasons: string[] }>
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

export function landingState<S extends LandingStateRow>(
  toStateId: string,
  states: S[],
  chain:
    | Record<string, { skipped?: boolean; skip_reasons?: string[]; on_path?: boolean }>
    | null
    | undefined
): Landing<S> | null {
  const byId = new Map(states.map((s) => [up(s.id), s]))
  const target = byId.get(up(toStateId))
  if (!target) return null
  if (!chain) return { state: target, skipped: [] }
  const entry = (id: string) => {
    for (const [k, v] of Object.entries(chain)) if (up(k) === up(id)) return v
    return undefined
  }
  const ordered = [...states]
    .filter((s) => s.sort != null && Number.isFinite(Number(s.sort)))
    .sort((a, b) => Number(a.sort) - Number(b.sort))
  const skipped: Landing<S>['skipped'] = []
  let at = target
  for (let guard = 0; guard < states.length; guard++) {
    const e = entry(at.id)
    if (!e?.skipped) break
    skipped.push({ state: at, reasons: (e.skip_reasons ?? []).filter(Boolean) })
    const next = ordered.find(
      (s) => Number(s.sort) > Number(at.sort) && entry(s.id)?.on_path !== false
    )
    // No later state on the path: say nothing rather than guess.
    if (!next) return { state: target, skipped: [] }
    at = next
  }
  return { state: at, skipped }
}
