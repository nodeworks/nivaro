import { cleanTenantHost } from '../../db/tenant-context.js'
import type { TenantRecord } from './types.js'

/**
 * The Hub tenants contract (Hub phase 5). A Hub shared deployment asks its Hub which apps it
 * serves: `GET {HUB_URL}/api/hub/shared/{deployment}/tenants` with `Authorization: Bearer
 * <HUB_DEPLOYMENT_TOKEN>`. Phase 6 serves exactly this shape from nivaro_hub_shared_deployments.
 *
 * The body carries every app's database connection, so nothing here ever puts a connection
 * string into a `why`, a log line or an error.
 */
export const HUB_TENANTS_PATH = (deployment: string) =>
  `/api/hub/shared/${encodeURIComponent(deployment)}/tenants`

export interface HubTenantWire {
  /** [a-z0-9-]{1,64} */
  id: string
  app_key: string
  env_key: string
  name: string
  status: 'active' | 'maintenance' | 'suspended' | 'provisioning'
  hostnames: string[]
  db: { client: 'mssql' | 'pg' | 'mysql2' | 'mariadb'; connection: string }
  pool_max?: number
}

export interface HubTenantsResponse {
  data: { deployment: string; generated_at: string; tenants: HubTenantWire[] }
}

/** The `why` of every tenant dropped because the Hub answered for another deployment. */
export const WRONG_DEPLOYMENT = 'listed for another deployment'

const ID_RE = /^[a-z0-9-]{1,64}$/
const CLIENTS = new Set(['mssql', 'pg', 'mysql2', 'mariadb'])
const STATUSES = new Set(['active', 'maintenance', 'suspended', 'provisioning'])

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A printable id for a `why` / `dropped` entry: the wire id when it is one, else a placeholder. */
function shownId(raw: unknown, index: number): string {
  return typeof raw === 'string' && ID_RE.test(raw) ? raw : `#${index + 1}`
}

/**
 * A listed hostname as the deployment matches it: cleaned (cleanTenantHost: first entry, lower
 * case), port dropped. Requests and sockets both match on the bare host (socketTenantHost strips
 * the port), so a listed `a.example.com:443` and a request on `a.example.com:8443` meet there.
 */
export function hubHostname(raw: unknown): string | null {
  const clean = cleanTenantHost(typeof raw === 'string' ? raw : null)
  return clean ? clean.replace(/:\d+$/, '') : null
}

/** The non-default ports a wire tenant lists per bare hostname (origin only, never routing). */
function wirePorts(t: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isObj(t) || !Array.isArray(t.hostnames)) return out
  for (const raw of t.hostnames) {
    const clean = cleanTenantHost(typeof raw === 'string' ? raw : null)
    const m = clean?.match(/^(.*):(\d{1,5})$/)
    if (!m) continue
    const port = Number(m[2])
    if (port !== 443 && port !== 80 && port > 0 && port < 65536 && !(m[1] in out)) out[m[1]] = port
  }
  return out
}

/** Every hostname a wire tenant claims, normalised and de-duplicated (even an invalid tenant). */
function wireHosts(t: unknown): string[] {
  if (!isObj(t) || !Array.isArray(t.hostnames)) return []
  return [...new Set(t.hostnames.map(hubHostname).filter((h): h is string => !!h))]
}

/** The database connection a wire tenant claims, or null. */
function wireConnection(t: unknown): string | null {
  const db = isObj(t) && isObj(t.db) ? t.db : null
  return typeof db?.connection === 'string' && db.connection.trim() ? db.connection.trim() : null
}

/** One wire tenant as a TenantRecord, or why this deployment cannot serve it. */
function toRecord(t: unknown): TenantRecord | string {
  if (!isObj(t)) return 'not an object'
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) return 'invalid id'
  if (typeof t.app_key !== 'string' || !ID_RE.test(t.app_key)) return 'invalid app key'
  if (typeof t.name !== 'string') return 'no name'
  if (typeof t.status !== 'string' || !STATUSES.has(t.status)) return 'unknown status'
  const db = isObj(t.db) ? t.db : null
  const client = typeof db?.client === 'string' ? db.client : ''
  if (/sqlite/i.test(client)) return 'SQLite cannot be served on a shared deployment'
  if (!CLIENTS.has(client)) return 'unknown database client'
  const connection = wireConnection(t)
  if (!connection) return 'no connection'
  let poolMax: number | null = null
  if (t.pool_max !== undefined && t.pool_max !== null) {
    const n = t.pool_max
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 20)
      return 'pool_max outside 1-20'
    poolMax = n
  }
  const hosts = wireHosts(t)
  if (hosts.length === 0) return 'no hostnames'
  const ports = wirePorts(t)
  return {
    id: t.id,
    slug: t.app_key,
    name: t.name,
    status: t.status,
    dbClient: client,
    dbConnection: connection,
    poolMax,
    hostnames: hosts,
    ...(Object.keys(ports).length ? { originPorts: ports } : {})
  }
}

/**
 * The tenants a Hub body lists, as TenantRecords, plus every tenant this deployment cannot serve
 * (named with a reason). `null` = the body is not a tenant list at all (the caller keeps its
 * last good list).
 *
 * Claims are counted over EVERY listed tenant, including ones dropped for another reason: two
 * claims on one id, one hostname or one database drop every tenant making them, so a broken
 * entry can never hand its hostname or database to another app.
 */
export function parseHubTenants(
  body: unknown,
  deployment: string
): { tenants: TenantRecord[]; dropped: { id: string; why: string }[] } | null {
  if (!isObj(body) || !isObj(body.data)) return null
  const { data } = body
  if (typeof data.deployment !== 'string' || !Array.isArray(data.tenants)) return null
  const wire = data.tenants as unknown[]
  const ids = wire.map((t, i) => shownId(isObj(t) ? t.id : null, i))

  if (data.deployment !== deployment)
    return { tenants: [], dropped: ids.map((id) => ({ id, why: WRONG_DEPLOYMENT })) }

  const idClaims = new Map<string, number>()
  const hostClaims = new Map<string, string[]>()
  const dbClaims = new Map<string, string[]>()
  wire.forEach((t, i) => {
    idClaims.set(ids[i], (idClaims.get(ids[i]) ?? 0) + 1)
    for (const h of wireHosts(t)) hostClaims.set(h, [...(hostClaims.get(h) ?? []), ids[i]])
    const c = wireConnection(t)
    if (c) dbClaims.set(c, [...(dbClaims.get(c) ?? []), ids[i]])
  })
  const others = (claims: string[] | undefined, self: string) =>
    (claims ?? []).filter((o) => o !== self).join(', ') || self

  /** The record, or why this tenant is dropped (its own fault, or a shared claim). */
  const dropReason = (t: unknown, id: string): TenantRecord | string => {
    const r = toRecord(t)
    if (typeof r === 'string') return r
    if ((idClaims.get(id) ?? 0) > 1) return 'duplicate id'
    const clash = r.hostnames.find((h) => (hostClaims.get(h) ?? []).length > 1)
    if (clash) return `hostname ${clash} also claimed by ${others(hostClaims.get(clash), id)}`
    const sharers = dbClaims.get(r.dbConnection) ?? []
    // Names the other tenants, never the connection string.
    if (sharers.length > 1) return `shares its database with ${others(sharers, id)}`
    return r
  }

  const tenants: TenantRecord[] = []
  const dropped: { id: string; why: string }[] = []
  wire.forEach((t, i) => {
    const id = ids[i]
    const why = dropReason(t, id)
    if (typeof why === 'string') dropped.push({ id, why })
    else tenants.push(why)
  })
  return { tenants, dropped }
}
