/**
 * The host agent's own admission check for a queued run. The console's
 * routes already enforce these rules, but the agent executes whatever row it
 * claims, so it re-applies them itself: a row that reached the queue some
 * other way (a script, a hand edit) must not be able to point a runbook at a
 * refused target, start from an undeclared step, or skip the dry run.
 */
import type { ExtensionRunbookDecl } from '@nivaro/extension-kit'
import { dryRunGate, type RunbookSummary, validateTarget } from './runbook-runs.js'

export interface AdmissionRun {
  extension: string
  runbook: string
  mode: string
  target: string | null
  from_step: string | null
}

/** A real run must follow a finished dry run unless the runbook declares it reads only. */
export function needsDryRun(decl: ExtensionRunbookDecl): boolean {
  return decl.skip_dry_gate !== true
}

/** null = admissible; otherwise the reason the run is refused. */
export function hostRunRefusal(
  decl: ExtensionRunbookDecl,
  run: AdmissionRun,
  priorRuns: RunbookSummary[],
  now = Date.now()
): string | null {
  if (run.mode !== 'dry' && run.mode !== 'go') return `unknown mode ${String(run.mode)}`
  const t = validateTarget(decl, run.target)
  if (!t.ok) return t.error
  if (decl.target_env && !t.target) return `${decl.target_env} is required`
  if (run.from_step != null && run.from_step !== '') {
    if (!decl.resume_flag) return 'this runbook cannot start from a step'
    const phases = decl.phases ?? []
    const byKey = phases.some((p) => p.key === run.from_step)
    const n = Number(run.from_step)
    const byNumber = Number.isInteger(n) && n >= 1 && n <= phases.length
    if (!byKey && !byNumber) return `unknown start step ${run.from_step}`
  }
  if (
    run.mode === 'go' &&
    needsDryRun(decl) &&
    !dryRunGate(priorRuns, run.extension, run.runbook, t.target, now)
  )
    return 'a real run needs a finished dry run of the same target from the last 24 hours'
  return null
}
