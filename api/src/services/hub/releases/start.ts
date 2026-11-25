import { db } from '../../../db/index.js'
import { gatherPlanInput, PromotionError } from '../promote-gather.js'
import { buildPromotionPlan } from '../promote-plan.js'
import { startPromotion } from '../promote-run.js'
import type { PromotionPlan } from '../promote-types.js'

/**
 * A promotion (or rollback) the Hub starts on a person's earlier say-so: a release train step, a
 * scheduled promotion, an automatic rollback. The person confirmed the version and the
 * environment, not a plan: the plan is built now (every blocker judged again by startPromotion)
 * and started with its own hash. One retry when the plan moved between the two reads.
 * Each run is a normal promotion run (lock, job run, deploy row, verify, history).
 */

export interface PlannedStart {
  kind: 'promote' | 'rollback'
  version: string
  /** Who the run is recorded as started by (the train's / schedule's person; null = the Hub). */
  userId: string | null
}

export interface PlannedStartDeps {
  plan(envId: number, kind: 'promote' | 'rollback', version: string): Promise<PromotionPlan>
  start(
    envId: number,
    req: {
      kind: 'promote' | 'rollback'
      version: string
      confirm: string
      planHash: string
      user: { id: string } | null
    }
  ): Promise<{ deployId: number }>
  envKey(envId: number): Promise<string | null>
  /** Release notes for the new run (best effort, never awaited by the caller's outcome). */
  notes?(deployId: number): Promise<void>
}

export function defaultPlannedStartDeps(): PlannedStartDeps {
  return {
    plan: async (envId, kind, version) =>
      buildPromotionPlan(await gatherPlanInput(envId, { kind, version })),
    start: (envId, req) => startPromotion(envId, req),
    envKey: async (envId) => {
      const r = (await db('nivaro_hub_environments').where({ id: envId }).first('key')) as
        | { key: string }
        | undefined
      return r ? String(r.key) : null
    },
    notes: async (deployId) => {
      const { recordReleaseNotes } = await import('./notes.js')
      await recordReleaseNotes(deployId)
    }
  }
}

/** Starts the run; throws PromotionError (the plan's first blocker, a lock, a freeze…). */
export async function startPlannedPromotion(
  envId: number,
  o: PlannedStart,
  deps: PlannedStartDeps = defaultPlannedStartDeps()
): Promise<{ deployId: number }> {
  const key = await deps.envKey(envId)
  if (!key) throw new PromotionError('NOT_FOUND', 'No such environment', 404)
  for (let attempt = 1; ; attempt++) {
    const plan = await deps.plan(envId, o.kind, o.version)
    if (!plan.ok)
      throw new PromotionError(plan.blockers[0].code, plan.blockers[0].text, 409, plan.blockers)
    try {
      const out = await deps.start(envId, {
        kind: o.kind,
        version: o.version,
        confirm: key,
        planHash: plan.plan_hash,
        user: o.userId ? { id: o.userId } : null
      })
      if (deps.notes) void deps.notes(out.deployId).catch(() => undefined)
      return out
    } catch (err) {
      if (attempt < 2 && err instanceof PromotionError && err.code === 'PLAN_CHANGED') continue
      throw err
    }
  }
}

/** Refusals that pass on their own: the next tick tries again. */
const TRANSIENT_CODES: readonly string[] = [
  'PROMOTION_RUNNING',
  'CREATION_RUNNING',
  'STACK_BUSY',
  'LOCK_UNAVAILABLE',
  'PLAN_CHANGED',
  'GITLAB_UNREACHABLE',
  'AGENT_UNREACHABLE',
  'MOVE_OPEN',
  'FREEZE_UNKNOWN'
]

export function isTransientCode(code: string): boolean {
  return TRANSIENT_CODES.includes(code)
}

export function refusalCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : 'FAILED'
}

export function refusalText(err: unknown): string {
  const m = (err as { message?: unknown } | null)?.message
  return typeof m === 'string' && m ? m.slice(0, 500) : 'The promotion could not start'
}
