import knexFactory, { type Knex } from 'knex'
import { db } from '../../../db/index.js'
import { rawRows } from '../../../db/raw-rows.js'
import { knexConfigFor } from '../db/connection.js'
import { openDatabaseConnection } from '../db/databases.js'
import { rememberSecrets, type Secrets, scrubText } from '../db/provision-common.js'
import { getServerRow, type HubDbServerRow, openAdminSecret } from '../db/servers.js'
import { HubSecretError } from '../secrets.js'
import { DataError } from './types.js'

/**
 * Hub data care: what an environment's database is and how the Hub reaches its server.
 *
 * A database copy is made by the database server itself, through the server's provisioning
 * login (nivaro_hub_db_servers.admin_secret): a backup or a restore can run for hours, so the
 * connection here has its own long request timeout (never the provisioner's two minutes) and
 * one connection only (statements that switch the session database stay on it). Every error
 * that leaves is scrubbed of the login and its password.
 */

const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
const DBS = 'nivaro_hub_databases'

/** Six hours: the longest single BACKUP / RESTORE statement the Hub waits for. */
export const LONG_STATEMENT_MS = 6 * 60 * 60_000

export type SqlExec = (sql: string, bindings?: unknown[]) => Promise<Record<string, unknown>[]>

export interface EnvSibling {
  id: number
  key: string
  position: number
}

export interface EnvData {
  env: {
    id: number
    app_id: number
    key: string
    position: number
    status: string
    base_url: string
    placement_id: number | null
  }
  app: { id: number; key: string; name: string }
  siblings: EnvSibling[]
  production: boolean
  database: {
    id: number
    engine: string
    host: string
    port: number | null
    database_name: string
    status: string
    server_id: number | null
  } | null
  server: HubDbServerRow | null
}

const PROD_KEY = /^(prod|production|prd|live)$/i

/**
 * Production, for the data features: its key says so (prod, production, prd, live), or it is the
 * app's last environment in promotion order (the highest position) — an app with one environment
 * has only production. A refresh never writes over it, whatever the request says.
 */
export function isProductionEnv(env: EnvSibling, siblings: EnvSibling[]): boolean {
  if (PROD_KEY.test(env.key)) return true
  const all = siblings.length ? siblings : [env]
  const top = Math.max(...all.map((s) => s.position))
  return env.position >= top
}

function dbIdOf(ref: unknown): number | null {
  const m = /^hub-db:(\d+)$/.exec(String(ref ?? ''))
  return m ? Number(m[1]) : null
}

export async function envData(envId: number): Promise<EnvData> {
  const e = (await db(ENVS).where({ id: envId }).first()) as Record<string, unknown> | undefined
  if (!e || e.status === 'archived') throw new DataError('NOT_FOUND', 'No such environment.', 404)
  const a = (await db(APPS).where({ id: e.app_id }).first('id', 'key', 'name')) as
    | Record<string, unknown>
    | undefined
  if (!a) throw new DataError('NOT_FOUND', 'No such environment.', 404)
  const sibs = (await db(ENVS)
    .where({ app_id: e.app_id })
    .whereNot({ status: 'archived' })
    .select('id', 'key', 'position')) as Record<string, unknown>[]
  const siblings = sibs.map((s) => ({
    id: Number(s.id),
    key: String(s.key),
    position: Number(s.position ?? 0)
  }))
  const env = {
    id: Number(e.id),
    app_id: Number(e.app_id),
    key: String(e.key),
    position: Number(e.position ?? 0),
    status: String(e.status ?? 'active'),
    base_url: String(e.base_url ?? ''),
    placement_id: e.placement_id == null ? null : Number(e.placement_id)
  }
  let database: EnvData['database'] = null
  let server: HubDbServerRow | null = null
  const dbId = dbIdOf(e.db_ref)
  if (dbId !== null) {
    const r = (await db(DBS).where({ id: dbId }).first()) as Record<string, unknown> | undefined
    if (r) {
      database = {
        id: Number(r.id),
        engine: String(r.engine),
        host: String(r.host),
        port: r.port == null ? null : Number(r.port),
        database_name: String(r.database_name),
        status: String(r.status),
        server_id: r.server_id == null ? null : Number(r.server_id)
      }
      if (database.server_id !== null) server = await getServerRow(database.server_id)
    }
  }
  return {
    env,
    app: { id: Number(a.id), key: String(a.key), name: String(a.name) },
    siblings,
    production: isProductionEnv(env, siblings),
    database,
    server
  }
}

