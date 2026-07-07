/**
 * JS reference implementation of the legacy transition extraction — mirrors
 * both the EFP WorkflowTimeline reduce and the SQL LAG() statement in
 * scripts/migrate-legacy-history.ts. Used by that script's --verify sampler.
 */
export interface LegacySnap {
  revId: number
  activityId: number
  timestamp: string
  state: number | null
}

export interface ExtractedTransition {
  fromLegacyState: number | null
  toLegacyState: number
  activityId: number
}

export function extractTransitions(snaps: LegacySnap[]): ExtractedTransition[] {
  const known = snaps
    .filter((s): s is LegacySnap & { state: number } => s.state != null)
    .sort((a, b) => {
      const ta = new Date(a.timestamp).getTime()
      const tb = new Date(b.timestamp).getTime()
      return ta !== tb ? ta - tb : a.revId - b.revId
    })
  const out: ExtractedTransition[] = []
  let prev: number | null = null
  for (const s of known) {
    if (prev === null || prev !== s.state) {
      out.push({ fromLegacyState: prev, toLegacyState: s.state, activityId: s.activityId })
    }
    prev = s.state
  }
  return out
}
