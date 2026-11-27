// Gap G-A (Hub providers): Hub creation targets that name a provider connection, and what follows
// a `gitlab` connection when it changes.
//
// A GitLab target that uses a connection keeps no token and no address (targets.ts resolves both
// from the connection on every read). The apps created on it still each have a driver that holds
// its own sealed copy of the token and its own GitLab address (the driver is what promotions
// call). When the connection's token or address changes, those copies follow it through the SAME
// path a target token rotation uses: syncTargetApps(target, {previousSecret, previousApi}) per
// target — compare-and-set on each driver that still holds the previous token at the previous
// address, then the target's CI path and project variables pushed again.
//
// Which drivers come from a connection is decided in ONE place: `targetsOfConnection` names the
// targets, and a driver follows exactly when its app was created on one of them (the app's
// recorded `made.driver_id`, read by syncTargetApps). Nothing here widens an app's allowed
// connections: a target's connection is the Hub's, never the app's.
import { db } from '../../../db/index.js'
import { sealSecret } from '../secrets.js'
import type { TargetSyncResult } from './steps.js'
import { connectionApi, connectionGroup, outsideConnectionGroup, toTargetRow } from './targets.js'

const TARGETS = 'nivaro_hub_targets'

export interface ConnectionTarget {
  id: number
  kind: string
  name: string
  config: Record<string, unknown>
}

/**
 * Every Hub target (GitLab or GitHub) that names the connection. A database before migration
 * 583 has no `connection_id` column: no target can name one there.
 */
export async function targetsOfConnection(connectionId: number): Promise<ConnectionTarget[]> {
  if (!(await db.schema.hasColumn(TARGETS, 'connection_id'))) return []
  const rows = (await db(TARGETS)
    .where({ connection_id: connectionId })
    .orderBy('id')
    .select('id', 'kind', 'name', 'config')) as Array<Record<string, unknown>>
  return rows.map((r) => {
    const t = toTargetRow({ ...r, connection_id: connectionId, secret: null })
    return {
      id: t.id,
      kind: String(r.kind),
      name: t.name,
      config: t.config as unknown as Record<string, unknown>
    }
  })
}

/** What a `gitlab` connection gives its targets: the address and the token (plain, in memory). */
export interface GitlabConnectionState {
  api: string | null
  token: string | null
}

export async function gitlabConnectionState(row: {
  id: number
  config: Record<string, unknown>
}): Promise<GitlabConnectionState> {
  const { openConnectionSecrets } = await import('../providers/store.js')
  const secrets = await openConnectionSecrets({ id: row.id })
  return { api: connectionApi(row.config), token: secrets.token || null }
}

/**
 * Why a change to a `gitlab` connection's settings cannot be made while targets use it, or
 * null: every GitLab target that names it must keep a usable address and keep its namespace and
 * template inside the group the connection is pinned to.
 */
export async function connectionChangeRefusal(
  connectionId: number,
  nextConfig: Record<string, unknown>
): Promise<{ message: string; targets: number } | null> {
  const users = (await targetsOfConnection(connectionId)).filter((t) => t.kind === 'gitlab')
  if (!users.length) return null
  if (!connectionApi(nextConfig))
    return {
      message: `${users.length} target(s) use this connection: it needs a usable https GitLab address.`,
      targets: users.length
    }
  const group = connectionGroup(nextConfig)
  for (const t of users) {
    const outside = outsideConnectionGroup(
      {
        namespace: String(t.config.namespace ?? ''),
        template_project: String(t.config.template_project ?? '')
      },
      group
    )
    if (outside)
      return {
        message: `The target ${t.name} uses this connection. ${outside} Change the target first.`,
        targets: users.length
      }
  }
  return null
}

export interface ConnectionTargetSync {
  target_id: number
  sync: TargetSyncResult[] | null
  sync_error?: string
}

/**
 * After a `gitlab` connection was saved: when its token or address changed, every GitLab target
 * that uses it re-syncs its apps exactly as a target token rotation does (driver copies follow,
 * CI settings pushed again). Answers per target, or null when nothing a target uses changed.
 * One target's failure to even start is its own `sync_error`; never throws.
 */
export async function followConnection(
  connectionId: number,
  before: GitlabConnectionState,
  after: GitlabConnectionState,
  opts: { sync?: typeof import('./steps.js').syncTargetApps } = {}
): Promise<ConnectionTargetSync[] | null> {
  const tokenChanged = !!before.token && before.token !== after.token
  const moved = !!before.api && before.api !== after.api
  if (!tokenChanged && !moved) return null
  const users = (await targetsOfConnection(connectionId)).filter((t) => t.kind === 'gitlab')
  if (!users.length) return null
  const sync = opts.sync ?? (await import('./steps.js')).syncTargetApps
  // The previous token, sealed again only so the shared compare-and-set can open it.
  const previousSecret = before.token ? sealSecret(before.token) : null
  const out: ConnectionTargetSync[] = []
  for (const t of users) {
    try {
      out.push({
        target_id: t.id,
        sync: await sync(t.id, { previousSecret, previousApi: before.api })
      })
    } catch {
      out.push({ target_id: t.id, sync: null, sync_error: 'SYNC_READ_FAILED' })
    }
  }
  return out
}
