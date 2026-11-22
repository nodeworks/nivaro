import { db } from '../../db/index.js'
import type { GitCtx } from '../gitlab-client.js'
import { getApp } from '../io-holder.js'
import { dockerHealNote, type StackStateReader } from './docker/stack-heal.js'
import { driverCtx, getDriver } from './drivers.js'
import { deleteBranch } from './gitlab-write.js'
import { PromotionError } from './promote-lock.js'

/**
 * Healing a promotion whose process is gone (phase 2). A `running` deploy row belongs to whoever
 * holds its environment's lock (5 min, renewed every 60 s by a live runner); with nobody holding
 * it the row is stale. Every path that finds one — boot recovery, a plan read, a start — marks it
 * `interrupted` and deletes the run's temporary branches (hub/promote-<id>-<position>), so a merge
 * request the crash left open loses its source branch and can no longer be merged.
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
  logger?: Logger | null
  /** phase 4: reads a docker step's stack state through the Hub agent (default: the real one). */
  stackState?: StackStateReader
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
    logger: over.logger !== undefined ? over.logger : (getApp()?.log ?? null),
    ...(over.stackState ? { stackState: over.stackState } : {})
  }
}

/** Deletes every temporary branch of a run, from its stored plan. Never throws. */
export async function deleteTemporaryBranches(
  deployId: number,
  planText: string | null,
  deps: HealDeps
): Promise<void> {
  let steps: Array<{ position?: unknown; driverId?: unknown; driver?: unknown }> = []
  try {
    steps = (JSON.parse(String(planText ?? '')) as { steps?: typeof steps }).steps ?? []
  } catch {
    return
  }
  for (const s of steps) {
    // phase 4: a docker step has no branch, and its driver is no GitLab (dockerHealNote reads it).
    if (s.driver === 'docker') continue
    const position = Number(s.position)
    const driverId = Number(s.driverId)
    if (!Number.isInteger(position) || !Number.isInteger(driverId)) continue
    const branch = `hub/promote-${deployId}-${position}`
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
  row: { id: number; step: string | null; plan: string | null },
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
  await bounded(deleteTemporaryBranches(Number(row.id), row.plan, deps), waitMs)
  await bounded(noteDockerState(row, error, deps), waitMs) // phase 4
  return true
}

/**
 * phase 4: an interrupted row with a docker step says where swarm stands, read through the Hub
 * agent (never driverCtx, never a write: nothing on the Docker host is deleted or re-applied).
 * Best-effort; the row is already interrupted.
 */
async function noteDockerState(
  row: { id: number; plan: string | null },
  error: string,
  deps: HealDeps
): Promise<void> {
  const note = await dockerHealNote(row.plan, deps.stackState)
  if (!note) return
  await db(DEPLOYS)
    .where({ id: row.id, status: 'interrupted', error })
    .update({ error: `${error}: ${note}`.slice(0, 1000) })
    .catch(() => undefined)
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
    .select('id', 'step', 'plan')) as Array<{
    id: number
    step: string | null
    plan: string | null
  }>
  if (!rows.length) return 0
  if (!ownLock && (await isLocked(envId)) !== false) return 0
  const heal = healDeps(deps)
  let n = 0
  for (const r of rows)
    if (await interruptRow(r, `The Hub stopped during ${r.step ?? 'the start'}`, heal)) n++
  return n
}
