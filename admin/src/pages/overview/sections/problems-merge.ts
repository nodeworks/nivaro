import type { IntegrationSignalView } from '@nivaro/shared'
import type { ProblemCandidate } from './types'

/**
 * #17 — the Overview's top problems: the server's ranked jobs / SQL checks / readiness list
 * (GET /api/overview/problems) merged with the Integrations Firefight list, which is already in
 * the console's own order (`rankSignals` from @nivaro/shared — never re-ranked here). Both lists
 * keep their internal order; they are interleaved by the same rule the two rankers share:
 * critical first, then the problem open longest.
 */

const oldestRow = (s: IntegrationSignalView): string | null => {
  let best: string | null = null
  for (const r of s.rows) if (!best || r.first_seen < best) best = r.first_seen
  return best
}

/** Open Firefight signals (ranked by the caller with rankSignals) as problem candidates. */
export function signalCandidates(ranked: IntegrationSignalView[]): ProblemCandidate[] {
  return ranked
    .filter((s) => !s.error && s.rows.length > 0)
    .map((s) => {
      const n = Math.max(s.count, s.rows.length)
      return {
        key: `integration:${s.id}`,
        source: 'integrations' as const,
        severity: s.severity === 'critical' ? ('critical' as const) : ('warn' as const),
        since: oldestRow(s),
        sentence: `${s.label}: ${n} open`,
        href: `/integration-health?signal=${encodeURIComponent(s.id)}`
      }
    })
}

/** Does `a` go before `b`? Critical first, then the older start; unknown start last. */
function before(a: ProblemCandidate, b: ProblemCandidate): boolean {
  if (a.severity !== b.severity) return a.severity === 'critical'
  if (a.since && b.since && a.since !== b.since) return a.since < b.since
  if (!a.since !== !b.since) return !!a.since
  return true
}

/** Interleave two already-ranked lists, keeping each list's own order. */
export function mergeProblems(
  server: ProblemCandidate[],
  integrations: ProblemCandidate[],
  limit = 3
): ProblemCandidate[] {
  const out: ProblemCandidate[] = []
  let i = 0
  let j = 0
  while (out.length < limit && (i < server.length || j < integrations.length)) {
    if (j >= integrations.length) out.push(server[i++])
    else if (i >= server.length) out.push(integrations[j++])
    else if (before(server[i], integrations[j])) out.push(server[i++])
    else out.push(integrations[j++])
  }
  return out
}
