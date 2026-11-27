import { randomBytes } from 'node:crypto'
import { fieldWords, typedName } from '../plan-words.js'
import {
  type DesiredResource,
  type FieldChange,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderContext,
  ProviderError,
  type SnapshotRef
} from '../types.js'
import {
  API,
  type ArmId,
  armCall,
  armList,
  armVersion,
  azureTags,
  childId,
  groupId,
  hubTags,
  idOfServer,
  isArmUrl,
  nameSeg,
  OUT_OF_ACCOUNT,
  parseArmId,
  pinnedId,
  pinnedSub,
  serverId,
  sleep,
  subscriptionsOf,
  withScrub
} from './client.js'
import { coversEveryone, validRange } from './ip.js'
import { skuOf } from './pricing.js'
import { AZURE_SPECS, BUDGET, DB, FW, PE, RG, ROTATE, SRV } from './specs.js'

/**
 * The Azure resource types: reading, planning and applying. Every id is parsed and pinned to the
 * connection's subscriptions before any call; a create never touches something the Hub did not
 * make (`ALREADY_EXISTS`, ARM's PUT would otherwise overwrite it); children are checked against
 * their parent's id.
 */

type Obj = Record<string, any>
const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const GIB = 1024 ** 3

const portal = (id: string) => `https://portal.azure.com/#@/resource${id}/overview`
const lc = (s: unknown) => String(s ?? '').toLowerCase()

// ── Budget ids ──

const BUDGET_ID_RE =
  /^\/subscriptions\/([0-9a-f-]{36})\/providers\/Microsoft\.Consumption\/budgets\/([^/]+)$/i

export function budgetId(sub: string, name: string): string {
  return `/subscriptions/${sub}/providers/Microsoft.Consumption/budgets/${nameSeg(name, 'budget', 'budget name')}`
}

function pinnedBudget(ctx: ProviderContext, id: unknown): { sub: string; name: string } {
  const m = typeof id === 'string' ? BUDGET_ID_RE.exec(id) : null
  if (!m) throw new ProviderError('BAD_ID', 'That Azure budget id is not valid.')
  const name = decodeURIComponent(m[2])
  nameSeg(name, 'budget', 'budget name')
  return { sub: pinnedSub(ctx, m[1]), name }
}

// ── Reads ──

async function getRaw(ctx: ProviderContext, id: string, version: string): Promise<Obj | null> {
  const r = await armCall(ctx, 'GET', id, { query: armVersion(version), allow: [404] })
  return r.status === 404 ? null : asObj(r.body)
}

function observedGroup(raw: Obj): Observed {
  const id = String(raw.id)
  const p = parseArmId(id)
  return {
    type: RG,
    externalId: id,
    name: str(raw.name),
    fields: { subscription_id: p?.sub ?? null, name: str(raw.name), location: str(raw.location) },
    tags: hubTags(raw.tags),
    status: str(asObj(raw.properties).provisioningState),
    url: portal(id)
  }
}

function observedServer(raw: Obj): Observed {
  const id = String(raw.id)
  const p = parseArmId(id)
  const props = asObj(raw.properties)
  const admins = asObj(props.administrators)
  return {
    type: SRV,
    externalId: id,
    name: str(raw.name),
    fields: {
      resource_group: p ? groupId(p.sub, p.group) : null,
      name: str(raw.name),
      location: str(raw.location),
      entra_admin_login: str(admins.login),
      entra_admin_object_id: str(admins.sid),
      entra_only_auth: admins.azureADOnlyAuthentication === true,
      minimal_tls_version: str(props.minimalTlsVersion),
      public_network_access: lc(props.publicNetworkAccess) === 'enabled',
      sql_admin_login: str(props.administratorLogin),
      fqdn: str(props.fullyQualifiedDomainName)
    },
    tags: hubTags(raw.tags),
    status: str(props.state),
    url: portal(id)
  }
}

function observedRule(raw: Obj): Observed {
  const id = String(raw.id)
  const p = parseArmId(id)
  const props = asObj(raw.properties)
  return {
    type: FW,
    externalId: id,
    name: str(raw.name),
    fields: {
      server: p ? idOfServer(p) : null,
      name: str(raw.name),
      start_ip_address: str(props.startIpAddress),
      end_ip_address: str(props.endIpAddress)
    },
    tags: {},
    url: p?.server ? portal(serverId(p.sub, p.group, p.server)) : null
  }
}

function observedEndpoint(raw: Obj): Observed {
  const id = String(raw.id)
  const p = parseArmId(id)
  const props = asObj(raw.properties)
  return {
    type: PE,
    externalId: id,
    name: str(raw.name),
    fields: {
      server: p ? idOfServer(p) : null,
      name: str(raw.name),
      status: str(asObj(props.privateLinkServiceConnectionState).status),
      private_endpoint: str(asObj(props.privateEndpoint).id)
    },
    tags: {},
    status: str(props.provisioningState),
    url: p?.server ? portal(serverId(p.sub, p.group, p.server)) : null
  }
}

function observedDatabase(raw: Obj, retentionDays: number | null | undefined): Observed {
  const id = String(raw.id)
  const p = parseArmId(id)
  const props = asObj(raw.properties)
  const sku = asObj(raw.sku)
  const known = skuOf(sku.name)
  const bytes = num(props.maxSizeBytes)
  const fields: Obj = {
    server: p ? idOfServer(p) : null,
    name: str(raw.name),
    location: str(raw.location),
    sku_name: str(sku.name),
    capacity: known && known.model !== 'dtu' ? num(sku.capacity) : null,
    max_size_gb: bytes != null ? Math.round((bytes / GIB) * 1000) / 1000 : null
  }
  if (retentionDays !== undefined) fields.backup_retention_days = retentionDays
  return {
    type: DB,
    externalId: id,
    name: str(raw.name),
    fields,
    tags: hubTags(raw.tags),
    status: str(props.status),
    url: portal(id)
  }
}

