import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { fingerprintOf } from '../ops/secrets.js'
import { HUB_MASK, maskSecret, openSecret, sealSecret } from '../secrets.js'
import { forgetConnectionTokens } from './context.js'
import type { ChangeStatus, ChangeStep, StoredChangePlan } from './engine/contract.js'
import type { ConnectionTest, Observed, ResourceScope } from './types.js'

/**
 * Rows of migration 582. Only the engine (and the connection routes) write here; adapters never
 * touch the database. A connection's secret is ONE sealed JSON object of its secret fields; it
 * leaves this module only through `openConnectionSecrets` — every row read answers the mask, a
 * fingerprint of the sealed form and the names of the fields that are set.
 */

export const CONNECTIONS = 'nivaro_hub_connections'
export const APP_CONNECTIONS = 'nivaro_hub_app_connections'
export const RESOURCES = 'nivaro_hub_resources'
export const RESOURCE_CHANGES = 'nivaro_hub_resource_changes'

export type HubProviderStoreCode =
  | 'CONNECTION_NOT_FOUND'
  | 'RESOURCE_NOT_FOUND'
  | 'RESOURCE_ALREADY_MANAGED'
  | 'CONNECTION_SECRET_BAD'

export class HubProviderStoreError extends Error {
  code: HubProviderStoreCode
  constructor(code: HubProviderStoreCode, message: string) {
    super(message)
    this.name = 'HubProviderStoreError'
    this.code = code
  }
}

// ── Row types ──

export type ConnectionStatus = 'untested' | 'ok' | 'failing' | 'disabled'

export interface HubConnectionRow {
  id: number
  provider: string
  name: string
  /** Non-secret fields. */
  config: Record<string, unknown>
  /** HUB_MASK when a secret is stored, else null. Never the secret. */
  secret_mask: string | null
  /** SHA-256 (32 hex) of the sealed form; changes on every save of a secret. */
  secret_fingerprint: string | null
  /** Which secret fields hold a value (for per-field masks on the form). */
  secret_keys: string[]
  status: ConnectionStatus
  last_test_at: string | null
  last_test: ConnectionTest | null
  created_by: string | null
  updated_by: string | null
  created_at: string | null
  updated_at: string | null
}

/** How a `secret` FieldSpec value is stored inside `desired` (never the plain value). */
export interface StoredSecretField {
  $sealed: string
  fingerprint: string
}

export interface HubResourceRow {
  id: number
  connection_id: number
  provider: string
  type: string
  external_id: string | null
  name: string | null
  scope: ResourceScope
  app_id: number | null
  environment_id: number | null
  /**
   * The desired fields (DesiredResource.fields as stored): ref fields as RefValue, secret fields
   * as StoredSecretField. null for an adopted resource nobody has edited yet (desired = observed).
   */
  desired: Record<string, unknown> | null
  observed: Observed | null
  drift: boolean
  observed_at: string | null
  tags: Record<string, string>
  /** Every other managed resource this one points at (for dependency order and SHARED_IN_USE). */
  refs: Array<{ field: string; resourceId: number }>
  created_by: string | null
  adopted: boolean
  deleted_at: string | null
  created_at: string | null
  updated_at: string | null
}

export interface HubResourceChangeRow {
  id: number
  connection_id: number
  app_id: number | null
  environment_id: number | null
  scope: ResourceScope
  status: ChangeStatus
  plan: StoredChangePlan | null
  plan_hash: string | null
  steps: ChangeStep[]
  requested_by: string | null
  approved_by: string | null
  decline_reason: string | null
  run_key: string | null
  heartbeat_at: string | null
  error_code: string | null
  error: string | null
  created_at: string | null
  updated_at: string | null
  finished_at: string | null
}

// ── Helpers ──

function json<T>(raw: unknown, dflt: T): T {
  if (raw == null || raw === '') return dflt
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return dflt
  }
}
const str = (v: unknown) => (v === undefined ? null : JSON.stringify(v))

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  // SQLite keeps a dateTime as epoch milliseconds.
  const t =
    v instanceof Date
      ? v.getTime()
      : typeof v === 'number' || /^\d{12,}$/.test(String(v))
        ? Number(v)
        : Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const numOrNull = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
