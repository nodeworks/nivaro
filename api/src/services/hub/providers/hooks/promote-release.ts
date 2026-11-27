// Task 33 (Wave 2 hooks): every promotion records a release + deploy on the app's Sentry projects.
//
// After a promotion's steps succeeded — while its deploy row is still `running`, so the engine
// accepts the change as carried by it (origin `promotion`: update ops only, on this app's managed
// resources, the promoted environment's or app-level ones) — each live managed `sentry.project` of
// the app (app-level, or this environment's) gets one update with the trigger `record_release`
// and the release fields (`release_version`, `release_environment` = the Hub environment key,
// `release_url` = the environment's https address). The Sentry adapter reads before it writes
// (an existing release / deploy is not made twice), so a retry is harmless.
//
// It never fails the promotion: a refusal, an approval wait or a provider error is logged as a
// warning on the promotion's job run and the run goes on to close. One change per (connection,
// environment) group; each waits at most two minutes. A stack apply (`plan.apply`) records
// nothing — the version did not change.

import { db } from '../../../../db/index.js'
import type { PlanRequest } from '../engine/contract.js'
import { type HubResourceRow, listResources } from '../store.js'
import {
  type CarriedOutcome,
  type CarriedRun,
  hubActorForUser,
  runCarriedChange
} from './carried.js'

export const SENTRY_PROJECT = 'sentry.project'

export interface ReleaseHookInput {
  deployId: number
  envId: number
  envKey: string
  version: string
  signal?: AbortSignal
  log: (line: string, level?: 'info' | 'warn' | 'error') => void
}

export interface ReleaseHookDeps {
  /** Tests: the carried run (default runCarriedChange). */
  run?: (o: CarriedRun) => Promise<CarriedOutcome>
  deadlineMs?: number
}

/** The release fields one Sentry project gets for this promotion (pure). */
export function releaseFields(
  version: string,
  envKey: string,
  baseUrl: string | null
): Record<string, unknown> {
  const url = baseUrl && /^https:\/\//i.test(baseUrl) ? baseUrl.replace(/\/+$/, '') : null
  return {
    record_release: true,
    release_version: version,
    release_environment: envKey,
    ...(url ? { release_url: url } : {})
  }
}

/** The managed Sentry projects a promotion of this environment records a release on. */
export function releaseTargets(rows: HubResourceRow[], envId: number): HubResourceRow[] {
  return rows.filter(
    (r) =>
      r.type === SENTRY_PROJECT &&
      !r.deleted_at &&
      !!r.external_id &&
      r.scope === 'app' &&
      (r.environment_id == null || r.environment_id === envId)
  )
}

/** Records the promotion's release on the app's Sentry projects. Never throws. */
export async function recordPromotionReleases(
  o: ReleaseHookInput,
  deps: ReleaseHookDeps = {}
): Promise<{ applied: number[]; skipped: string[] }> {
  const applied: number[] = []
  const skipped: string[] = []
  try {
    const row = (await db('nivaro_hub_deploys')
      .where({ id: o.deployId })
      .first('app_id', 'environment_id', 'started_by', 'status')) as
      | { app_id: number; environment_id: number; started_by: string | null; status: string }
      | undefined
    if (!row || String(row.status) !== 'running' || Number(row.environment_id) !== o.envId)
      return { applied, skipped }
    const appId = Number(row.app_id)
    // A Hub without the provider tables (older schema, tests of other flows) has nothing to do.
    const rows = await listResources({ appId, type: SENTRY_PROJECT }).catch(
      () => [] as HubResourceRow[]
    )
    const targets = releaseTargets(rows, o.envId)
    if (!targets.length) return { applied, skipped }
    const actor = await hubActorForUser(row.started_by)
    if (!actor) {
      o.log(
        'Sentry release not recorded: the person who started this promotion can no longer act',
        'warn'
      )
      return { applied, skipped: targets.map((t) => `#${t.id}`) }
    }
    const env = (await db('nivaro_hub_environments').where({ id: o.envId }).first('base_url')) as
      | { base_url: string | null }
      | undefined
    const fields = releaseFields(o.version, o.envKey, env?.base_url ?? null)
    const groups = new Map<string, HubResourceRow[]>()
    for (const t of targets) {
      const k = `${t.connection_id}:${t.environment_id ?? ''}`
      groups.set(k, [...(groups.get(k) ?? []), t])
    }
    const run = deps.run ?? runCarriedChange
    for (const list of groups.values()) {
      const first = list[0]
      const req: PlanRequest = {
        connectionId: first.connection_id,
        scope: 'app',
        appId,
        ...(first.environment_id != null ? { environmentId: first.environment_id } : {}),
        ops: list.map((t) => ({
          action: 'update' as const,
          resourceId: t.id,
          fields: { ...fields }
        }))
      }
      try {
        const out = await run({
          req,
          actor,
          origin: { kind: 'promotion', deployId: o.deployId },
          ...(o.signal ? { signal: o.signal } : {}),
          deadlineMs: deps.deadlineMs ?? 120_000,
          pollMs: 2_000
        })
        if (out.status === 'applied') {
          applied.push(out.changeId)
          o.log(`Sentry release ${o.version} recorded for ${o.envKey} (change #${out.changeId})`)
        } else {
          const why =
            out.status === 'pending_approval'
              ? 'it waits for a Hub administrator to approve it'
              : `${out.code}: ${out.message}`
          skipped.push(list.map((t) => `#${t.id}`).join(', '))
          o.log(`Sentry release not recorded (${why})`, 'warn')
        }
      } catch (e) {
        skipped.push(list.map((t) => `#${t.id}`).join(', '))
        o.log(
          `Sentry release not recorded: ${e instanceof Error ? e.message.slice(0, 300) : 'error'}`,
          'warn'
        )
      }
    }
  } catch (e) {
    o.log(
      `Sentry release not recorded: ${e instanceof Error ? e.message.slice(0, 300) : 'error'}`,
      'warn'
    )
  }
  return { applied, skipped }
}
