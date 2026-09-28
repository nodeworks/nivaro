/**
 * Operational tasks (#827) — repairs, backfills and migrations an extension
 * (or core) owns, run from the admin console instead of a laptop shell:
 * dry run by default, one run at a time per task, every run a job-runs row
 * with its output kept in memory for the console's tail, an activity row per
 * run naming who ran what and what it left behind.
 *
 * A task says whether it can run on THIS host (`available()`): the
 * efp-ops repairs shell out to scripts a built image does not carry, and
 * the console shows the CLI instead of a dead button.
 */
import type { OpsTaskDef, OpsTaskOutcome, OpsTaskRunContext } from '@nivaro/extension-kit'
import { logActivity } from './activity.js'
import { clearCancel, isCancelled, requestCancel } from './job-cancel.js'
import { startJobRun } from './job-runs.js'

const KEY = /^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)*$/i
const TAIL_LINES = 400
const RUN_TIMEOUT_MS = 20 * 60_000

interface Registered {
  def: OpsTaskDef
  owner: string
}

export interface OpsTaskRun {
  id: number
  key: string
  mode: 'dry' | 'execute'
  status: 'running' | 'completed' | 'error' | 'cancelled'
  started_at: string
  finished_at: string | null
  by: string | null
  progress: { done: number; total: number | null } | null
  outcome: OpsTaskOutcome | null
  error: string | null
  /** The newest lines of output. */
  output: string[]
}

const tasks = new Map<string, Registered>()
const running = new Map<string, number>()
const runs = new Map<number, OpsTaskRun>()
let nextLocalId = -1

export function registerOpsTask(def: OpsTaskDef, owner = 'core'): void {
  if (!def || !KEY.test(def.key))
    throw new Error(`ops task key must be <owner>:<name>: ${def?.key}`)
  if (typeof def.execute !== 'function') throw new Error(`ops task ${def.key} has no execute()`)
  tasks.set(def.key, { def, owner })
}

export function listOpsTasks(): Array<OpsTaskDef & { owner: string }> {
  return [...tasks.values()].map(({ def, owner }) => ({ ...def, owner }))
}

export function getOpsTask(key: string): Registered | undefined {
  return tasks.get(key)
}

/** For tests and reloads: forget the tasks an owner registered. */
export function clearOpsTasks(owner?: string): void {
  for (const [k, v] of tasks) if (!owner || v.owner === owner) tasks.delete(k)
}

export function runningRunFor(key: string): OpsTaskRun | null {
  const id = running.get(key)
  return id == null ? null : (runs.get(id) ?? null)
}

export function getOpsTaskRun(id: number): OpsTaskRun | null {
  return runs.get(id) ?? null
}

/** Newest runs this process saw, newest first (the durable list is nivaro_job_runs). */
export function recentOpsTaskRuns(key?: string, limit = 20): OpsTaskRun[] {
  return [...runs.values()]
    .filter((r) => !key || r.key === key)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, limit)
}

export async function taskAvailability(
  def: OpsTaskDef
): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const a = def.available ? await def.available() : { ok: true }
    return { ok: a.ok, reason: a.ok ? null : (a.reason ?? 'Not available on this host') }
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message ?? 'availability check failed' }
  }
}

export class OpsTaskBusyError extends Error {
  statusCode = 409
  constructor(
    public readonly run: OpsTaskRun,
    key: string
  ) {
    super(`${key} is already running (run ${run.id})`)
  }
}

/**
 * Start a run and return at once; the run continues in the background. A
 * dry run on a task without one is refused; a task that is unavailable here
 * is refused with its reason.
 */