export interface ServerAccess {
  server: HubDbServerRow
  admin: { user: string; password: string }
  database: string
  databaseId: number
}

/**
 * The server login the Hub may run native copies with, or the reason it may not: no Hub
 * database record, not ready, not SQL Server, or no stored login on its server.
 */
export function serverAccessOf(d: EnvData): ServerAccess {
  if (d.database && d.database.status === 'ready' && d.database.engine !== 'mssql')
    throw new DataError(
      'ENGINE_NOT_SUPPORTED',
      'The Hub copies databases with the server’s own BACKUP and RESTORE, which only SQL Server offers: on this engine backups stay with the DBA (see the checklist).'
    )
  return serverLoginOf(d)
}

/** The server's stored login for any engine (reads only), or the reason there is none. */
export function serverLoginOf(d: EnvData): ServerAccess {
  if (!d.database)
    throw new DataError(
      'NO_DATABASE',
      'This environment has no Hub database record: attach one on the Databases tab first.'
    )
  if (d.database.status !== 'ready')
    throw new DataError('DATABASE_NOT_READY', 'This environment’s database is not ready yet.')
  if (!d.server)
    throw new DataError(
      'NO_SERVER_LOGIN',
      'The database record names no database server, so the Hub has no login to copy it with.'
    )
  let admin: { user: string; password: string } | null
  try {
    admin = openAdminSecret(d.server)
  } catch (err) {
    if (err instanceof HubSecretError)
      throw new DataError('NO_SERVER_LOGIN', 'The server’s stored login cannot be opened.')
    throw err
  }
  if (!admin)
    throw new DataError(
      'NO_SERVER_LOGIN',
      d.server.provision_mode === 'manual'
        ? 'This is a manual server with no stored login: backups stay with the DBA (see the checklist), or store a login with backup rights.'
        : 'No login is stored for this database server.'
    )
  return {
    server: d.server,
    admin,
    database: d.database.database_name,
    databaseId: d.database.id
  }
}

/** One connection on the server's master database with a long request timeout. */
export function longServerConfig(
  a: Pick<ServerAccess, 'server' | 'admin'>,
  ms: number
): Knex.Config {
  const config = knexConfigFor({
    engine: a.server.engine,
    host: a.server.host,
    port: a.server.port,
    ssl_mode: a.server.ssl_mode,
    trust_server_cert: a.server.trust_server_cert,
    user: a.admin.user,
    password: a.admin.password,
    database: null
  })
  const conn = config.connection as { options?: Record<string, unknown> }
  if (conn?.options) conn.options = { ...conn.options, requestTimeout: ms }
  return config
}

export type ServerOpener = <T>(
  a: Pick<ServerAccess, 'server' | 'admin'>,
  fn: (exec: SqlExec) => Promise<T>
) => Promise<T>

/** Runs `fn` with an exec on the server (scrubbed errors, connection closed in finally). */
export const withServerExec: ServerOpener = async (a, fn) => {
  const secrets: Secrets = { passwords: [a.admin.password], logins: [a.admin.user] }
  let k: Knex | null = null
  try {
    k = knexFactory(longServerConfig(a, LONG_STATEMENT_MS))
    rememberSecrets(k, secrets)
    const kk = k
    const exec: SqlExec = async (sql, bindings = []) => {
      try {
        return rawRows<Record<string, unknown>>(await kk.raw(sql, bindings as Knex.RawBinding[]))
      } catch (err) {
        throw new Error(scrubText(err, secrets))
      }
    }
    return await fn(exec)
  } finally {
    if (k) await k.destroy().catch(() => undefined)
  }
}

/** The app's own login (its stored connection), for the login remap after a restore. */
export async function appLoginOf(databaseId: number): Promise<string> {
  return (await openDatabaseConnection(databaseId)).user
}

/** A plain, short sentence from an error (already scrubbed by withServerExec). */
export function errText(err: unknown): string {
  const inner = (err as { errors?: unknown })?.errors
  if (Array.isArray(inner) && inner.length)
    return inner
      .map((x) => String((x as { message?: unknown })?.message ?? x))
      .join(' | ')
      .slice(0, 400)
  return String((err as { message?: unknown })?.message ?? err).slice(0, 400)
}
