import { db } from '../../../db/index.js'
import { databaseRecordId } from '../docker/stack-env.js'
import { compareVersions } from '../promote-plan.js'
import { sharedStackSettings } from './stack-render.js'
import type { SharedDeployment } from './store.js'

/**
 * SQLite apps on a Hub shared deployment (hub gap `sqlite`, 0.3.215). A SQLite app's database is
 * a file the deployment keeps in its uploads volume (db/sqlite-tenant.ts), and SQLite allows one
 * writer process — so a SQLite app is served only by a deployment the Hub runs as ONE process:
 *
 *  - Docker mode (a registered deployment runs however many processes its operator starts: the
 *    Hub cannot tell, so it never places a SQLite app there),
 *  - size small (one `all` service, one replica: stack-render.ts sharedRoles), and
 *  - a version that serves SQLite apps (SQLITE_SHARED_SINCE; an older one drops them from its
 *    list).
 *
 * Checked when a SQLite app is placed (place.ts, again under the deployment's lock), when the
 * deployment's size changes (routes/hub-shared.ts PATCH, under the same lock) and when it is
 * upgraded or rolled back (upgrade-plan.ts). Every refusal is SQLITE_ONE_PROCESS (the code a
 * dedicated stack's settings already use for SQLite on more than one process) or
 * SQLITE_SHARED_VERSION, with a plain sentence.
 */

/** The first version whose shared deployments serve SQLite apps. */
export const SQLITE_SHARED_SINCE = '0.3.215'

/** `version` is SQLITE_SHARED_SINCE or later (a pre-release of it, or no version, is not). */
export function servesSqliteApps(version: string | null | undefined): boolean {
  const m = /^v?(\d+\.\d+\.\d+)(.*)$/.exec((version ?? '').trim())
  if (!m) return false
  const c = compareVersions(m[1], SQLITE_SHARED_SINCE)
  return c > 0 || (c === 0 && !m[2].startsWith('-'))
}

/** What a person placing a SQLite app can do instead (place.ts adds it to a refusal). */
export const SQLITE_PLACE_HINT =
  'Place this app on a Docker shared deployment of size small running 0.3.215 or later, or give it a database server.'

export interface SqliteRefusal {
  code: 'SQLITE_ONE_PROCESS' | 'SQLITE_SHARED_VERSION'
  message: string
}

/**
 * Why this deployment cannot serve a SQLite app as it is set now (mode, size and `version`,
 * default its pin), or null. `size` overrides the stored size (a PATCH being judged).
 */
export function sqliteSharedRefusal(
  shared: Pick<SharedDeployment, 'key' | 'mode' | 'settings' | 'version_pin'>,
  over: { size?: string; version?: string | null } = {}
): SqliteRefusal | null {
  if (shared.mode !== 'docker')
    return {
      code: 'SQLITE_ONE_PROCESS',
      message: `${shared.key} is a registered shared deployment: the Hub cannot tell how many processes run it, and a SQLite database allows one writer process.`
    }
  const size = over.size ?? sharedStackSettings(shared).size
  if (size !== 'small')
    return {
      code: 'SQLITE_ONE_PROCESS',
      message: `${shared.key} would run as several processes (size ${size}), and a SQLite database allows one writer process.`
    }
  const version = over.version === undefined ? shared.version_pin : over.version
  if (!servesSqliteApps(version))
    return {
      code: 'SQLITE_SHARED_VERSION',
      message: `${shared.key} would run ${version ?? 'no version yet'}; a shared deployment serves SQLite apps from ${SQLITE_SHARED_SINCE}.`
    }
  return null
}

/** What a Docker agent says about its uploads volume, for a SQLite app's file. */
export interface SqliteStorageFacts {
  /** The uploads volume is an NFS export; null/undefined = the agent does not say (older). */
  uploads_network?: boolean | null
  /** HUB_AGENT_VOLUME_DRIVER; null/undefined = not said. */
  volume_driver?: string | null
  /** Swarm nodes when local volumes sit on more than one node, else null. */
  multi_node?: number | null
  /** Review 4 L1: the agent answered without its swarm's node count (its /info call failed). */
  nodes_unknown?: boolean
}

