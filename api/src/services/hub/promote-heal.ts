import { db } from '../../db/index.js'
import type { GitCtx } from '../gitlab-client.js'
import { getApp } from '../io-holder.js'
import { resumeJobRun } from '../job-runs.js'
import { driverCtx, getDriver } from './drivers.js'
import { deleteBranch } from './gitlab-write.js'
import { PromotionError } from './promote-lock.js'

/**
 * Healing a promotion whose process is gone (phase 2). A `running` deploy row belongs to whoever
 * holds its environment's lock (5 min, renewed every 60 s by a live runner); with nobody holding
 * it the row is stale. Every path that finds one — boot recovery, a plan read, a start — marks it
 * `interrupted`, fails its job run with the same message (it would otherwise stay `running` in
 * the Jobs console) and deletes the run's temporary branches (hub/promote-<id>-<position> and its
 * `-src` twin), so a merge request the crash left open loses its source branch and can no longer
 * be merged.
 *
 * Branch cleanup is best-effort: one attempt per branch, failures logged (branch + error code,
 * never a token), never thrown; a plan read or a start waits at most CLEANUP_WAIT_MS for it.
 */

const DEPLOYS = 'nivaro_hub_deploys'
export const CLEANUP_WAIT_MS = 10_000

type Logger = { warn?: (o: unknown, msg?: string) => void }

export interface HealDeps {
  gitCtx(driverId: number): Promise<GitCtx>
  deleteBranch: typeof deleteBranch
  /** Ends the row's job run as failed with `message` (only while it is still running). */
  failJobRun(jobRunId: number, envId: number | null, message: string): Promise<void>
  logger?: Logger | null
}

/** The job run of a healed row: failed, only while it is still running. Never throws. */
async function failJobRunDefault(
  jobRunId: number,
  envId: number | null,
  message: string
): Promise<void> {
  try {
    await resumeJobRun(jobRunId, 'deploy', `hub-promote-${envId ?? ''}`, {
      guardRunning: true
    }).fail(message)
  } catch {
    /* bookkeeping never breaks healing */
  }
}

/** The GitLab context of a driver; its token is opened here, for one call. */
export async function driverGitCtx(driverId: number): Promise<GitCtx> {
  const d = await getDriver(driverId)
  if (!d) throw new PromotionError('NO_DRIVER', 'The deploy driver no longer exists')
  return driverCtx(d)
}

export function healDeps(over: Partial<HealDeps> = {}): HealDeps {
  return {
    gitCtx: over.gitCtx ?? driverGitCtx,
    deleteBranch: over.deleteBranch ?? deleteBranch,
    failJobRun: over.failJobRun ?? failJobRunDefault,
    logger: over.logger !== undefined ? over.logger : (getApp()?.log ?? null)
  }
}

/** Deletes every temporary branch of a run, from its stored plan. Never throws. */
export async function deleteTemporaryBranches(
  deployId: number,
  planText: string | null,
  deps: HealDeps
): Promise<void> {
  let steps: Array<{ position?: unknown; driverId?: unknown }> = []
  try {
    steps = (JSON.parse(String(planText ?? '')) as { steps?: typeof steps }).steps ?? []
  } catch {
    return
  }
  for (const s of steps) {
    const position = Number(s.position)
    const driverId = Number(s.driverId)
    if (!Number.isInteger(position) || !Number.isInteger(driverId)) continue
    const temp = `hub/promote-${deployId}-${position}`
    for (const branch of [`${temp}-src`, temp]) {
      try {
        await deps.deleteBranch(await deps.gitCtx(driverId), branch)
      } catch (err) {
        deps.logger?.warn?.(
          { deployId, branch, err: (err as { code?: string } | null)?.code ?? 'Error' },
          'hub: could not delete a promotion branch'
        )
      }
    }
  }
}

/** Resolves when `p` settles or after `ms`, whichever is first; never rejects. */
async function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    p.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  ])
  clearTimeout(timer)
}

/** Marks one stale row interrupted (only while still `running`) and cleans up its branches. */
export async function interruptRow(
  row: {
    id: number
    step: string | null
    plan: string | null
    job_run_id?: number | null
    environment_id?: number | null
  },
  error: string,
  deps: HealDeps,
  waitMs = CLEANUP_WAIT_MS
): Promise<boolean> {
  const changed = Number(
    await db(DEPLOYS)
      .where({ id: row.id, status: 'running' })
      .update({ status: 'interrupted', error, finished_at: new Date() })
  )
  if (!changed) return false
  if (row.job_run_id != null)
    await deps.failJobRun(
      Number(row.job_run_id),
      row.environment_id == null ? null : Number(row.environment_id),
      error
    )
  await bounded(deleteTemporaryBranches(Number(row.id), row.plan, deps), waitMs)
  return true
}

/**
 * Marks the environment's stale `running` rows interrupted ("The Hub stopped during <step>").
 * `ownLock` = the caller holds the lock now, so every running row is stale. Otherwise a row is
 * stale only when nobody holds the lock; an unknown lock (Redis unreachable) never heals.
 */
export async function interruptStaleRows(
  envId: number,
  ownLock: boolean,
  isLocked: (envId: number) => Promise<boolean | 'unknown'>,
  deps: Partial<HealDeps> = {}
): Promise<number> {
  const rows = (await db(DEPLOYS)
    .where({ environment_id: envId, status: 'running' })
    .select('id', 'step', 'plan', 'job_run_id', 'environment_id')) as Array<{
    id: number
    step: string | null
    plan: string | null
    job_run_id: number | null
    environment_id: number
  }>
  if (!rows.length) return 0
  if (!ownLock && (await isLocked(envId)) !== false) return 0
  const heal = healDeps(deps)
  let n = 0
  for (const r of rows)
    if (await interruptRow(r, `The Hub stopped during ${r.step ?? 'the start'}`, heal)) n++
  return n
}
