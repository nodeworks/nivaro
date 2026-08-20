/**
 * Readiness check registry — a scored, continuously-runnable checklist for
 * "are we ready to X" questions (go-live cutover being the canonical one).
 *
 * The FRAME is generic: extensions register named checks via
 * `ctx.readiness.registerCheck(...)` (same pattern as digest sections), and
 * `/api/readiness` runs them all and scores the result. The CHECKS are
 * deployment-specific and live with the deployment's extension — core ships
 * none of its own, so a stock install simply reports an empty checklist.
 */

export type ReadinessStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface ReadinessResult {
  status: ReadinessStatus
  /** One-sentence current state, shown under the check. */
  detail?: string
  /** Concrete blockers to resolve, listed as bullet lines. */
  blockers?: string[]
}

export interface ReadinessCheck {
  id: string
  label: string
  description?: string
  /** Grouping header on the scorecard (e.g. 'Data', 'Integrations'). */
  group?: string
  run: () => Promise<ReadinessResult>
}

const registry = new Map<string, ReadinessCheck>()

export function registerReadinessCheck(check: ReadinessCheck): void {
  registry.set(check.id, check)
}

export interface ReadinessReport {
  score: number | null
  counts: Record<ReadinessStatus | 'error', number>
  checks: Array<{
    id: string
    label: string
    description?: string
    group?: string
    status: ReadinessStatus | 'error'
    detail?: string
    blockers?: string[]
    duration_ms: number
  }>
}

export async function runReadinessChecks(): Promise<ReadinessReport> {
  const checks = [...registry.values()]
  const results = await Promise.all(
    checks.map(async (c) => {
      const began = Date.now()
      try {
        const r = await c.run()
        return {
          id: c.id,
          label: c.label,
          description: c.description,
          group: c.group,
          status: r.status,
          detail: r.detail,
          blockers: r.blockers?.length ? r.blockers : undefined,
          duration_ms: Date.now() - began
        }
      } catch (err) {
        // A check that cannot run is itself a finding, never a 500.
        return {
          id: c.id,
          label: c.label,
          description: c.description,
          group: c.group,
          status: 'error' as const,
          detail: err instanceof Error ? err.message : String(err),
          duration_ms: Date.now() - began
        }
      }
    })
  )
  const counts: ReadinessReport['counts'] = { pass: 0, warn: 0, fail: 0, skip: 0, error: 0 }
  for (const r of results) counts[r.status]++
  const scored = results.filter((r) => r.status !== 'skip')
  // Score: pass = 1, warn = half credit, fail/error = 0.
  const score =
    scored.length === 0
      ? null
      : Math.round(
          (scored.reduce(
            (a, r) => a + (r.status === 'pass' ? 1 : r.status === 'warn' ? 0.5 : 0),
            0
          ) /
            scored.length) *
            100
        )
  return { score, counts, checks: results }
}
