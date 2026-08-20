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
  /** Optional automatic fix. Runs as a BACKGROUND job with server-held
   *  progress, so the admin can navigate away and come back. */
  remediation?: {
    label: string
    run: () => Promise<{ detail: string }>
  }
}

const registry = new Map<string, ReadinessCheck>()

export function registerReadinessCheck(check: ReadinessCheck): void {
  registry.set(check.id, check)
}

// ── Remediation jobs — in-memory, per-process (the scorecard is a live
// admin surface, not durable history) ─────────────────────────────────────
export interface RemediationJob {
  check_id: string
  status: 'running' | 'completed' | 'error'
  detail?: string
  started_at: string
  finished_at?: string
}

const remediations = new Map<string, RemediationJob>()

export function listRemediations(): RemediationJob[] {
  return [...remediations.values()].sort((a, b) => b.started_at.localeCompare(a.started_at))
}

/** Fire a check's remediation in the background. Returns false when the
 *  check has no remediation or one is already running. */
export function startRemediation(checkId: string): 'started' | 'no_remediation' | 'already_running' {
  const check = registry.get(checkId)
  if (!check?.remediation) return 'no_remediation'
  if (remediations.get(checkId)?.status === 'running') return 'already_running'
  const job: RemediationJob = {
    check_id: checkId,
    status: 'running',
    started_at: new Date().toISOString()
  }
  remediations.set(checkId, job)
  void check.remediation
    .run()
    .then((r) => {
      job.status = 'completed'
      job.detail = r.detail
      job.finished_at = new Date().toISOString()
    })
    .catch((err) => {
      job.status = 'error'
      job.detail = err instanceof Error ? err.message : String(err)
      job.finished_at = new Date().toISOString()
    })
  return 'started'
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
    remediation_label?: string
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
          remediation_label: c.remediation?.label,
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
          remediation_label: c.remediation?.label,
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
