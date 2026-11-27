// Task 33 (Wave 2 hooks): an Entra client secret's rotation finished by the stack apply.
//
// Rotating an `entra.client_secret` makes a SECOND secret next to the current one (Task 14); the
// Hub seals the new value and its bindings push it to the stack, which needs an Apply now (or a
// promotion) to use it. Once that run has SUCCEEDED (its verify proved the app answers on the new
// value), the older secrets are dead weight that still opens the app: this hook fires the one-shot
// `remove_older` for each such secret — carried by the run (origin `promotion`, update only), so
// the engine re-checks the run, the app, the environment and the person's rights.
//
// It fires only when every place the secret goes holds the CURRENT value (the binding's last
// fingerprint equals the stored output's, no push error) and has applied it: a stack binding of
// this environment pushed before this run started; a stack binding of another environment pushed
// before a successful run there started; an app setting (live at once) pushed. Otherwise an older
// secret may still be in use and nothing is removed. A secret with no older ones is left alone.
//
// `remove_older` is `destructive` (its plan asks a typed confirmation); the conditions above stand
// for it — the run sends the confirmation the plan names (`confirmed: true`), the same way a
// retirement's typed app key stands for its deletes. Never fails the run: a refusal is a warning on
// the run's log.

import { db } from '../../../../db/index.js'
import { listBindings, outputMeta } from '../engine/bindings.js'
import type { PlanRequest } from '../engine/contract.js'
import { type HubResourceRow, listResources } from '../store.js'
import {
  type CarriedOutcome,
  type CarriedRun,
  hubActorForUser,
  runCarriedChange
} from './carried.js'

export const ENTRA_SECRET = 'entra.client_secret'
const OUTPUT = 'client_secret'

export interface CleanupInput {
  deployId: number
  envId: number
  signal?: AbortSignal
  log: (line: string, level?: 'info' | 'warn' | 'error') => void
}

export interface CleanupDeps {
  run?: (o: CarriedRun) => Promise<CarriedOutcome>
  deadlineMs?: number
}

const at = (v: unknown): number => {
  if (v == null || v === '') return Number.NaN
  if (v instanceof Date) return v.getTime()
  return typeof v === 'number' || /^\d{12,}$/.test(String(v)) ? Number(v) : Date.parse(String(v))
}

/**
 * Whether every binding of the secret holds the current value and has been applied, judged for a
 * successful run of `envId` that started at `runStartedAt`. Null = yes; else why not.
 */
export async function notAppliedEverywhere(
  row: HubResourceRow,
  envId: number,
  runStartedAt: number
): Promise<string | null> {
  const fp = (await outputMeta(row.id)).find((m) => m.key === OUTPUT)?.fingerprint ?? null
  if (!fp) return 'the Hub holds no current value'
  const bindings = (await listBindings(row.id)).filter((b) => b.output_key === OUTPUT)
  if (!bindings.some((b) => b.environment_id === envId && b.target === 'stack_secret'))
    return 'it is not bound to this environment’s stack'
  for (const b of bindings) {
    if (b.last_error || b.last_fingerprint !== fp || !b.last_pushed_at)
      return `${b.target_key} does not hold the current value yet`
    const pushed = at(b.last_pushed_at)
    if (b.target === 'app_setting') continue
    if (b.environment_id === envId) {
      if (!(pushed <= runStartedAt)) return `${b.target_key} was written after this run started`
      continue
    }
    const later = (await db('nivaro_hub_deploys')
      .where({ environment_id: b.environment_id, status: 'success' })
      .orderBy('id', 'desc')
      .first('started_at')) as { started_at: unknown } | undefined
    if (!later || !(pushed <= at(later.started_at)))
      return 'another environment has not applied the new value yet'
  }
  return null
}

/** Fires `remove_older` on the environment's rotated Entra secrets once applied. Never throws. */
export async function removeOlderSecretsAfterRun(
  o: CleanupInput,
  deps: CleanupDeps = {}
): Promise<{ applied: number[]; skipped: Array<{ resourceId: number; why: string }> }> {
  const applied: number[] = []
  const skipped: Array<{ resourceId: number; why: string }> = []
  try {
    const run = (await db('nivaro_hub_deploys')
      .where({ id: o.deployId })
      .first('app_id', 'environment_id', 'started_by', 'status', 'started_at')) as
      | Record<string, unknown>
      | undefined
    if (!run || String(run.status) !== 'running' || Number(run.environment_id) !== o.envId)
      return { applied, skipped }
    const appId = Number(run.app_id)
    // Secrets of this app that feed this environment (its own, or app-level ones bound here).
    const rows = (
      await listResources({ appId, type: ENTRA_SECRET }).catch(() => [] as HubResourceRow[])
    ).filter(
      (r) =>
        r.scope === 'app' &&
        !!r.external_id &&
        (r.environment_id == null || r.environment_id === o.envId) &&
        Array.isArray(r.observed?.fields?.older_secrets) &&
        (r.observed?.fields?.older_secrets as unknown[]).length > 0
    )
    if (!rows.length) return { applied, skipped }
    const startedAt = at(run.started_at)
    const ready: HubResourceRow[] = []
    for (const r of rows) {
      const why = Number.isFinite(startedAt)
        ? await notAppliedEverywhere(r, o.envId, startedAt)
        : 'the run has no start time'
      if (why) skipped.push({ resourceId: r.id, why })
      else ready.push(r)
    }
    if (!ready.length) return { applied, skipped }
    const actor = await hubActorForUser(run.started_by == null ? null : String(run.started_by))
    if (!actor) {
      o.log('Older Entra secrets kept: the person who started this run can no longer act', 'warn')
      for (const r of ready) skipped.push({ resourceId: r.id, why: 'no person to act for' })
      return { applied, skipped }
    }
    const carried = deps.run ?? runCarriedChange
    // One change per resource: each confirms its own removal.
    for (const r of ready) {
      const req: PlanRequest = {
        connectionId: r.connection_id,
        scope: 'app',
        appId,
        ...(r.environment_id != null ? { environmentId: r.environment_id } : {}),
        ops: [{ action: 'update', resourceId: r.id, fields: { remove_older: true } }]
      }
      const out = await carried({
        req,
        actor,
        origin: { kind: 'promotion', deployId: o.deployId },
        confirmed: true,
        ...(o.signal ? { signal: o.signal } : {}),
        deadlineMs: deps.deadlineMs ?? 120_000,
        pollMs: 2_000
      }).catch(
        (e): CarriedOutcome => ({
          status: 'failed',
          changeId: 0,
          code: 'ERROR',
          message: e instanceof Error ? e.message.slice(0, 300) : 'error'
        })
      )
      if (out.status === 'applied') {
        applied.push(out.changeId)
        o.log(`Older secrets of ${r.name ?? `resource #${r.id}`} removed (change #${out.changeId})`)
      } else {
        const why =
          out.status === 'pending_approval'
            ? 'it waits for a Hub administrator to approve it'
            : `${out.code}: ${out.message}`
        skipped.push({ resourceId: r.id, why })
        o.log(`Older secrets of ${r.name ?? `resource #${r.id}`} kept (${why})`, 'warn')
      }
    }
  } catch (e) {
    o.log(
      `Older Entra secrets kept: ${e instanceof Error ? e.message.slice(0, 300) : 'error'}`,
      'warn'
    )
  }
  return { applied, skipped }
}