function observedBudget(raw: Obj): Observed {
  const id = String(raw.id)
  const m = BUDGET_ID_RE.exec(id)
  const props = asObj(raw.properties)
  const tagFilter = asObj(asObj(props.filter).tags)
  const notes = Object.values(asObj(props.notifications)).map(asObj)
  const thresholds = [
    ...new Set(notes.map((n) => num(n.threshold)).filter((n): n is number => n != null))
  ].sort((a, b) => a - b)
  const emails = [
    ...new Set(
      notes.flatMap((n) => (Array.isArray(n.contactEmails) ? n.contactEmails.map(String) : []))
    )
  ].sort()
  const values = Array.isArray(tagFilter.values) ? tagFilter.values : []
  return {
    type: BUDGET,
    externalId: id,
    name: str(raw.name),
    fields: {
      subscription_id: m ? m[1].toLowerCase() : null,
      name: str(raw.name),
      amount: num(props.amount),
      app_tag: str(values[0]),
      thresholds,
      contact_emails: emails,
      start_date: str(asObj(props.timePeriod).startDate)
    },
    tags: {},
    url: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/budgets'
  }
}

/** The shape of id each type expects: refuses an id of another type (`BAD_ID`). */
function expectKind(type: string, p: ArmId): void {
  const ok =
    (type === RG && !p.server) ||
    (type === SRV && !!p.server && !p.child) ||
    (type === DB && p.child?.kind === 'databases') ||
    (type === FW && p.child?.kind === 'firewallRules') ||
    (type === PE && p.child?.kind === 'privateEndpointConnections')
  if (!ok) throw new ProviderError('BAD_ID', `That id is not a ${type} id.`)
}

async function retentionOf(ctx: ProviderContext, dbId: string): Promise<number | null> {
  const raw = await getRaw(ctx, `${dbId}/backupShortTermRetentionPolicies/default`, API.sql)
  return raw ? num(asObj(raw.properties).retentionDays) : null
}

export async function observeAzure(
  ctx: ProviderContext,
  type: string,
  externalId: string
): Promise<Observed | null> {
  if (type === BUDGET) {
    const b = pinnedBudget(ctx, externalId)
    const raw = await getRaw(ctx, budgetId(b.sub, b.name), API.budget)
    return raw ? observedBudget(raw) : null
  }
  const p = pinnedId(ctx, externalId)
  expectKind(type, p)
  const id = p.child
    ? childId(serverId(p.sub, p.group, p.server as string), p.child.kind, p.child.name)
    : p.server
      ? serverId(p.sub, p.group, p.server)
      : groupId(p.sub, p.group)
  const version = type === RG ? API.resources : API.sql
  const raw = await getRaw(ctx, id, version)
  if (!raw) return null
  if (type === RG) return observedGroup(raw)
  if (type === SRV) return observedServer(raw)
  if (type === FW) return observedRule(raw)
  if (type === PE) return observedEndpoint(raw)
  if (lc(raw.name) === 'master') return null
  return observedDatabase(raw, await retentionOf(ctx, id))
}

export async function listAzure(ctx: ProviderContext, type: string): Promise<ListPage> {
  const items: Observed[] = []
  const q = (v: string) => armVersion(v)
  for (const sub of subscriptionsOf(ctx.config)) {
    if (type === RG) {
      for (const raw of await armList(
        ctx,
        `/subscriptions/${sub}/resourcegroups`,
        q(API.resources)
      ))
        if (parseArmId(raw?.id)) items.push(observedGroup(raw))
      continue
    }
    if (type === BUDGET) {
      for (const raw of await armList(
        ctx,
        `/subscriptions/${sub}/providers/Microsoft.Consumption/budgets`,
        q(API.budget)
      ))
        if (typeof raw?.id === 'string' && BUDGET_ID_RE.test(raw.id))
          items.push(observedBudget(raw))
      continue
    }
    const servers = await armList(
      ctx,
      `/subscriptions/${sub}/providers/Microsoft.Sql/servers`,
      q(API.sql)
    )
    for (const s of servers) {
      const sp = parseArmId(s?.id)
      if (!sp?.server) continue
      if (type === SRV) {
        items.push(observedServer(s))
        continue
      }
      const sid = serverId(sp.sub, sp.group, sp.server)
      const kind =
        type === DB ? 'databases' : type === FW ? 'firewallRules' : 'privateEndpointConnections'
      for (const raw of await armList(ctx, `${sid}/${kind}`, q(API.sql))) {
        if (!parseArmId(raw?.id)) continue
        if (type === DB) {
          if (lc(raw.name) !== 'master') items.push(observedDatabase(raw, undefined))
        } else if (type === FW) items.push(observedRule(raw))
        else items.push(observedEndpoint(raw))
      }
    }
  }
  return { items, cursor: null }
}

// ── Plan ──

/** The fields a type's plan compares (readable and changeable). */
const KEYS: Record<string, string[]> = {
  [RG]: [],
  [SRV]: [
    'entra_admin_login',
    'entra_admin_object_id',
    'entra_only_auth',
    'minimal_tls_version',
    'public_network_access'
  ],
  [FW]: ['start_ip_address', 'end_ip_address'],
  [DB]: ['sku_name', 'capacity', 'max_size_gb', 'backup_retention_days'],
  [PE]: [],
  [BUDGET]: ['amount', 'app_tag', 'thresholds', 'contact_emails']
}

/** Fields that exist on a create (everything the person set). */
const CREATE_KEYS: Record<string, string[]> = {
  [RG]: ['subscription_id', 'name', 'location'],
  [SRV]: ['name', 'location', 'sql_admin_login', ...KEYS[SRV]],
  [FW]: ['name', ...KEYS[FW]],
  [DB]: ['name', ...KEYS[DB]],
  [PE]: ['name'],
  [BUDGET]: ['subscription_id', 'name', ...KEYS[BUDGET]]
}