/**
 * Is the agent's uploads volume on network storage? Its `uploads_network` (hub gap sqlite), else
 * its `volume_nfs` (0.2.3, NFS export), else null: an agent that says neither is unknown.
 */
export function uploadsOnNetwork(
  h: { uploads_network?: unknown; volume_nfs?: unknown } | null | undefined
): boolean | null {
  if (typeof h?.uploads_network === 'boolean') return h.uploads_network || h.volume_nfs === true
  if (typeof h?.volume_nfs === 'boolean') return h.volume_nfs
  return null
}

/**
 * Why a SQLite app's file cannot live on this agent's uploads volume, or null (M5, H2): never on
 * an NFS export or a non-local volume driver (SQLite's WAL and its file locks are not safe on a
 * network filesystem), never on a swarm of several nodes with local volumes (a task rescheduled
 * to another node finds no file), and never when the agent does not say (unknown is never a pass).
 */
export function sqliteStorageRefusal(
  key: string,
  f: SqliteStorageFacts | null
): { code: 'SQLITE_ON_NFS' | 'SQLITE_MULTI_NODE'; message: string } | null {
  if (!f || typeof f.uploads_network !== 'boolean')
    return {
      code: 'SQLITE_ON_NFS',
      message: `The Hub agent of ${key} does not say whether its uploads volume is on NFS (an older agent, or it did not answer), and SQLite is not safe on a network filesystem. Update the agent.`
    }
  if (f.uploads_network || (f.volume_driver && f.volume_driver !== 'local'))
    return {
      code: 'SQLITE_ON_NFS',
      message: `${key} keeps its uploads on network storage (${f.uploads_network ? 'NFS' : `volume driver ${f.volume_driver}`}); SQLite's write-ahead log and file locks are not safe there.`
    }
  if (f.nodes_unknown)
    return {
      code: 'SQLITE_MULTI_NODE',
      message: `The Hub agent of ${key} did not say how many nodes its swarm has, and a SQLite file must stay on one node. Check the agent (its Docker /info call), then try again.`
    }
  if (f.multi_node && f.multi_node > 1)
    return {
      code: 'SQLITE_MULTI_NODE',
      message: `${key} runs on a swarm of ${f.multi_node} nodes with local volumes: a task moved to another node would find no database file.`
    }
  return null
}

/** The database record ids an environment's db_ref names that are SQLite records. */
export async function sqliteRecordIds(recordIds: number[]): Promise<Set<number>> {
  if (!recordIds.length) return new Set()
  const rows = (await db('nivaro_hub_databases')
    .whereIn('id', recordIds)
    .where({ engine: 'sqlite' })
    .select('id')) as Array<{ id: number }>
  return new Set(rows.map((r) => Number(r.id)))
}

/** Is the environment's database a SQLite record? */
export async function environmentUsesSqlite(envId: number): Promise<boolean> {
  const env = (await db('nivaro_hub_environments').where({ id: envId }).first('db_ref')) as
    | { db_ref: string | null }
    | undefined
  const id = databaseRecordId(env?.db_ref)
  return id !== null && (await sqliteRecordIds([id])).has(id)
}

/**
 * The listed environments (tenantsOf rows) whose database is a SQLite record, as `app/env`.
 * `rows` carries each environment's id and keys.
 */
export async function sqliteAppsAmong(
  rows: Array<{ env: { id: number; key: string }; app: { key: string } }>
): Promise<string[]> {
  if (!rows.length) return []
  const refs = (await db('nivaro_hub_environments')
    .whereIn(
      'id',
      rows.map((r) => r.env.id)
    )
    .select('id', 'db_ref')) as Array<{ id: number; db_ref: string | null }>
  const recordOf = new Map(refs.map((r) => [Number(r.id), databaseRecordId(r.db_ref)]))
  const sqlite = await sqliteRecordIds(
    [...recordOf.values()].filter((id): id is number => id !== null)
  )
  return rows
    .filter((r) => {
      const id = recordOf.get(r.env.id)
      return id != null && sqlite.has(id)
    })
    .map((r) => `${r.app.key}/${r.env.key}`)
}