const truthy = (v: unknown) => v === true || v === 1 || v === '1'
const strOrNull = (v: unknown) => (v == null ? null : String(v))
const scopeOf = (v: unknown): ResourceScope => (v === 'shared' ? 'shared' : 'app')

function objectOf(raw: unknown): Record<string, unknown> {
  const v = json<unknown>(raw, {})
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function stringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(objectOf(raw))) if (typeof v === 'string') out[k] = v
  return out
}

function stringList(raw: unknown): string[] {
  const v = json<unknown>(raw, [])
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []
}

function secretObject(plain: string | null): Record<string, string> {
  if (!plain) return {}
  try {
    const v = JSON.parse(plain) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
    const out: Record<string, string> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      if (typeof x === 'string') out[k] = x
    return out
  } catch {
    throw new HubProviderStoreError(
      'CONNECTION_SECRET_BAD',
      'The stored connection secret could not be read.'
    )
  }
}

function sealSecrets(secrets: Record<string, string>): string | null {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(secrets)) if (typeof v === 'string' && v !== '') clean[k] = v
  return Object.keys(clean).length ? sealSecret(JSON.stringify(clean)) : null
}

const keysOfSecrets = (secrets: Record<string, string>) =>
  Object.keys(secrets)
    .filter((k) => secrets[k] !== '')
    .sort()

// ── Connections ──

function connectionOf(r: Record<string, unknown>): HubConnectionRow {
  const sealed = strOrNull(r.secret)
  const status = String(r.status ?? 'untested')
  return {
    id: Number(r.id),
    provider: String(r.provider),
    name: String(r.name ?? ''),
    config: objectOf(r.config),
    secret_mask: maskSecret(sealed),
    secret_fingerprint: sealed ? fingerprintOf(sealed) : null,
    secret_keys: stringList(r.secret_keys),
    status: (['untested', 'ok', 'failing', 'disabled'].includes(status)
      ? status
      : 'untested') as ConnectionStatus,
    last_test_at: iso(r.last_test_at),
    last_test: json<ConnectionTest | null>(r.last_test, null),
    created_by: strOrNull(r.created_by),
    updated_by: strOrNull(r.updated_by),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at)
  }
}

export interface CreateConnectionInput {
  provider: string
  name: string
  config: Record<string, unknown>
  /** Plain secret field values; sealed here. Empty strings are dropped. */
  secrets: Record<string, string>
  createdBy?: string | null
}

export async function createConnection(input: CreateConnectionInput): Promise<HubConnectionRow> {
  const now = new Date()
  const secrets = Object.fromEntries(
    Object.entries(input.secrets ?? {}).filter(([, v]) => typeof v === 'string' && v !== '')
  ) as Record<string, string>
  const id = await insertReturningId(db, CONNECTIONS, {
    provider: input.provider,
    name: input.name,
    config: str(input.config ?? {}),
    secret: sealSecrets(secrets),
    secret_keys: str(keysOfSecrets(secrets)),
    status: 'untested',
    created_by: input.createdBy ?? null,
    updated_by: input.createdBy ?? null,
    created_at: now,
    updated_at: now
  })
  const row = await readConnection(Number(id))
  if (!row) throw new HubProviderStoreError('CONNECTION_NOT_FOUND', 'Connection was not saved.')
  return row
}