const norm = (v: unknown): unknown => {
  if (v === undefined || v === '') return null
  if (Array.isArray(v))
    return JSON.stringify([...v].map((x) => (typeof x === 'string' ? x.toLowerCase() : x)).sort())
  return typeof v === 'string' ? v.toLowerCase() : v
}
const same = (a: unknown, b: unknown): boolean => {
  const x = norm(a)
  const y = norm(b)
  if (typeof x === 'number' || typeof y === 'number') return Number(x) === Number(y)
  return x === y
}

const READ_ONLY_TYPES = new Set([PE])

function planInner(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const type = desired?.type ?? observed?.type ?? ''
  const spec = AZURE_SPECS.find((s) => s.key === type)
  if (!spec) return []
  const label = spec.label
  const base = {
    type,
    resourceId: desired?.resourceId ?? null,
    externalId: observed?.externalId ?? desired?.externalId ?? null,
    preconditions: {} as Record<string, unknown>,
    risk: [] as never[]
  }
  const blocker = (code: string, message: string): Record<string, unknown> => ({
    $blocker: { code, message }
  })
  const readOnlyData = (text: string) =>
    READ_ONLY_TYPES.has(type)
      ? {
          data: blocker(
            'READ_ONLY_TYPE',
            `${text} Azure private endpoint connections are made by the owner of the endpoint: adopt it to see it here.`
          )
        }
      : {}
  if (!desired) {
    if (!observed) return []
    return [
      {
        ...base,
        kind: 'delete',
        reason: `Delete ${typedName(label, observed.name)}`,
        changes: [],
        ...readOnlyData('This cannot be removed here.')
      }
    ]
  }
  const want =
    type === BUDGET
      ? { ...desired.fields, app_tag: ownerTag(desired) ?? desired.fields.app_tag }
      : desired.fields
  if (!observed) {
    return [
      {
        ...base,
        kind: 'create',
        reason: `Create ${typedName(label, str(want.name))}`,
        changes: (CREATE_KEYS[type] ?? [])
          .filter((k) => want[k] !== undefined && want[k] !== null && want[k] !== '')
          .map((k) => ({ field: k, to: want[k] })),
        ...readOnlyData('This cannot be created here.')
      }
    ]
  }
  const changes: FieldChange[] = []
  for (const k of KEYS[type] ?? []) {
    if (want[k] === undefined || want[k] === null || want[k] === '') continue
    if (observed.fields[k] === undefined) continue
    if (!same(want[k], observed.fields[k]))
      changes.push({ field: k, from: observed.fields[k], to: want[k] })
  }
  if (type === SRV && want[ROTATE] === true)
    return [
      {
        ...base,
        kind: 'update',
        action: ROTATE,
        reason: `Rotate the SQL admin password of ${typedName(label, observed.name)}`,
        changes: [{ field: ROTATE, to: true }],
        preconditions: {}
      }
    ]
  if (!changes.length)
    return [
      {
        ...base,
        kind: 'noop',
        reason: `${typedName(label, observed.name)} is up to date`,
        changes: []
      }
    ]
  return [
    {
      ...base,
      kind: 'update',
      reason: `Change ${fieldWords(spec.fields, changes)} of ${typedName(label, observed.name)}`,
      changes,
      ...readOnlyData('This cannot be changed here.')
    }
  ]
}

const RESERVED_LOGINS = new Set([
  'admin',
  'administrator',
  'sa',
  'root',
  'guest',
  'dbo',
  'public',
  'sys',
  'information_schema',
  'azure_superuser',
  'azuresu'
])

/** Why a SQL admin login is not acceptable (Azure's rule), or null. */
export function loginProblem(login: unknown): string | null {
  const s = typeof login === 'string' ? login : ''
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(s))
    return 'The SQL admin login uses letters, digits and _, starts with a letter and has at most 128 characters.'
  if (RESERVED_LOGINS.has(s.toLowerCase()))
    return `${s} is a reserved name: choose another SQL admin login.`
  return null
}

/** Why the database name a connection string names is not acceptable, or null. */
export function databaseProblem(name: unknown): string | null {
  try {
    nameSeg(name, 'database', 'database name')
  } catch {
    return 'The database the connection string names is not a valid database name.'
  }
  return /[;="'\s]/.test(String(name)) ? 'The database name cannot hold ; = " \' or spaces.' : null
}

/** The app tag value a budget counts: always the owning app's own. */
export function ownerTag(desired: {
  tags?: Record<string, string>
  appId?: number | null
}): string | null {
  const t = str(desired.tags?.['nivaro-hub:app'])
  if (t) return t
  return desired.appId != null ? String(desired.appId) : null
}

/** What is wrong with the wanted values that no other check catches (INVALID_FIELDS), or null. */
export function fieldProblem(desired: DesiredResource): string | null {
  const f = desired.fields
  if (desired.type === BUDGET) {
    const tag = ownerTag(desired)
    if (!tag) return 'A budget belongs to an app: name the app it is for.'
    const given = str(f.app_tag)
    if (given && given !== tag)
      return 'A budget counts only its own app’s spend: the app tag must be this app’s.'
  }
  if (desired.type === SRV) {
    const db = str(f.app_database)
    if (db) {
      const p = databaseProblem(db)
      if (p) return p
    }
    const login = str(f.sql_admin_login)
    if (login && f.entra_only_auth === false) {
      const p = loginProblem(login)
      if (p) return p
    }
  }
  return null
}

export function planAzure(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const ops = planInner(desired, observed)
  const problem = desired ? fieldProblem(desired) : null
  if (!problem) return ops
  return ops.map((o) =>
    o.kind === 'noop' || o.kind === 'delete'
      ? o
      : {
          ...o,
          data: { ...(o.data ?? {}), $blocker: { code: 'INVALID_FIELDS', message: problem } }
        }
  )
}

// ── Apply ──

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>,
  outputs?: Record<string, string>
): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer } : {}),
  ...(outputs && Object.keys(outputs).length ? { outputs } : {})
})

