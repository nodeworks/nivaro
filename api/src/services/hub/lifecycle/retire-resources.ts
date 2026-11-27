// Task 11a (Hub providers): a retirement deletes every provider resource the Hub manages for the
// app — in the `remove` step, after the app is stopped — through the change engine, each with its
// own way back (an RDS final snapshot, a GitHub repository archived rather than deleted, the
// before-state the engine keeps for Vercel / Auth0 / Expo).
//
// Order (reverse dependency): one change per (connection, environment) group, the environments'
// groups first in the plan's order, then environments archived before the retirement, then the
// app-level group (a GitHub repository, a Vercel project the environments' parts point at) last.
// Inside one change the engine deletes children before parents. A group is planned only once the
// groups before it applied, so nothing still points at what it deletes.
//
// Each change is CARRIED by the retirement (origin `retirement`): the engine re-checks that this
// retirement is running its `remove` step for this app and that every operation is a delete, and
// only then lets it through the retirement's own freeze and an archived environment (ENV_ARCHIVED).
// The typed app key the person signed `remove` off with is the confirmation for these deletes.
// Shared resources (networks, hosted zones) are never touched.
import { db } from '../../../db/index.js'
import type { PlanRequest } from '../providers/engine/contract.js'
import { hubActorForUser, runCarriedChange } from '../providers/hooks/carried.js'
import { type HubResourceRow, listResources, RESOURCES } from '../providers/store.js'
import { RetireError } from './retire-plan.js'
import type { RetirePlan } from './retire-store.js'

export interface RetireResourceLine {
  id: number
  type: string
  provider: string
  name: string | null
  environment_id: number | null
  connection_id: number
}

/** The app's live managed resources (none when the provider tables are not there). */
export async function appResources(appId: number): Promise<HubResourceRow[]> {
  try {
    if (!(await db.schema.hasTable(RESOURCES))) return []
    return (await listResources({ appId, scope: 'app' })).filter((r) => !r.deleted_at)
  } catch {
    return []
  }
}

export function resourceLines(rows: HubResourceRow[]): RetireResourceLine[] {
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    provider: r.provider,
    name: r.name,
    environment_id: r.environment_id,
    connection_id: r.connection_id
  }))
}

export interface ResourceGroup {
  key: string
  connectionId: number
  environmentId: number | null
  ids: number[]
}

/** The delete groups, in the order they run (reverse dependency). */
export function deleteGroups(rows: HubResourceRow[], plan: RetirePlan): ResourceGroup[] {
  const envOrder = new Map(plan.environments.map((e, i) => [e.id, i]))
  const groups = new Map<string, ResourceGroup>()
  for (const r of rows) {
    const key = `${r.connection_id}:${r.environment_id ?? 'app'}`
    const g = groups.get(key) ?? {
      key,
      connectionId: r.connection_id,
      environmentId: r.environment_id,
      ids: []
    }
    g.ids.push(r.id)
    groups.set(key, g)
  }
  const rank = (g: ResourceGroup) =>
    g.environmentId == null
      ? Number.MAX_SAFE_INTEGER
      : (envOrder.get(g.environmentId) ?? Number.MAX_SAFE_INTEGER - 1)
  return [...groups.values()].sort(
    (a, b) => rank(a) - rank(b) || a.connectionId - b.connectionId || a.key.localeCompare(b.key)
  )
}

type Detail = Record<string, { change_id?: number; status?: string; count?: number }>

/**
 * Deletes the app's managed resources, group by group. `detail` (the step's own record) says what
 * is done; `save` writes it. Answers how many resources were deleted. Throws RetireError when a
 * group cannot be deleted (the step fails; Retry picks up where it stopped).
 */
export async function deleteAppResources(o: {
  retirementId: number
  plan: RetirePlan
  by: string | null
  detail: Detail
  save: (detail: Detail) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}): Promise<number> {
  const rows = await appResources(o.plan.app.id)
  const detail: Detail = { ...o.detail }
  let deleted = Object.values(detail)
    .filter((d) => d.status === 'applied')
    .reduce((n, d) => n + Number(d.count ?? 0), 0)
  if (!rows.length) return deleted
  const actor = await hubActorForUser(o.by)
  if (!actor?.isAdmin)
    throw new RetireError(
      'ADMIN_REQUIRED',
      'Deleting the app’s provider resources needs an active Hub administrator: sign off again.'
    )
  for (const g of deleteGroups(rows, o.plan)) {
    const req: PlanRequest = {
      connectionId: g.connectionId,
      scope: 'app',
      appId: o.plan.app.id,
      ...(g.environmentId != null ? { environmentId: g.environmentId } : {}),
      ops: g.ids.map((id) => ({ action: 'delete' as const, resourceId: id }))
    }
    const before = detail[g.key]
    const out = await runCarriedChange({
      req,
      actor,
      origin: { kind: 'retirement', retirementId: o.retirementId },
      changeId: before?.change_id ?? null,
      confirmed: true,
      onPlanned: async (changeId) => {
        detail[g.key] = { change_id: changeId, status: 'planned', count: g.ids.length }
        await o.save(detail)
      },
      ...(o.sleep ? { sleep: o.sleep } : {})
    })
    detail[g.key] = {
      change_id: out.changeId || before?.change_id,
      status: out.status,
      count: g.ids.length
    }
    await o.save(detail)
    if (out.status !== 'applied') {
      const why = 'message' in out ? out.message : 'it waits for an approval'
      throw new RetireError(
        out.status === 'blocked' ? out.code : 'RESOURCE_DELETE_FAILED',
        `Provider resources (${g.ids.length}) were not deleted: ${why} Nothing after them was removed; fix it, then Retry.`
      )
    }
    deleted += g.ids.length
  }
  return deleted
}
