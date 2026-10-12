/**
 * The Ask AI plan RUNNER — the order rules, nothing else. No database, no
 * AI, no step kinds: the caller (services/ai-plans.ts) hands in how to check
 * a step's condition and how to execute it, and this walks the steps.
 *
 * Rules (#1807, #1953, #1902):
 *  - Steps run strictly in order. Only `pending` steps run; `done`,
 *    `skipped` and `cancelled` are passed over, so a plan resumes where it
 *    left off.
 *  - A step whose condition fails is `skipped` with the reason, and the plan
 *    goes on. A condition may also NARROW the step (per-record conditions on
 *    a bulk step drop the records that fail and run the rest).
 *  - A step that is refused (throws, or reports `ok: false`) is `failed`
 *    with the reason and the plan STOPS — later steps stay `pending`, so a
 *    retry can pick up from exactly there.
 *  - A step left `running` (the process died mid-step) is never re-run
 *    blindly: it is marked `failed` as interrupted and the plan stops.
 *  - `through` = run up to and including that step, then pause (approving
 *    step by step). The plan reads `executed` once nothing is pending.
 *
 * Kept pure so later items (scheduled plans, plan templates, a plan turned
 * into a flow) reuse the same rules.
 */

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'

export type PlanStatus =
  | 'proposed'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'expired'

/** A step's condition (#1953), checked when the step is about to run. */
export interface PlanStepCondition {
  /** How a person would say it — "only if still in Finance Review". */
  label?: string
  /** The record(s) checked. Absent = the step's own target records. */
  collection?: string
  ids?: string[]
  /** Same filter shape Ask AI's query_items uses (dotted paths, `$state`). */
  where?: Record<string, unknown>
  /** Fields that must still hold the value they had when the plan was made. */
  unchanged?: string[]
  /** Captured at propose time: record id → field → value. */
  snapshot?: Record<string, Record<string, unknown>>
}

/** One step as proposed. `payload` is what runs; `input` is what the model
 *  asked for (kept so a retry can rebuild the payload, and so a later
 *  "turn this plan into a flow" item can read the intent). */
export interface PlanStepDef {
  id: string
  n: number
  kind: string
  title: string
  input: Record<string, unknown>
  payload: Record<string, unknown>
  preview: Record<string, unknown>
  /** The records the step acts on, when it acts on existing ones. */
  targets?: { collection: string; ids: string[] } | null
  condition?: PlanStepCondition | null
}

export interface PlanSkippedRecord {
  id: string
  label?: string
  reason: string
}

export interface PlanStepState {
  id: string
  status: PlanStepStatus
  records_changed: number
  result?: Record<string, unknown> | null
  error?: string | null
  skip_reason?: string | null
  /** Records a per-record condition left out (the step still ran). */
  skipped_records?: PlanSkippedRecord[]
  attempts: number
  started_at?: string | null
  finished_at?: string | null
}

export interface PlanDoc {
  steps: PlanStepDef[]
  state: PlanStepState[]
}

export interface ConditionOutcome {
  pass: boolean
  /** A narrowed payload to run instead of the step's own. */
  payload?: Record<string, unknown>
  reason?: string
  skipped_records?: PlanSkippedRecord[]
}

/** One record a step wrote, captured as it ran (#2002 change report, #1954
 *  undo). `before` is read raw — it is never shown without a per-viewer
 *  access check (services/ai-plan-report.ts). */
export interface PlanMadeRecord {
  id: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  /** Newest nivaro_revisions id for the record just after the write. */
  rev: number | null
  /** When the write landed on another collection than the step's (a Data
   *  Integrity fix may repair a grid line). */
  collection?: string
  /** The step created the record (undo = delete it). */
  created?: boolean
  /** Reverted by an administrator (#1954). */
  undone?: boolean
}

export interface PlanStepMade {
  collection: string
  records: PlanMadeRecord[]
  undone_at?: string | null
  undone_by?: string | null
}

export interface StepOutcome {
  ok: boolean
  result: Record<string, unknown>
  records_changed: number
  error?: string
  /** What the step wrote — the plan service keeps it out of `result`. */
  made?: PlanStepMade | null
}

export interface PlanRunDeps {
  checkCondition: (step: PlanStepDef) => Promise<ConditionOutcome>
  executeStep: (step: PlanStepDef, payload: Record<string, unknown>) => Promise<StepOutcome>
  /** After every state change (step started / finished). */
  onProgress?: (step: PlanStepState, doc: PlanDoc) => void | Promise<void>
  /** Polled between steps — true stops the plan (the rest are cancelled). */
  shouldStop?: () => boolean
  now?: () => Date
}