const bad = (code: string, message: string, retryable = false) =>
  new ProviderError(code, message, { retryable })

function parentRef(
  ctx: ProviderContext,
  desired: DesiredResource,
  field: string,
  want: 'group' | 'server'
): ArmId {
  const ref = desired.refs?.[field]
  if (typeof ref !== 'string' || !ref)
    throw bad(
      'PARENT_MISSING',
      `The ${want === 'group' ? 'resource group' : 'SQL server'} is not created yet.`
    )
  const p = pinnedId(ctx, ref)
  if (want === 'group' ? !!p.server : !p.server || !!p.child)
    throw bad('BAD_ID', `The ${field} is not a ${want} id.`)
  return p
}

/** A write on an existing child must be under the parent the desired state names. */
function sameParent(ctx: ProviderContext, externalId: string, desired: DesiredResource): void {
  const p = pinnedId(ctx, externalId)
  const ref = desired.refs?.server
  if (typeof ref === 'string' && ref) {
    const parent = pinnedId(ctx, ref)
    if (lc(serverId(parent.sub, parent.group, parent.server as string)) !== lc(idOfServer(p) ?? ''))
      throw bad('PARENT_MISMATCH', 'That resource does not belong to the server this change names.')
  }
}

/** The id a create would make, from the desired fields and refs (null = not known yet). */
export function createIdOf(ctx: ProviderContext, desired: DesiredResource): string | null {
  const name = str(desired.fields.name)
  if (!name) return null
  if (desired.type === RG) {
    const sub = pinnedSub(ctx, desired.fields.subscription_id)
    return groupId(sub, name)
  }
  if (desired.type === BUDGET) {
    return budgetId(pinnedSub(ctx, desired.fields.subscription_id), name)
  }
  if (desired.type === SRV) {
    const ref = desired.refs?.resource_group
    if (typeof ref !== 'string') return null
    const g = pinnedId(ctx, ref)
    return serverId(g.sub, g.group, name.toLowerCase())
  }
  const ref = desired.refs?.server
  if (typeof ref !== 'string') return null
  const s = pinnedId(ctx, ref)
  const sid = serverId(s.sub, s.group, s.server as string)
  if (desired.type === DB) return childId(sid, 'databases', name)
  if (desired.type === FW) return childId(sid, 'firewallRules', name)
  return null
}

export async function findExistingAzure(
  ctx: ProviderContext,
  type: string,
  desired: DesiredResource
): Promise<Observed | null> {
  if (desired.externalId) return null
  const id = createIdOf(ctx, desired)
  if (!id) return null
  return observeAzure(ctx, type, id)
}

/** Waits (bounded) until a resource's own provisioning state is terminal. */
async function settle(
  ctx: ProviderContext,
  id: string,
  version: string,
  stateOf: (raw: Obj) => string | null,
  okStates: string[]
): Promise<Obj | null> {
  let raw: Obj | null = null
  for (let i = 0; i < 40; i++) {
    raw = await getRaw(ctx, id, version)
    if (!raw) return null
    const s = stateOf(raw)
    if (!s || okStates.includes(s)) return raw
    if (['Failed', 'Canceled'].includes(s))
      throw bad('OPERATION_FAILED', `Azure reports the resource as ${s.toLowerCase()}.`)
    await sleep(i === 0 ? 300 : 2000, ctx.signal)
  }
  throw bad(
    'OPERATION_PENDING',
    'Azure is still working on the resource; it will be checked again.',
    true
  )
}

const wait = { wait: true } as const

// ── Resource group ──

async function applyGroup(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const p = pinnedId(ctx, op.externalId)
    expectKind(RG, p)
    const id = groupId(p.sub, p.group)
    if (!(await getRaw(ctx, id, API.resources))) return ok(id, null, { status: 404 })
    const inside = await armList(ctx, `${id}/resources`, armVersion(API.resources))
    if (inside.length)
      throw bad(
        'GROUP_NOT_EMPTY',
        `The resource group still holds ${inside.length} resource${inside.length === 1 ? '' : 's'}: empty it first, the Hub never deletes a group with anything in it.`
      )
    await armCall(ctx, 'DELETE', id, { query: armVersion(API.resources), allow: [404], ...wait })
    return ok(id, null, { status: 200 })
  }
  if (!desired) throw bad('INVALID', 'A change needs the wanted values.')
  if (op.kind === 'create') {
    const id = createIdOf(ctx, desired)
    const location = str(desired.fields.location)
    if (!id || !location)
      throw bad('INVALID', 'A resource group needs a name, a subscription and a location.')
    const found = await getRaw(ctx, id, API.resources)
    if (found && !desired.externalId)
      throw bad(
        'ALREADY_EXISTS',
        'A resource group with that name already exists: adopt it instead.'
      )
    if (!found)
      await armCall(ctx, 'PUT', id, {
        query: armVersion(API.resources),
        body: { location, tags: azureTags(desired.tags) },
        ...wait
      })
    const raw = await settle(
      ctx,
      id,
      API.resources,
      (r) => str(asObj(r.properties).provisioningState),
      ['Succeeded']
    )
    return ok(id, raw ? observedGroup(raw) : null, { status: found ? 200 : 201 })
  }
  // A group has nothing else to change.
  const seen = op.externalId ? await observeAzure(ctx, RG, op.externalId) : null
  return ok(op.externalId, seen, { status: 200 })
}

// ── SQL server ──

const sqlPassword = () => `${randomBytes(18).toString('base64url')}aA1`

/** ADO.NET value quoting: braces, with any `}` doubled. */
const adoQuote = (v: string) => `{${v.replace(/}/g, '}}')}}`

