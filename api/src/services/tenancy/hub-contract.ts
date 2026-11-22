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

/** One wire tenant as a TenantRecord, or why this deployment cannot serve it. */
function toRecord(t: unknown): TenantRecord | string {
  if (!isObj(t)) return 'not an object'
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) return 'invalid id'
  if (typeof t.app_key !== 'string' || !t.app_key.trim()) return 'no app key'
  if (typeof t.name !== 'string') return 'no name'
  if (typeof t.status !== 'string' || !STATUSES.has(t.status)) return 'unknown status'
  const db = isObj(t.db) ? t.db : null
  const client = typeof db?.client === 'string' ? db.client : ''
  if (/sqlite/i.test(client)) return 'SQLite cannot be served on a shared deployment'
  if (!CLIENTS.has(client)) return 'unknown database client'
  if (typeof db?.connection !== 'string' || !db.connection.trim()) return 'no connection'
  let poolMax: number | null = null
  if (t.pool_max !== undefined && t.pool_max !== null) {
    const n = t.pool_max
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 20)
      return 'pool_max outside 1-20'
    poolMax = n
  }
  const hosts = Array.isArray(t.hostnames)
    ? [
        ...new Set(
          t.hostnames
            .map((h) => cleanTenantHost(typeof h === 'string' ? h : null))
            .filter((h): h is string => !!h)
        )
      ]
    : []
  if (hosts.length === 0) return 'no hostnames'
  return {
    id: t.id,
    slug: t.app_key.trim(),
    name: t.name,
    status: t.status,
    dbClient: client,
    dbConnection: db.connection,
    poolMax,
    hostnames: hosts
  }
}

/**
 * The tenants a Hub body lists, as TenantRecords, plus every tenant this deployment cannot serve
 * (named with a reason). `null` = the body is not a tenant list at all (the caller keeps its
 * last good list).
 */
export function parseHubTenants(
  body: unknown,
  deployment: string
): { tenants: TenantRecord[]; dropped: { id: string; why: string }[] } | null {
  if (!isObj(body) || !isObj(body.data)) return null
  const { data } = body
  if (typeof data.deployment !== 'string' || !Array.isArray(data.tenants)) return null
  const wire = data.tenants as unknown[]
  const dropped: { id: string; why: string }[] = []

  if (data.deployment !== deployment) {
    return {
      tenants: [],
      dropped: wire.map((t, i) => ({
        id: shownId(isObj(t) ? t.id : null, i),
        why: WRONG_DEPLOYMENT
      }))
    }
  }

  const kept: TenantRecord[] = []
  wire.forEach((t, i) => {
    const r = toRecord(t)
    if (typeof r === 'string') dropped.push({ id: shownId(isObj(t) ? t.id : null, i), why: r })
    else if (kept.some((k) => k.id === r.id)) dropped.push({ id: r.id, why: 'duplicate id' })
    else kept.push(r)
  })

  // A duplicate id drops every tenant with that id, the first one too.
  const dupIds = new Set(dropped.filter((d) => d.why === 'duplicate id').map((d) => d.id))
  // A hostname claimed by two tenants routes to neither: both are dropped.
  const owners = new Map<string, string[]>()
  for (const k of kept) for (const h of k.hostnames) owners.set(h, [...(owners.get(h) ?? []), k.id])
  const tenants: TenantRecord[] = []
  for (const k of kept) {
    if (dupIds.has(k.id)) {
      dropped.push({ id: k.id, why: 'duplicate id' })
      continue
    }
    const clash = k.hostnames.find((h) => (owners.get(h) ?? []).length > 1)
    if (clash) {
      const others = (owners.get(clash) ?? []).filter((o) => o !== k.id)
      dropped.push({ id: k.id, why: `hostname ${clash} also claimed by ${others.join(', ')}` })
      continue
    }
    tenants.push(k)
  }
  return { tenants, dropped }
}