export async function readConnection(id: number): Promise<HubConnectionRow | null> {
  const r = (await db(CONNECTIONS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? connectionOf(r) : null
}

export async function listConnections(
  filter: { provider?: string; ids?: number[] } = {}
): Promise<HubConnectionRow[]> {
  const q = db(CONNECTIONS).select('*').orderBy('id', 'asc')
  if (filter.provider) q.where('provider', filter.provider)
  if (filter.ids) {
    if (!filter.ids.length) return []
    q.whereIn('id', filter.ids)
  }
  return ((await q) as Array<Record<string, unknown>>).map(connectionOf)
}

export interface UpdateConnectionInput {
  name?: string
  config?: Record<string, unknown>
  /**
   * Per secret field: HUB_MASK (or absent) keeps the stored value, '' / null clears it, any other
   * string replaces it. Fields not named are kept.
   */
  secrets?: Record<string, string | null>
  status?: ConnectionStatus
  lastTest?: ConnectionTest | null
  lastTestAt?: Date | null
  updatedBy?: string | null
}

export async function updateConnection(
  id: number,
  patch: UpdateConnectionInput
): Promise<HubConnectionRow | null> {
  const r = (await db(CONNECTIONS).where({ id }).first()) as Record<string, unknown> | undefined
  if (!r) return null
  const set: Record<string, unknown> = { updated_at: new Date() }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.config !== undefined) set.config = str(patch.config)
  if (patch.status !== undefined) set.status = patch.status
  if (patch.lastTest !== undefined)
    set.last_test = patch.lastTest === null ? null : str(patch.lastTest)
  if (patch.lastTestAt !== undefined) set.last_test_at = patch.lastTestAt
  if (patch.updatedBy !== undefined) set.updated_by = patch.updatedBy
  if (patch.secrets !== undefined) {
    const current = secretObject(openSecret(strOrNull(r.secret)))
    let changed = false
    for (const [k, v] of Object.entries(patch.secrets)) {
      if (v === HUB_MASK || v === undefined) continue
      if (v === null || v === '') {
        if (k in current) {
          delete current[k]
          changed = true
        }
      } else if (current[k] !== v) {
        current[k] = v
        changed = true
      }
    }
    if (changed) {
      set.secret = sealSecrets(current)
      set.secret_keys = str(keysOfSecrets(current))
      forgetConnectionTokens(id)
    }
  }
  await db(CONNECTIONS).where({ id }).update(set)
  return readConnection(id)
}

/** Deletes the connection and its allowed-app rows. Resources are the caller's to check first. */
export async function deleteConnection(id: number): Promise<boolean> {
  await db(APP_CONNECTIONS).where({ connection_id: id }).del()
  const n = await db(CONNECTIONS).where({ id }).del()
  forgetConnectionTokens(id)
  return Number(n) > 0
}

/** The connection's secret fields, opened. The only way a secret leaves this module. */
export async function openConnectionSecrets(row: { id: number }): Promise<Record<string, string>> {
  const r = (await db(CONNECTIONS).where({ id: row.id }).first('secret')) as
    | { secret?: unknown }
    | undefined
  if (!r) throw new HubProviderStoreError('CONNECTION_NOT_FOUND', 'Connection not found.')
  return secretObject(openSecret(strOrNull(r.secret)))
}

// ── Allowed connections per app ──

export async function appAllowedConnections(appId: number): Promise<number[]> {
  const rows = (await db(APP_CONNECTIONS)
    .where({ app_id: appId })
    .orderBy('connection_id', 'asc')
    .select('connection_id')) as Array<{ connection_id: unknown }>
  return rows.map((r) => Number(r.connection_id))
}

/** Replaces the app's allowed list with exactly `ids` (deduplicated). */
export async function setAppAllowedConnections(
  appId: number,
  ids: number[],
  by: string | null = null
): Promise<number[]> {
  const want = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  await db.transaction(async (trx) => {
    await trx(APP_CONNECTIONS).where({ app_id: appId }).del()
    for (const connection_id of want)
      await trx(APP_CONNECTIONS).insert({
        app_id: appId,
        connection_id,
        created_by: by,
        created_at: new Date()
      })
  })
  return appAllowedConnections(appId)
}

// ── Resources ──

function refsOf(raw: unknown): Array<{ field: string; resourceId: number }> {
  const v = json<unknown>(raw, [])
  if (!Array.isArray(v)) return []
  const out: Array<{ field: string; resourceId: number }> = []
  for (const x of v) {
    const r = x as { field?: unknown; resourceId?: unknown }
    if (typeof r?.field === 'string' && Number.isInteger(Number(r.resourceId)))
      out.push({ field: r.field, resourceId: Number(r.resourceId) })
  }
  return out
}

function resourceOf(r: Record<string, unknown>): HubResourceRow {
  const desired = json<unknown>(r.desired, null)
  return {
    id: Number(r.id),
    connection_id: Number(r.connection_id),
    provider: String(r.provider),
    type: String(r.type),
    external_id: strOrNull(r.external_id),
    name: strOrNull(r.name),
    scope: scopeOf(r.scope),
    app_id: numOrNull(r.app_id),
    environment_id: numOrNull(r.environment_id),
    desired:
      desired && typeof desired === 'object' && !Array.isArray(desired)
        ? (desired as Record<string, unknown>)
        : null,
    observed: json<Observed | null>(r.observed, null),
    drift: truthy(r.drift),
    observed_at: iso(r.observed_at),
    tags: stringMap(r.tags),
    refs: refsOf(r.refs),
    created_by: strOrNull(r.created_by),
    adopted: truthy(r.adopted),
    deleted_at: iso(r.deleted_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at)
  }
}

export interface InsertResourceInput {
  connection_id: number
  provider: string
  type: string
  external_id?: string | null
  name?: string | null
  scope: ResourceScope
  app_id?: number | null
  environment_id?: number | null
  desired?: Record<string, unknown> | null
  observed?: Observed | null
  drift?: boolean
  observed_at?: Date | null
  tags?: Record<string, string>
  refs?: Array<{ field: string; resourceId: number }>
  created_by?: string | null
  adopted?: boolean
}

async function assertNotManaged(
  connectionId: number,
  type: string,
  externalId: string | null | undefined,
  exceptId?: number
): Promise<void> {
  if (!externalId) return
  const q = db(RESOURCES)
    .where({ connection_id: connectionId, type, external_id: externalId })
    .whereNull('deleted_at')
  if (exceptId !== undefined) q.whereNot('id', exceptId)
  if (await q.first('id'))
    throw new HubProviderStoreError(
      'RESOURCE_ALREADY_MANAGED',
      'The Hub already manages this resource.'
    )
}

export async function insertResource(input: InsertResourceInput): Promise<HubResourceRow> {
  await assertNotManaged(input.connection_id, input.type, input.external_id)
  const now = new Date()
  const id = await insertReturningId(db, RESOURCES, {
    connection_id: input.connection_id,
    provider: input.provider,
    type: input.type,
    external_id: input.external_id ?? null,
    name: input.name ?? null,
    scope: input.scope,
    app_id: input.scope === 'shared' ? null : (input.app_id ?? null),
    environment_id: input.scope === 'shared' ? null : (input.environment_id ?? null),
    desired: input.desired == null ? null : str(input.desired),
    observed: input.observed == null ? null : str(input.observed),
    drift: input.drift ?? false,
    observed_at: input.observed_at ?? null,
    tags: str(input.tags ?? {}),
    refs: str(input.refs ?? []),
    created_by: input.created_by ?? null,
    adopted: input.adopted ?? false,
    created_at: now,
    updated_at: now
  })
  const row = await readResource(Number(id))
  if (!row) throw new HubProviderStoreError('RESOURCE_NOT_FOUND', 'Resource was not saved.')
  return row
}

export type UpdateResourceInput = Partial<
  Omit<InsertResourceInput, 'connection_id' | 'provider' | 'type' | 'scope'>
> & { deleted_at?: Date | null }

export async function updateResource(
  id: number,
  patch: UpdateResourceInput
): Promise<HubResourceRow | null> {
  const cur = await readResource(id)
  if (!cur) return null
  if (patch.external_id !== undefined && patch.external_id !== cur.external_id)
    await assertNotManaged(cur.connection_id, cur.type, patch.external_id, id)
  const set: Record<string, unknown> = { updated_at: new Date() }
  if (patch.external_id !== undefined) set.external_id = patch.external_id
  if (patch.name !== undefined) set.name = patch.name
  if (patch.app_id !== undefined && cur.scope === 'app') set.app_id = patch.app_id
  if (patch.environment_id !== undefined && cur.scope === 'app')
    set.environment_id = patch.environment_id
  if (patch.desired !== undefined) set.desired = patch.desired === null ? null : str(patch.desired)
  if (patch.observed !== undefined)
    set.observed = patch.observed === null ? null : str(patch.observed)
  if (patch.drift !== undefined) set.drift = patch.drift
  if (patch.observed_at !== undefined) set.observed_at = patch.observed_at
  if (patch.tags !== undefined) set.tags = str(patch.tags)
  if (patch.refs !== undefined) set.refs = str(patch.refs)
  if (patch.adopted !== undefined) set.adopted = patch.adopted
  if (patch.deleted_at !== undefined) set.deleted_at = patch.deleted_at
  await db(RESOURCES).where({ id }).update(set)
  return readResource(id)
}

export async function readResource(id: number): Promise<HubResourceRow | null> {
  const r = (await db(RESOURCES).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? resourceOf(r) : null
}

export interface ResourceFilter {
  ids?: number[]
  connectionId?: number
  provider?: string
  type?: string
  scope?: ResourceScope
  appId?: number
  environmentId?: number
  drift?: boolean
  externalId?: string
  /** Default false: deleted rows (history) are left out. */
  includeDeleted?: boolean
}

export async function listResources(filter: ResourceFilter = {}): Promise<HubResourceRow[]> {
  const q = db(RESOURCES).select('*').orderBy('id', 'asc')
  if (filter.ids) {
    if (!filter.ids.length) return []
    q.whereIn('id', filter.ids)
  }
  if (filter.connectionId !== undefined) q.where('connection_id', filter.connectionId)
  if (filter.provider) q.where('provider', filter.provider)
  if (filter.type) q.where('type', filter.type)
  if (filter.scope) q.where('scope', filter.scope)
  if (filter.appId !== undefined) q.where('app_id', filter.appId)
  if (filter.environmentId !== undefined) q.where('environment_id', filter.environmentId)
  if (filter.drift !== undefined) q.where('drift', filter.drift)
  if (filter.externalId !== undefined) q.where('external_id', filter.externalId)
  if (!filter.includeDeleted) q.whereNull('deleted_at')
  return ((await q) as Array<Record<string, unknown>>).map(resourceOf)
}

// ── Changes ──

const CHANGE_STATUSES: readonly ChangeStatus[] = [
  'planned',
  'pending_approval',
  'applying',
  'applied',
  'failed',
  'interrupted',
  'cancelled',
  'declined',
  'stale'
]

function changeOf(r: Record<string, unknown>): HubResourceChangeRow {
  const status = String(r.status ?? 'planned') as ChangeStatus
  const steps = json<unknown>(r.steps, [])
  return {
    id: Number(r.id),
    connection_id: Number(r.connection_id),
    app_id: numOrNull(r.app_id),
    environment_id: numOrNull(r.environment_id),
    scope: scopeOf(r.scope),
    status: CHANGE_STATUSES.includes(status) ? status : 'planned',
    plan: json<StoredChangePlan | null>(r.plan, null),
    plan_hash: strOrNull(r.plan_hash),
    steps: Array.isArray(steps) ? (steps as ChangeStep[]) : [],
    requested_by: strOrNull(r.requested_by),
    approved_by: strOrNull(r.approved_by),
    decline_reason: strOrNull(r.decline_reason),
    run_key: strOrNull(r.run_key),
    heartbeat_at: iso(r.heartbeat_at),
    error_code: strOrNull(r.error_code),
    error: strOrNull(r.error),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    finished_at: iso(r.finished_at)
  }
}

export interface InsertChangeInput {
  connection_id: number
  app_id?: number | null
  environment_id?: number | null
  scope: ResourceScope
  status?: ChangeStatus
  plan: StoredChangePlan
  plan_hash: string
  steps?: ChangeStep[]
  requested_by?: string | null
}

export async function insertChange(input: InsertChangeInput): Promise<HubResourceChangeRow> {
  const now = new Date()
  const id = await insertReturningId(db, RESOURCE_CHANGES, {
    connection_id: input.connection_id,
    app_id: input.app_id ?? null,
    environment_id: input.environment_id ?? null,
    scope: input.scope,
    status: input.status ?? 'planned',
    plan: str(input.plan),
    plan_hash: input.plan_hash,
    steps: str(input.steps ?? []),
    requested_by: input.requested_by ?? null,
    created_at: now,
    updated_at: now
  })
  const row = await readChange(Number(id))
  if (!row) throw new Error('Resource change was not saved.')
  return row
}

export interface UpdateChangeInput {
  status?: ChangeStatus
  plan?: StoredChangePlan
  plan_hash?: string
  steps?: ChangeStep[]
  approved_by?: string | null
  decline_reason?: string | null
  run_key?: string | null
  heartbeat_at?: Date | null
  error_code?: string | null
  error?: string | null
  finished_at?: Date | null
}

/**
 * Updates a change. With `expectStatus` the write happens only while the row is in one of those
 * statuses (compare-and-set): null when it was not (or the row is gone).
 */
export async function updateChange(
  id: number,
  patch: UpdateChangeInput,
  opts: { expectStatus?: ChangeStatus | ChangeStatus[]; expectRunKey?: string | null } = {}
): Promise<HubResourceChangeRow | null> {
  const set: Record<string, unknown> = { updated_at: new Date() }
  if (patch.status !== undefined) set.status = patch.status
  if (patch.plan !== undefined) set.plan = str(patch.plan)
  if (patch.plan_hash !== undefined) set.plan_hash = patch.plan_hash
  if (patch.steps !== undefined) set.steps = str(patch.steps)
  if (patch.approved_by !== undefined) set.approved_by = patch.approved_by
  if (patch.decline_reason !== undefined) set.decline_reason = patch.decline_reason
  if (patch.run_key !== undefined) set.run_key = patch.run_key
  if (patch.heartbeat_at !== undefined) set.heartbeat_at = patch.heartbeat_at
  if (patch.error_code !== undefined) set.error_code = patch.error_code
  if (patch.error !== undefined) set.error = patch.error
  if (patch.finished_at !== undefined) set.finished_at = patch.finished_at
  const q = db(RESOURCE_CHANGES).where({ id })
  if (opts.expectStatus !== undefined)
    q.whereIn('status', Array.isArray(opts.expectStatus) ? opts.expectStatus : [opts.expectStatus])
  if (opts.expectRunKey !== undefined) {
    if (opts.expectRunKey === null) q.whereNull('run_key')
    else q.where('run_key', opts.expectRunKey)
  }
  const n = await q.update(set)
  if (!Number(n)) return null
  return readChange(id)
}

export async function readChange(id: number): Promise<HubResourceChangeRow | null> {
  const r = (await db(RESOURCE_CHANGES).where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? changeOf(r) : null
}

export interface ChangeFilter {
  connectionId?: number
  appId?: number
  environmentId?: number
  scope?: ResourceScope
  status?: ChangeStatus | ChangeStatus[]
  /** Newest first; `beforeId` pages back. Default limit 50, max 200. */
  limit?: number
  beforeId?: number
}

export async function listChanges(filter: ChangeFilter = {}): Promise<HubResourceChangeRow[]> {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 200)
  const q = db(RESOURCE_CHANGES).select('*').orderBy('id', 'desc').limit(limit)
  if (filter.connectionId !== undefined) q.where('connection_id', filter.connectionId)
  if (filter.appId !== undefined) q.where('app_id', filter.appId)
  if (filter.environmentId !== undefined) q.where('environment_id', filter.environmentId)
  if (filter.scope) q.where('scope', filter.scope)
  if (filter.status !== undefined)
    q.whereIn('status', Array.isArray(filter.status) ? filter.status : [filter.status])
  if (filter.beforeId !== undefined) q.where('id', '<', filter.beforeId)
  return ((await q) as Array<Record<string, unknown>>).map(changeOf)
}