function connectionString(
  server: string,
  database: string,
  login: string,
  password: string
): string {
  const bad = databaseProblem(database) ?? loginProblem(login)
  if (bad) throw new ProviderError('INVALID_FIELDS', bad)
  if (!/^[a-z0-9.-]+$/i.test(server))
    throw new ProviderError('INVALID_FIELDS', 'Azure answered a server address the Hub cannot use.')
  const pw = /[;{}="'\s]/.test(password) ? adoQuote(password) : password
  return `Server=tcp:${server},1433;Initial Catalog=${database};Persist Security Info=False;User ID=${login};Password=${pw};MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;`
}

function entraAdmin(ctx: ProviderContext, f: Obj, onlyAuth: boolean): Obj | null {
  const login = str(f.entra_admin_login)
  const sid = str(f.entra_admin_object_id)
  if (!login || !sid) return null
  return {
    administratorType: 'ActiveDirectory',
    principalType: str(f.entra_admin_type) ?? 'Group',
    login,
    sid,
    tenantId: str(ctx.config.tenant_id) ?? undefined,
    azureADOnlyAuthentication: onlyAuth
  }
}

const SERVER_STATES = ['Ready']

async function applyServer(
  ctx0: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const plain = str(asObj(desired?.fields.admin_password).plain)
  const ctx = withScrub(ctx0, plain ? [plain] : [])
  if (op.kind === 'delete') {
    const p = pinnedId(ctx, op.externalId)
    expectKind(SRV, p)
    const id = serverId(p.sub, p.group, p.server as string)
    if (!(await getRaw(ctx, id, API.sql))) return ok(id, null, { status: 404 })
    const dbs = (await armList(ctx, `${id}/databases`, armVersion(API.sql))).filter(
      (d) => lc(d?.name) !== 'master'
    )
    if (dbs.length)
      throw bad(
        'SERVER_NOT_EMPTY',
        `The server still holds ${dbs.length} database${dbs.length === 1 ? '' : 's'}: delete them first.`
      )
    await armCall(ctx, 'DELETE', id, { query: armVersion(API.sql), allow: [404], ...wait })
    return ok(id, null, { status: 200 })
  }
  if (!desired) throw bad('INVALID', 'A change needs the wanted values.')
  const f = desired.fields
  const wrong = fieldProblem(desired)
  if (wrong) throw bad('INVALID_FIELDS', wrong)

  if (op.kind === 'create') {
    const group = parentRef(ctx, desired, 'resource_group', 'group')
    const name = str(f.name)
    const location = str(f.location)
    if (!name || !location) throw bad('INVALID', 'A SQL server needs a name and a location.')
    const id = serverId(group.sub, group.group, name.toLowerCase())
    const found = await getRaw(ctx, id, API.sql)
    if (found && !desired.externalId)
      throw bad('ALREADY_EXISTS', 'A SQL server with that name already exists: adopt it instead.')
    const entraOnly = f.entra_only_auth !== false
    const entra = entraAdmin(ctx, f, entraOnly)
    if (entraOnly && !entra)
      throw bad('INVALID', 'An Entra-only server needs an Entra admin (login and object id).')
    let password: string | null = null
    let created = false
    if (!found) {
      const props: Obj = {
        version: '12.0',
        minimalTlsVersion: str(f.minimal_tls_version) ?? '1.2',
        publicNetworkAccess: f.public_network_access === true ? 'Enabled' : 'Disabled'
      }
      if (entra) props.administrators = entra
      if (!entraOnly) {
        password = plain ?? sqlPassword()
        props.administratorLogin = str(f.sql_admin_login) ?? 'nivarohub'
        props.administratorLoginPassword = password
      }
      const guarded = withScrub(ctx, password ? [password] : [])
      await armCall(guarded, 'PUT', id, {
        query: armVersion(API.sql),
        body: { location, tags: azureTags(desired.tags), properties: props },
        ...wait
      })
      created = true
    }
    const raw = await settle(ctx, id, API.sql, (r) => str(asObj(r.properties).state), SERVER_STATES)
    const observed = raw ? observedServer(raw) : null
    const outputs: Record<string, string> = {}
    const fqdn = str(observed?.fields.fqdn)
    if (fqdn) outputs.server_fqdn = fqdn
    if (created && password && fqdn)
      outputs.connection_string = connectionString(
        fqdn,
        str(f.app_database) ?? 'master',
        str(f.sql_admin_login) ?? 'nivarohub',
        password
      )
    return ok(id, observed, { status: created ? 201 : 200 }, outputs)
  }

  const p = pinnedId(ctx, op.externalId)
  expectKind(SRV, p)
  const id = serverId(p.sub, p.group, p.server as string)
  if (desired.externalId && lc(desired.externalId) !== lc(id))
    throw bad('TARGET_MISMATCH', 'That server is not the one this change names.')
  const current = await getRaw(ctx, id, API.sql)
  if (!current) throw bad('NOT_FOUND', 'The SQL server is gone at Azure.')

  if (op.action === ROTATE) {
    const cur = observedServer(current)
    if (cur.fields.entra_only_auth === true || !cur.fields.sql_admin_login)
      throw bad(
        'ENTRA_ONLY',
        'This server signs in through Entra only: there is no SQL admin password to rotate.'
      )
    // Refuse before the password changes: a string that cannot be built would lose the new one.
    const unusable =
      loginProblem(cur.fields.sql_admin_login) ?? databaseProblem(str(f.app_database) ?? 'master')
    if (unusable) throw bad('INVALID_FIELDS', unusable)
    const next = sqlPassword()
    await armCall(withScrub(ctx, [next]), 'PATCH', id, {
      query: armVersion(API.sql),
      body: { properties: { administratorLoginPassword: next } },
      ...wait
    })
    const raw = await settle(ctx, id, API.sql, (r) => str(asObj(r.properties).state), SERVER_STATES)
    const observed = raw ? observedServer(raw) : cur
    const outputs: Record<string, string> = {}
    const fqdn = str(observed.fields.fqdn)
    if (fqdn)
      outputs.connection_string = connectionString(
        fqdn,
        str(f.app_database) ?? 'master',
        String(cur.fields.sql_admin_login),
        next
      )
    return ok(id, observed, { status: 200 }, outputs)
  }

  // A plain update: only what differs.
  const have = observedServer(current).fields
  const props: Obj = {}
  if (f.minimal_tls_version && !same(f.minimal_tls_version, have.minimal_tls_version))
    props.minimalTlsVersion = String(f.minimal_tls_version)
  if (
    typeof f.public_network_access === 'boolean' &&
    f.public_network_access !== have.public_network_access
  )
    props.publicNetworkAccess = f.public_network_access ? 'Enabled' : 'Disabled'
  const wantOnly =
    typeof f.entra_only_auth === 'boolean' ? f.entra_only_auth : have.entra_only_auth === true
  const entraChanged =
    (f.entra_admin_login && !same(f.entra_admin_login, have.entra_admin_login)) ||
    (f.entra_admin_object_id && !same(f.entra_admin_object_id, have.entra_admin_object_id)) ||
    wantOnly !== (have.entra_only_auth === true)
  if (entraChanged) {
    const merged = {
      ...f,
      entra_admin_login: f.entra_admin_login ?? have.entra_admin_login,
      entra_admin_object_id: f.entra_admin_object_id ?? have.entra_admin_object_id
    }
    const entra = entraAdmin(ctx, merged, wantOnly)
    if (!entra) throw bad('INVALID', 'The Entra admin needs a login and an object id.')
    props.administrators = entra
  }
  if (Object.keys(props).length)
    await armCall(ctx, 'PATCH', id, {
      query: armVersion(API.sql),
      body: { properties: props },
      ...wait
    })
  const raw = await settle(ctx, id, API.sql, (r) => str(asObj(r.properties).state), SERVER_STATES)
  return ok(id, raw ? observedServer(raw) : null, { status: 200 })
}

// ── Firewall rule ──

async function applyRule(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const p = pinnedId(ctx, op.externalId)
    expectKind(FW, p)
    const id = childId(
      serverId(p.sub, p.group, p.server as string),
      'firewallRules',
      (p.child as { name: string }).name
    )
    await armCall(ctx, 'DELETE', id, { query: armVersion(API.sql), allow: [404], ...wait })
    return ok(id, null, { status: 200 })
  }
  if (!desired) throw bad('INVALID', 'A change needs the wanted values.')
  const start = str(desired.fields.start_ip_address)
  const end = str(desired.fields.end_ip_address)
  if (!validRange(start, end))
    throw bad(
      'BAD_RANGE',
      'A firewall rule needs a start and an end IPv4 address, the start not after the end.'
    )
  const body = { properties: { startIpAddress: start, endIpAddress: end } }
  if (op.kind === 'create') {
    const id = createIdOf(ctx, desired)
    if (!id) throw bad('INVALID', 'A firewall rule needs a name and a server.')
    const found = await getRaw(ctx, id, API.sql)
    if (found && !desired.externalId)
      throw bad(
        'ALREADY_EXISTS',
        'A firewall rule with that name already exists: adopt it instead.'
      )
    if (!found || desired.externalId)
      await armCall(ctx, 'PUT', id, { query: armVersion(API.sql), body, ...wait })
    const raw = await getRaw(ctx, id, API.sql)
    return ok(id, raw ? observedRule(raw) : null, { status: found ? 200 : 201 })
  }
  const p = pinnedId(ctx, op.externalId)
  expectKind(FW, p)
  sameParent(ctx, op.externalId as string, desired)
  const id = childId(
    serverId(p.sub, p.group, p.server as string),
    'firewallRules',
    (p.child as { name: string }).name
  )
  if (!(await getRaw(ctx, id, API.sql)))
    throw bad('NOT_FOUND', 'The firewall rule is gone at Azure.')
  await armCall(ctx, 'PUT', id, { query: armVersion(API.sql), body, ...wait })
  const raw = await getRaw(ctx, id, API.sql)
  return ok(id, raw ? observedRule(raw) : null, { status: 200 })
}

