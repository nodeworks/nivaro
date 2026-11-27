import { getApp } from '../../io-holder.js'
import { hubNotify } from '../providers/notify-hook.js'
import { errText } from './env-db.js'
import { DATA_LOCK_RENEW_MS, type DataLock, defaultDataLock } from './lock.js'
import {
  createRun,
  HEARTBEAT_MS,
  newSteps,
  patchRun,
  type RunPatch,
  readRun,
  setStep
} from './runs.js'
import { DataError, type DataRunKind, type DataRunStatus, type DataStep } from './types.js'

/**
 * Hub data care: one runner for every data run. It holds the environment's data lock (and the
 * source's, for a refresh or a rehearsal) for the whole run, renews it, writes the heartbeat,
 * keeps the step list in the run row and ends the run once: `done`, `waiting`, or `failed` with
 * the failing step marked and a plain sentence. `cleanup` always runs (a drill's scratch
 * database is dropped whatever happened).
 *
 * A step already `done` in the row is skipped, so a refresh that was interrupted resumes where
 * it stopped (`resume`). Runs started from a route or the schedule run in the background: the
 * caller gets the run id at once and reads progress from the row.
 */

export interface StepOutcome {
  note?: string | null
  /** The step finished but something deserves a look (the run goes on). */
  warn?: boolean
  skipped?: boolean
}

export interface RunCtx {
  id: number
  readonly steps: DataStep[]
  /** Runs one step: skipped when the row says it is already done. */
  step(key: string, fn: () => Promise<StepOutcome | string | undefined>): Promise<void>
  patch(p: Omit<RunPatch, 'steps' | 'status' | 'finished'>): Promise<void>
  log(msg: string): void
}

export interface RunBodyResult {
  status?: Extract<DataRunStatus, 'done' | 'waiting'>
  result?: Record<string, unknown>
  artifact?: Record<string, unknown> | null
}

export interface RunnerDeps {
  lock?: DataLock
  /** Run in the background (routes, schedule); tests await the run. */
  background?: boolean
}

interface Begin {
  envIds: number[]
  body: (ctx: RunCtx) => Promise<RunBodyResult | undefined>
  cleanup?: (ctx: RunCtx, failed: boolean) => Promise<void>
  deps?: RunnerDeps
  /** resumeDataRun: the statuses that may be continued (default interrupted / waiting). */
  statuses?: DataRunStatus[]
}

async function takeLocks(lock: DataLock, envIds: number[]): Promise<Map<number, string>> {
  const held = new Map<number, string>()
  for (const id of [...new Set(envIds)]) {
    const token = await lock.take(id)
    if (!token) {
      for (const [e, t] of held) await lock.release(e, t)
      throw new DataError(
        'DATA_BUSY',
        'Another backup, drill, refresh or rehearsal is running on this environment — wait for it to end.'
      )
    }
    held.set(id, token)
  }
  return held
}

function logger() {
  try {
    return getApp()?.log ?? null
  } catch {
    return null
  }
}