export async function startOpsTask(
  key: string,
  opts: { execute?: boolean; userId?: string | null }
): Promise<OpsTaskRun> {
  const reg = tasks.get(key)
  if (!reg) throw Object.assign(new Error(`No task '${key}'`), { statusCode: 404 })
  const { def } = reg
  const mode: 'dry' | 'execute' = opts.execute ? 'execute' : 'dry'
  if (mode === 'dry' && !def.dryRun)
    throw Object.assign(new Error(`${def.label} has no dry run — run it for real`), {
      statusCode: 400
    })
  const avail = await taskAvailability(def)
  if (!avail.ok)
    throw Object.assign(new Error(`${avail.reason}${def.cli ? ` — CLI: ${def.cli}` : ''}`), {
      statusCode: 409
    })
  const busy = runningRunFor(key)
  if (busy) throw new OpsTaskBusyError(busy, key)

  const handle = await startJobRun('task', `task:${key}`, {
    label: `${def.label} (${mode === 'dry' ? 'dry run' : 'execute'})`,
    extensionId: reg.owner === 'core' ? undefined : reg.owner,
    triggeredBy: opts.userId ?? null
  })
  const id = handle.id ?? nextLocalId--
  const run: OpsTaskRun = {
    id,
    key,
    mode,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    by: opts.userId ?? null,
    progress: null,
    outcome: null,
    error: null,
    output: []
  }
  runs.set(id, run)
  running.set(key, id)
  if (runs.size > 200) {
    const oldest = [...runs.values()]
      .filter((r) => r.status !== 'running')
      .sort((a, b) => a.started_at.localeCompare(b.started_at))[0]
    if (oldest) runs.delete(oldest.id)
  }

  const rctx: OpsTaskRunContext = {
    log: (line) => {
      run.output.push(String(line).slice(0, 2000))
      if (run.output.length > TAIL_LINES) run.output.splice(0, run.output.length - TAIL_LINES)
    },
    progress: (done, total) => {
      run.progress = { done, total: total ?? null }
      handle.progress({ done, total: total ?? null })
    },
    cancelled: () => handle.id != null && isCancelled(handle.id),
    userId: opts.userId ?? null,
    dryRun: mode === 'dry'
  }

  const finish = async (
    status: OpsTaskRun['status'],
    outcome: OpsTaskOutcome | null,
    err: unknown
  ) => {
    run.status = status
    run.finished_at = new Date().toISOString()
    run.outcome = outcome
    run.error = err ? ((err as Error)?.message ?? String(err)) : null
    if (running.get(key) === id) running.delete(key)
    if (handle.id != null) clearCancel(handle.id)
    if (status === 'error') await handle.fail(err)
    else await handle.complete(outcome?.summary ?? status)
    const secs = Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000)
    void logActivity({
      action: 'ops-task-run',
      user: opts.userId ?? null,
      collection: 'nivaro_ops_tasks',
      item: key,
      comment: `${mode === 'dry' ? 'dry run' : 'EXECUTE'} · ${status} · ${secs}s${outcome ? ` · ${outcome.summary}` : ''}${
        outcome?.backup_tables?.length ? ` · backups ${outcome.backup_tables.join(', ')}` : ''
      }${run.error ? ` · ${run.error.slice(0, 300)}` : ''}`,
      origin: opts.userId ? 'person' : 'machine'
    }).catch(() => {})
  }

  const timer = setTimeout(() => {
    if (handle.id != null) requestCancel(handle.id)
    rctx.log(`[console] run exceeded ${RUN_TIMEOUT_MS / 60000} minutes — cancellation requested`)
  }, RUN_TIMEOUT_MS)
  timer.unref()
  void (async () => {
    try {
      const out = mode === 'dry' ? await def.dryRun!(rctx) : await def.execute(rctx)
      await finish(rctx.cancelled() ? 'cancelled' : 'completed', out, null)
    } catch (err) {
      await finish(rctx.cancelled() ? 'cancelled' : 'error', null, err)
    } finally {
      clearTimeout(timer)
    }
  })()
  return run
}

export function cancelOpsTaskRun(id: number): boolean {
  const run = runs.get(id)
  if (!run || run.status !== 'running') return false
  if (id > 0) requestCancel(id)
  run.output.push('[console] cancellation requested')
  return true
}