// ── Database ──

const dbBody = (f: Obj, location: string | null, tags: Record<string, string> | null): Obj => {
  const sku = skuOf(f.sku_name)
  if (!sku) throw bad('INVALID', 'Choose one of the database sizes the Hub offers.')
  const skuBody: Obj = { name: sku.armName, tier: sku.tier }
  if (sku.family) skuBody.family = sku.family
  if (sku.model !== 'dtu') {
    const c = num(f.capacity)
    if (!c || c <= 0) throw bad('INVALID', 'A vCore database needs its number of vCores.')
    skuBody.capacity = c
  }
  const props: Obj = {}
  const gb = num(f.max_size_gb)
  if (gb && gb > 0) props.maxSizeBytes = Math.round(gb * GIB)
  return {
    ...(location ? { location } : {}),
    ...(tags ? { tags } : {}),
    sku: skuBody,
    properties: props
  }
}

async function putRetention(
  ctx: ProviderContext,
  dbId: string,
  days: number | null
): Promise<void> {
  if (days == null) return
  await armCall(ctx, 'PUT', `${dbId}/backupShortTermRetentionPolicies/default`, {
    query: armVersion(API.sql),
    body: { properties: { retentionDays: days } },
    ...wait
  })
}

async function applyDatabase(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const p = pinnedId(ctx, op.externalId)
    expectKind(DB, p)
    const child = p.child as { name: string }
    if (lc(child.name) === 'master')
      throw bad('SYSTEM_DATABASE', 'The master database cannot be deleted.')
    const id = childId(serverId(p.sub, p.group, p.server as string), 'databases', child.name)
    if (!(await getRaw(ctx, id, API.sql))) return ok(id, null, { status: 404 })
    await armCall(ctx, 'DELETE', id, { query: armVersion(API.sql), allow: [404], ...wait })
    return ok(id, null, { status: 200 })
  }
  if (!desired) throw bad('INVALID', 'A change needs the wanted values.')
  const f = desired.fields
  const retention = num(f.backup_retention_days)
  if (op.kind === 'create') {
    const server = parentRef(ctx, desired, 'server', 'server')
    const name = str(f.name)
    if (!name) throw bad('INVALID', 'A database needs a name.')
    if (lc(name) === 'master') throw bad('SYSTEM_DATABASE', 'The master database is Azure’s own.')
    const sid = serverId(server.sub, server.group, server.server as string)
    const id = childId(sid, 'databases', name)
    const found = await getRaw(ctx, id, API.sql)
    if (found && !desired.externalId)
      throw bad(
        'ALREADY_EXISTS',
        'A database with that name already exists on the server: adopt it instead.'
      )
    if (!found) {
      const srv = await getRaw(ctx, sid, API.sql)
      const location = str(srv?.location)
      if (!location) throw bad('NOT_FOUND', 'The SQL server is gone at Azure.')
      await armCall(ctx, 'PUT', id, {
        query: armVersion(API.sql),
        body: dbBody(f, location, azureTags(desired.tags)),
        ...wait
      })
    }
    const raw = await settle(ctx, id, API.sql, (r) => str(asObj(r.properties).status), [
      'Online',
      'Standby',
      'Paused'
    ])
    if (!found || desired.externalId) await putRetention(ctx, id, retention)
    return ok(id, raw ? observedDatabase(raw, await retentionOf(ctx, id)) : null, {
      status: found ? 200 : 201
    })
  }
  const p = pinnedId(ctx, op.externalId)
  expectKind(DB, p)
  sameParent(ctx, op.externalId as string, desired)
  const child = p.child as { name: string }
  if (lc(child.name) === 'master')
    throw bad('SYSTEM_DATABASE', 'The master database is Azure’s own.')
  const id = childId(serverId(p.sub, p.group, p.server as string), 'databases', child.name)
  const current = await getRaw(ctx, id, API.sql)
  if (!current) throw bad('NOT_FOUND', 'The database is gone at Azure.')
  const have = observedDatabase(current, undefined).fields
  const sizeChanged =
    (f.sku_name && !same(f.sku_name, have.sku_name)) ||
    (f.capacity != null && have.capacity != null && Number(f.capacity) !== Number(have.capacity)) ||
    (f.max_size_gb != null && Number(f.max_size_gb) !== Number(have.max_size_gb))
  if (sizeChanged) {
    // Name, family and tier follow the wanted size; what the person did not set stays as Azure has it.
    const merged = {
      ...have,
      ...Object.fromEntries(Object.entries(f).filter(([, v]) => v != null && v !== ''))
    }
    const body = dbBody(merged, null, null)
    await armCall(ctx, 'PATCH', id, { query: armVersion(API.sql), body, ...wait })
  }
  if (retention != null && retention !== (await retentionOf(ctx, id)))
    await putRetention(ctx, id, retention)
  const raw = await settle(ctx, id, API.sql, (r) => str(asObj(r.properties).status), [
    'Online',
    'Standby',
    'Paused'
  ])
  return ok(id, raw ? observedDatabase(raw, await retentionOf(ctx, id)) : null, { status: 200 })
}