async function execute(runId: number, initial: DataStep[], b: Begin, held: Map<number, string>) {
  const lock = b.deps?.lock ?? defaultDataLock()
  let steps = initial
  let current: string | null = null
  const save = (p: RunPatch = {}) => patchRun(runId, { ...p, steps })
  // A lock another holder took over (it expired under a stalled process) stops the run at its
  // next step: two runs never keep working on one environment.
  let lost = false
  const timer = setInterval(
    () => {
      void patchRun(runId, {}).catch(() => undefined)
      for (const [e, t] of held)
        void lock
          .renew(e, t)
          .then((ok) => {
            if (!ok) lost = true
          })
          .catch(() => undefined)
    },
    Math.min(HEARTBEAT_MS, DATA_LOCK_RENEW_MS)
  )
  timer.unref?.()
  const ctx: RunCtx = {
    id: runId,
    get steps() {
      return steps
    },
    async step(key, fn) {
      const s = steps.find((x) => x.key === key)
      if (s?.state === 'done' || s?.state === 'skipped' || s?.state === 'warn') return
      if (lost)
        throw new DataError(
          'DATA_BUSY',
          'This run lost its lock on the environment (its process stalled): it stopped before the next step.'
        )
      current = key
      steps = setStep(steps, key, 'running', null)
      await save({ step: key })
      const out = await fn()
      const o: StepOutcome = typeof out === 'string' ? { note: out } : (out ?? {})
      steps = setStep(steps, key, o.skipped ? 'skipped' : o.warn ? 'warn' : 'done', o.note ?? null)
      current = null
      await save()
    },
    async patch(p) {
      await patchRun(runId, { ...p, steps })
    },
    log(msg) {
      logger()?.info?.({ data_run: runId }, msg)
    }
  }
  let failed = false
  try {
    const r = (await b.body(ctx)) ?? {}
    await save({
      status: r.status ?? 'done',
      ...(r.result !== undefined ? { result: r.result } : {}),
      ...(r.artifact !== undefined ? { artifact: r.artifact } : {}),
      step: null,
      error: null,
      finished: (r.status ?? 'done') === 'done'
    })
  } catch (err) {
    failed = true
    const text = err instanceof DataError ? err.message : errText(err)
    if (current) steps = setStep(steps, current, 'failed', text)
    await save({
      status: err instanceof DataError && err.code === 'PLAN_BLOCKED' ? 'refused' : 'failed',
      error: text,
      finished: true
    }).catch(() => undefined)
    logger()?.warn?.(
      { data_run: runId, code: (err as { code?: unknown })?.code ?? null },
      'hub data run failed'
    )
    void readRun(runId)
      .then((r) => {
        if (r && /backup/.test(r.kind))
          hubNotify('backup.failed', {
            envId: r.environment_id,
            detail: r.kind.replace('_', ' '),
            link: '/hub/data'
          })
      })
      .catch(() => undefined)
  } finally {
    clearInterval(timer)
    if (b.cleanup) await b.cleanup(ctx, failed).catch(() => undefined)
    for (const [e, t] of held) await lock.release(e, t)
  }
}

/** Starts a run: locks, row, then the body (in the background unless deps say otherwise). */
export async function startDataRun(
  o: Begin & {
    kind: DataRunKind
    environmentId: number
    sourceEnvironmentId?: number | null
    steps: ReadonlyArray<{ key: string; label: string }>
    plan?: Record<string, unknown> | null
    planHash?: string | null
    by?: string | null
    via?: 'person' | 'schedule'
  }
): Promise<number> {
  // A retired (archived) app takes no backup, drill, refresh or rehearsal any more.
  const { archivedRefusal } = await import('../releases/archived.js')
  for (const envId of [...new Set(o.envIds)]) {
    const archived = await archivedRefusal({ envId })
    if (archived) throw new DataError('ENV_ARCHIVED', archived.message, 409)
  }
  const lock = o.deps?.lock ?? defaultDataLock()
  const held = await takeLocks(lock, o.envIds)
  let runId: number
  const steps = newSteps(o.steps)
  try {
    runId = await createRun({
      kind: o.kind,
      environmentId: o.environmentId,
      sourceEnvironmentId: o.sourceEnvironmentId ?? null,
      steps,
      plan: o.plan ?? null,
      planHash: o.planHash ?? null,
      startedBy: o.by ?? null,
      via: o.via ?? 'person'
    })
  } catch (err) {
    for (const [e, t] of held) await lock.release(e, t)
    throw err
  }
  const p = execute(runId, steps, o, held)
  if (o.deps?.background === false) await p
  else void p.catch(() => undefined)
  return runId
}

/** Continues an interrupted (or waiting) run from its first step not done. */
export async function resumeDataRun(runId: number, o: Begin): Promise<void> {
  const run = await readRun(runId)
  if (!run) throw new DataError('NOT_FOUND', 'No such run.', 404)
  const allowed = o.statuses ?? ['interrupted', 'waiting']
  if (!allowed.includes(run.status))
    throw new DataError('NOT_RESUMABLE', `A ${run.status} run cannot be continued.`)
  const lock = o.deps?.lock ?? defaultDataLock()
  const held = await takeLocks(lock, o.envIds)
  // The failed / running step starts over; done steps are kept.
  const steps = run.steps.map((s) =>
    s.state === 'running' || s.state === 'failed'
      ? { ...s, state: 'pending' as const, note: null }
      : s
  )
  await patchRun(runId, { status: 'running', steps, error: null })
  const p = execute(runId, steps, o, held)
  if (o.deps?.background === false) await p
  else void p.catch(() => undefined)
}
