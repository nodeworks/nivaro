import { db } from '../../db/index.js'
import { envPolicy } from './owner-access.js'
import type { CarriedOutcome } from './providers/hooks/carried.js'
import type { HubResourceRow } from './providers/store.js'

/**
 * Task 43: a production promotion marks the app's matching Jira version released. After the
 * promotion's deploys and checks passed, and while its deploy row still runs (the engine judges
 * the origin against it), every managed `jira.version` of the app (app-level, or of this
 * environment) whose name is the promoted version (`0.3.217`, `v0.3.217`; any case) and that Jira
 * does not show as released yet gets one change: `{release: true}` (the type's trigger field →
 * the adapter's `release` op), carried by the promotion (origin `promotion`: update only).
 *
 * Never part of the promotion's outcome: a Jira refusal, timeout or approval wait is a warning
 * line in the run's log, never a failed promotion. Promote only (a rollback releases nothing),
 * production environments only (the owner-access rule), never on an "Apply now" plan.
 */

export const JIRA_VERSION = 'jira.version'
const WAIT_MS = 120_000

/** The version names a promotion of `version` releases (pure). */
export function releasedNames(version: string): string[] {
  const v = String(version ?? '')
    .trim()
    .replace(/^v/i, '')
    .toLowerCase()
  return v ? [v, `v${v}`] : []
}

/** Whether a managed jira.version row is one this promotion releases (pure). */
export function versionMatches(
  row: Pick<
    HubResourceRow,
    'type' | 'deleted_at' | 'external_id' | 'desired' | 'observed' | 'name' | 'environment_id'
  >,
  version: string,
  envId: number
): boolean {
  if (row.type !== JIRA_VERSION || row.deleted_at || !row.external_id) return false
  if (row.environment_id != null && row.environment_id !== envId) return false
  if (row.observed?.fields?.released === true) return false
  const name = String(row.observed?.fields?.name ?? row.desired?.name ?? row.name ?? '')
    .trim()
    .toLowerCase()
  return !!name && releasedNames(version).includes(name)
}

export interface JiraReleaseDeps {
  listResources?: (f: { type: string; appId: number }) => Promise<HubResourceRow[]>
  production?: (envId: number) => Promise<boolean>
  run?: (
    o: Parameters<typeof import('./providers/hooks/carried.js').runCarriedChange>[0]
  ) => Promise<CarriedOutcome>
  actorFor?: typeof import('./providers/hooks/carried.js').hubActorForUser
}

export async function releaseJiraOnPromote(
  ctx: { deployId: number; version: string; kind: string; envId?: number },
  o: { signal: AbortSignal; log: (line: string, level?: 'info' | 'warn' | 'error') => unknown },
  deps: JiraReleaseDeps = {}
): Promise<{ released: number; failed: number }> {
  const out = { released: 0, failed: 0 }
  if (ctx.kind !== 'promote') return out
  // Finding what to release is silent when it fails (no Jira version = nothing to say); only a
  // release that was tried is reported in the run's log.
  let found: {
    rows: HubResourceRow[]
    appId: number
    startedBy: string | null
  } | null = null
  try {
    const row = (await db('nivaro_hub_deploys')
      .where({ id: ctx.deployId })
      .first('app_id', 'environment_id', 'started_by')) as
      | { app_id: number; environment_id: number; started_by: string | null }
      | undefined
    if (!row) return out
    const envId = Number(ctx.envId ?? row.environment_id)
    const isProd =
      deps.production ?? (async (id: number) => (await envPolicy(id))?.production === true)
    if (!(await isProd(envId))) return out
    const list =
      deps.listResources ??
      (async (f: { type: string; appId: number }) =>
        (await import('./providers/store.js')).listResources(f))
    const rows = (await list({ type: JIRA_VERSION, appId: Number(row.app_id) })).filter((r) =>
      versionMatches(r, ctx.version, envId)
    )
    if (rows.length) found = { rows, appId: Number(row.app_id), startedBy: row.started_by }
  } catch {
    return out
  }
  if (!found) return out
  const { rows } = found
  try {
    const carried = await import('./providers/hooks/carried.js')
    const actor = await (deps.actorFor ?? carried.hubActorForUser)(found.startedBy)
    if (!actor) {
      await o.log(
        'Jira: the person who started this promotion can no longer act, so no Jira version was marked released',
        'warn'
      )
      return out
    }
    const run = deps.run ?? carried.runCarriedChange
    for (const r of rows) {
      if (o.signal.aborted) break
      const label = String(r.observed?.fields?.name ?? r.name ?? `version #${r.id}`)
      const res = await run({
        req: {
          connectionId: r.connection_id,
          scope: 'app',
          appId: found.appId,
          ...(r.environment_id != null ? { environmentId: r.environment_id } : {}),
          ops: [{ action: 'update', resourceId: r.id, fields: { release: true } }]
        },
        actor,
        origin: { kind: 'promotion', deployId: ctx.deployId },
        signal: o.signal,
        deadlineMs: WAIT_MS
      }).catch(
        (e): CarriedOutcome => ({
          status: 'failed',
          changeId: 0,
          code: 'JIRA_RELEASE_FAILED',
          message: e instanceof Error ? e.message : String(e)
        })
      )
      if (res.status === 'applied') {
        out.released += 1
        await o.log(`Jira: version ${label} marked released (change #${res.changeId})`)
      } else {
        out.failed += 1
        const why = res.status === 'pending_approval' ? 'it waits for an approval' : res.message
        await o.log(
          `Jira: version ${label} was not marked released${res.changeId ? ` (change #${res.changeId})` : ''} — ${why}`,
          'warn'
        )
      }
    }
  } catch (e) {
    out.failed += 1
    await o.log(
      `Jira: could not mark the release (${e instanceof Error ? e.message : String(e)})`,
      'warn'
    )
  }
  return out
}