/** A recorded restore point: Azure keeps point-in-time restore for the retention window. */
export async function snapshotDatabase(
  ctx: ProviderContext,
  type: string,
  externalId: string
): Promise<SnapshotRef> {
  if (type !== DB) throw bad('NO_SNAPSHOT', 'Only a database has a restore point.')
  const p = pinnedId(ctx, externalId)
  expectKind(DB, p)
  const child = p.child as { name: string }
  const id = childId(serverId(p.sub, p.group, p.server as string), 'databases', child.name)
  const raw = await getRaw(ctx, id, API.sql)
  if (!raw) throw bad('NOT_FOUND', 'The database is gone at Azure.')
  const days = await retentionOf(ctx, id)
  if (days !== null && days < 1)
    throw bad(
      'NO_RESTORE_POINT',
      'Backups are not kept for this database (retention is 0 days): there is nothing to restore from.'
    )
  const at = ctx.now().toISOString()
  return {
    kind: 'restore_point',
    id: `${id}@${at}`,
    label: `Point-in-time restore of ${child.name} to ${at}${days ? ` (kept ${days} days)` : ''}`,
    createdAt: at
  }
}

// ── Budget ──

async function applyBudget(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'delete') {
    const b = pinnedBudget(ctx, op.externalId)
    const id = budgetId(b.sub, b.name)
    await armCall(ctx, 'DELETE', id, { query: armVersion(API.budget), allow: [404] })
    return ok(id, null, { status: 200 })
  }
  if (!desired) throw bad('INVALID', 'A change needs the wanted values.')
  const f = desired.fields
  const wrongBudget = fieldProblem(desired)
  if (wrongBudget) throw bad('INVALID_FIELDS', wrongBudget)
  const appTag = ownerTag(desired)
  const amount = num(f.amount)
  const emails = Array.isArray(f.contact_emails) ? f.contact_emails.map(String).filter(Boolean) : []
  if (!appTag) throw bad('INVALID', 'A budget names the app tag value it counts (nivaro-hub-app).')
  if (!amount || amount <= 0) throw bad('INVALID', 'A budget needs an amount above zero.')
  if (!emails.length) throw bad('INVALID', 'A budget needs at least one contact email.')
  const thresholds = (Array.isArray(f.thresholds) && f.thresholds.length ? f.thresholds : [80, 100])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 1000)
  const notifications: Obj = {}
  for (const t of thresholds)
    notifications[`Actual_GreaterThan_${t}_Percent`] = {
      enabled: true,
      operator: 'GreaterThan',
      threshold: t,
      thresholdType: 'Actual',
      contactEmails: emails
    }
  const make = (startDate: string) => ({
    properties: {
      category: 'Cost',
      amount,
      timeGrain: 'Monthly',
      timePeriod: { startDate, endDate: `${Number(startDate.slice(0, 4)) + 5}-12-31T00:00:00Z` },
      filter: { tags: { name: 'nivaro-hub-app', operator: 'In', values: [appTag] } },
      notifications
    }
  })
  if (op.kind === 'create') {
    const sub = pinnedSub(ctx, f.subscription_id)
    const name = str(f.name)
    if (!name) throw bad('INVALID', 'A budget needs a name.')
    const id = budgetId(sub, name)
    const found = await getRaw(ctx, id, API.budget)
    if (found && !desired.externalId)
      throw bad('ALREADY_EXISTS', 'A budget with that name already exists: adopt it instead.')
    if (!found) {
      const now = ctx.now()
      const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00Z`
      await armCall(ctx, 'PUT', id, { query: armVersion(API.budget), body: make(start) })
    }
    const raw = await getRaw(ctx, id, API.budget)
    return ok(id, raw ? observedBudget(raw) : null, { status: found ? 200 : 201 })
  }
  const b = pinnedBudget(ctx, op.externalId)
  const id = budgetId(b.sub, b.name)
  const current = await getRaw(ctx, id, API.budget)
  if (!current) throw bad('NOT_FOUND', 'The budget is gone at Azure.')
  const start = str(asObj(asObj(current.properties).timePeriod).startDate) ?? ''
  if (!start) throw bad('INVALID', 'The budget has no start date.')
  await armCall(ctx, 'PUT', id, { query: armVersion(API.budget), body: make(start) })
  const raw = await getRaw(ctx, id, API.budget)
  return ok(id, raw ? observedBudget(raw) : null, { status: 200 })
}

export async function applyAzure(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'noop') {
    const seen = op.externalId ? await observeAzure(ctx, op.type, op.externalId) : null
    return ok(op.externalId, seen, { status: 200 })
  }
  if (op.kind === 'replace')
    throw bad('INVALID', 'Azure resources here are changed in place, not replaced.')
  if (op.data && (op.data as Obj).$blocker)
    throw bad(
      String(asObj((op.data as Obj).$blocker).code),
      String(asObj((op.data as Obj).$blocker).message)
    )
  if (op.type === PE)
    throw bad(
      'READ_ONLY_TYPE',
      'A private endpoint connection is read and adopted here, never changed.'
    )
  switch (op.type) {
    case RG:
      return applyGroup(ctx, op, desired)
    case SRV:
      return applyServer(ctx, op, desired)
    case FW:
      return applyRule(ctx, op, desired)
    case DB:
      return applyDatabase(ctx, op, desired)
    case BUDGET:
      return applyBudget(ctx, op, desired)
    default:
      throw bad('UNKNOWN_TYPE', `Azure has no resource type ${op.type}.`)
  }
}

export async function readOutputsAzure(
  ctx: ProviderContext,
  type: string,
  externalId: string
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (type !== SRV) return out
  const seen = await observeAzure(ctx, SRV, externalId)
  const fqdn = str(seen?.fields.fqdn)
  if (fqdn) out.server_fqdn = fqdn
  return out
}

// ── Health ──

/** The budget alert: crossing a threshold of the amount sends `cost.over_budget` through the Hub's routes. */
export async function healthBudget(
  ctx: ProviderContext,
  externalId: string,
  appId: number | null = null
): Promise<HealthAnswer> {
  const checkedAt = ctx.now().toISOString()
  const b = pinnedBudget(ctx, externalId)
  const raw = await getRaw(ctx, budgetId(b.sub, b.name), API.budget)
  if (!raw) return { status: 'down', message: 'The budget is gone at Azure.', checkedAt }
  const props = asObj(raw.properties)
  const amount = num(props.amount)
  const spend = num(asObj(props.currentSpend).amount)
  const unit = str(asObj(props.currentSpend).unit) ?? ''
  const seen = observedBudget(raw)
  const thresholds = (seen.fields.thresholds as number[]) ?? []
  if (!amount || spend == null)
    return {
      status: 'unknown',
      message: 'Azure has no spend figure for this budget yet.',
      checkedAt
    }
  const pct = Math.round((spend / amount) * 1000) / 10
  const crossed = [...thresholds].sort((x, y) => y - x).find((t) => pct >= t) ?? null
  const details = { spend, amount, percent: pct }
  if (crossed === null) return { status: 'ok', checkedAt, details }
  const month = checkedAt.slice(0, 7)
  const { notifyHub } = await import('../notify.js')
  void notifyHub('cost.over_budget', {
    ...(appId != null ? { appId } : {}),
    title: `Azure budget ${str(seen.name)} at ${pct}% (${crossed}% alert)`,
    body: `Azure counts ${spend.toFixed(2)} ${unit} against a budget of ${amount.toFixed(2)} ${unit} this month.`,
    severity: crossed >= 100 ? 'critical' : 'warning',
    dedupKey: `azure-budget:${externalId.toLowerCase()}:${month}:${crossed}`
  })
  return {
    status: crossed >= 100 ? 'down' : 'warn',
    message: `At ${pct}% of the monthly budget (the ${crossed}% alert).`,
    checkedAt,
    details
  }
}

export async function healthAzure(
  ctx: ProviderContext,
  type: string,
  externalId: string,
  resource?: { appId: number | null }
): Promise<HealthAnswer> {
  if (type === BUDGET) return healthBudget(ctx, externalId, resource?.appId ?? null)
  const checkedAt = ctx.now().toISOString()
  const seen = await observeAzure(ctx, type, externalId)
  if (!seen) return { status: 'down', message: 'It is gone at Azure.', checkedAt }
  const s = String(seen.status ?? '')
  if (!s || ['Succeeded', 'Ready', 'Online', 'Approved'].includes(s))
    return { status: 'ok', checkedAt }
  if (['Failed', 'Canceled', 'Offline', 'Disabled', 'Rejected'].includes(s))
    return { status: 'down', message: `Azure reports ${s.toLowerCase()}.`, checkedAt }
  return { status: 'warn', message: `Azure reports ${s.toLowerCase()}.`, checkedAt }
}

export { isArmUrl, OUT_OF_ACCOUNT }