export interface PlanRunResult {
  status: PlanStatus
  records_changed: number
  /** The step that failed, when the plan stopped on one. */
  failed_step?: string
}

export function emptyStepState(id: string): PlanStepState {
  return { id, status: 'pending', records_changed: 0, attempts: 0 }
}

/** Total records changed across every step. */
export function totalRecordsChanged(doc: PlanDoc): number {
  return doc.state.reduce((n, s) => n + (s.records_changed || 0), 0)
}

/** The status a plan reads as from its step states alone. */
export function statusFromState(doc: PlanDoc): PlanStatus {
  if (doc.state.some((s) => s.status === 'failed')) return 'failed'
  if (doc.state.some((s) => s.status === 'cancelled')) return 'rejected'
  if (doc.state.every((s) => s.status === 'done' || s.status === 'skipped')) return 'executed'
  return 'paused'
}

function stateFor(doc: PlanDoc, id: string): PlanStepState {
  let s = doc.state.find((x) => x.id === id)
  if (!s) {
    s = emptyStepState(id)
    doc.state.push(s)
  }
  return s
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err ?? 'Step failed')).slice(0, 500)
}

/**
 * Walk the plan. Mutates `doc.state` in place (the caller persists it from
 * `onProgress` and at the end).
 */
export async function runPlanSteps(
  doc: PlanDoc,
  deps: PlanRunDeps,
  opts: { through?: string | null } = {}
): Promise<PlanRunResult> {
  const now = () => (deps.now ? deps.now() : new Date()).toISOString()
  const progress = async (s: PlanStepState) => {
    if (deps.onProgress) await deps.onProgress(s, doc)
  }
  const ordered = [...doc.steps].sort((a, b) => a.n - b.n)

  for (let i = 0; i < ordered.length; i++) {
    const step = ordered[i]
    const s = stateFor(doc, step.id)
    if (s.status === 'done' || s.status === 'skipped' || s.status === 'cancelled') continue
    if (s.status === 'running') {
      s.status = 'failed'
      s.error = 'Interrupted while running — check the records before retrying'
      s.finished_at = now()
      await progress(s)
      return { status: 'failed', records_changed: totalRecordsChanged(doc), failed_step: step.id }
    }
    if (s.status === 'failed') {
      return { status: 'failed', records_changed: totalRecordsChanged(doc), failed_step: step.id }
    }

    if (deps.shouldStop?.()) {
      for (const rest of ordered.slice(i)) {
        const r = stateFor(doc, rest.id)
        if (r.status === 'pending') {
          r.status = 'cancelled'
          await progress(r)
        }
      }
      return { status: 'rejected', records_changed: totalRecordsChanged(doc) }
    }

    s.status = 'running'
    s.attempts = (s.attempts || 0) + 1
    s.started_at = now()
    s.error = null
    s.skip_reason = null
    s.skipped_records = undefined
    await progress(s)

    let payload = step.payload
    if (step.condition) {
      let cond: ConditionOutcome
      try {
        cond = await deps.checkCondition(step)
      } catch (err) {
        s.status = 'failed'
        s.error = `Could not check the condition: ${errorText(err)}`
        s.finished_at = now()
        await progress(s)
        return { status: 'failed', records_changed: totalRecordsChanged(doc), failed_step: step.id }
      }
      if (cond.skipped_records?.length) s.skipped_records = cond.skipped_records.slice(0, 50)
      if (!cond.pass) {
        s.status = 'skipped'
        s.skip_reason = cond.reason ?? 'Condition not met'
        s.finished_at = now()
        await progress(s)
        if (opts.through === step.id) break
        continue
      }
      if (cond.payload) payload = cond.payload
    }

    try {
      const out = await deps.executeStep(step, payload)
      s.result = out.result
      s.records_changed = out.records_changed || 0
      if (!out.ok) {
        s.status = 'failed'
        s.error = out.error ?? 'The step was refused'
      } else {
        s.status = 'done'
      }
    } catch (err) {
      s.status = 'failed'
      s.error = errorText(err)
    }
    s.finished_at = now()
    await progress(s)
    if (s.status === 'failed') {
      return { status: 'failed', records_changed: totalRecordsChanged(doc), failed_step: step.id }
    }
    if (opts.through === step.id) break
  }

  const status = statusFromState(doc)
  return { status, records_changed: totalRecordsChanged(doc) }
}

/** Ready a failed plan for a retry: the failed step goes back to pending
 *  (its attempts count is kept); `running` leftovers too. */
export function resetFailedSteps(doc: PlanDoc): string[] {
  const reset: string[] = []
  for (const s of doc.state) {
    if (s.status === 'failed' || s.status === 'running') {
      s.status = 'pending'
      s.error = null
      reset.push(s.id)
    }
  }
  return reset
}
