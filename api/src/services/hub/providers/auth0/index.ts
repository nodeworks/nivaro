import { fieldWords, typedName } from '../plan-words.js'
import type {
  ConnectionTest,
  DesiredResource,
  FieldChange,
  FieldSpec,
  ListPage,
  Observed,
  OpResult,
  PlannedOp,
  ProviderAdapter,
  ProviderContext,
  ResourceTypeSpec,
  RiskFlag
} from '../types.js'
import { ProviderError } from '../types.js'
import {
  audienceProblem,
  CONNECTION_FIELDS,
  domainAllowed,
  domainOf,
  managementToken,
  mgmt,
  mintToken,
  tokenScopes
} from './client.js'
import { AUTH0_BUNDLED, auth0Estimate } from './pricing.js'

/**
 * Auth0 provider (Hub third-party providers, Task 9). Types: auth0.application (callbacks, allowed
 * origins, logout URLs), auth0.api (resource server) and auth0.connection_binding (a connection
 * enabled for an application). All three are app-scoped.
 *
 * Secrets: the Management API answers an application with its `client_secret` (and signing keys).
 * Every observed value is built from an explicit whitelist, so none of them can reach `Observed`,
 * an op's `changes` or an `OpResult`; the client secret is never read back, by design.
 *
 * Replace (an API's identifier, a binding's client or connection): `apply` of a `replace` op
 * deletes the old resource and creates the new one itself.
 */

const APP = 'auth0.application'
const API = 'auth0.api'
const BINDING = 'auth0.connection_binding'
const PAGE = 50
const TAG_PREFIX = 'nivaro-hub:'
const META_PREFIX = 'nivaro_hub_'

type Obj = Record<string, unknown>

const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const textItem: FieldSpec = { key: 'item', label: 'Value', kind: 'string' }
const urlList = (key: string, label: string, help: string): FieldSpec => ({
  key,
  label,
  kind: 'list',
  items: textItem,
  help
})

// ── Specs ──

const applicationFields: FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'string', required: true },
  {
    key: 'app_type',
    label: 'Application type',
    kind: 'enum',
    default: 'regular_web',
    options: [
      { value: 'regular_web', label: 'Regular web application' },
      { value: 'spa', label: 'Single page application' },
      { value: 'native', label: 'Native' },
      { value: 'non_interactive', label: 'Machine to machine' }
    ]
  },
  { key: 'description', label: 'Description', kind: 'string' },
  urlList('callbacks', 'Allowed callback URLs', 'Where Auth0 may send people after they sign in.'),
  urlList(
    'allowed_logout_urls',
    'Allowed logout URLs',
    'Where Auth0 may send people after they sign out.'
  ),
  urlList(
    'allowed_origins',
    'Allowed origins (CORS)',
    'Origins that may call Auth0 from the browser.'
  ),
  urlList('web_origins', 'Allowed web origins', 'Origins allowed to use silent sign-in checks.'),
  { key: 'client_id', label: 'Client ID', kind: 'string', readOnly: true }
]

const apiFields: FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'string', required: true },
  {
    key: 'identifier',
    label: 'Identifier (audience)',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    help: 'The API’s audience, usually its URL. It cannot be changed later.'
  },
  {
    key: 'signing_alg',
    label: 'Signing algorithm',
    kind: 'enum',
    default: 'RS256',
    options: [
      { value: 'RS256', label: 'RS256' },
      { value: 'PS256', label: 'PS256' },
      { value: 'HS256', label: 'HS256' }
    ]
  },
  {
    key: 'token_lifetime',
    label: 'Token lifetime (seconds)',
    kind: 'number',
    min: 1,
    max: 2592000
  },
  { key: 'allow_offline_access', label: 'Allow refresh tokens', kind: 'boolean', default: false },
  {
    key: 'scopes',
    label: 'Permissions (scopes)',
    kind: 'list',
    items: {
      key: 'scope',
      label: 'Permission',
      kind: 'object',
      fields: [
        { key: 'value', label: 'Value', kind: 'string', required: true },
        { key: 'description', label: 'Description', kind: 'string' }
      ]
    }
  }
]

const bindingFields: FieldSpec[] = [
  {
    key: 'client',
    label: 'Application',
    kind: 'ref',
    refType: APP,
    required: true,
    replaceOnChange: true
  },
  {
    key: 'connection_id',
    label: 'Connection ID',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    pattern: '^[A-Za-z0-9_-]+$',
    help: 'The Auth0 connection’s id (con_…), from the connection’s settings page.'
  },
  { key: 'connection_name', label: 'Connection', kind: 'string', readOnly: true }
]

const URL_FIELDS = ['callbacks', 'allowed_logout_urls', 'allowed_origins', 'web_origins']

function isRisky(url: string): boolean {
  if (url.includes('*')) return true
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

function riskApp(op: PlannedOp): RiskFlag[] {
  const flags = new Set<RiskFlag>()
  if (op.kind === 'delete' || op.kind === 'replace') {
    flags.add('destructive')
    flags.add('downtime')
  }
  for (const c of op.changes) {
    if (!URL_FIELDS.includes(c.field)) continue
    const before = new Set(strs(c.from))
    // A wildcard or plain-http (non-local) address that was not allowed before widens who can
    // receive sign-in tokens.
    if (strs(c.to).some((u) => !before.has(u) && isRisky(u))) flags.add('public_exposure')
  }
  return [...flags]
}

function riskApi(op: PlannedOp): RiskFlag[] {
  const flags = new Set<RiskFlag>()
  if (op.kind === 'delete' || op.kind === 'replace') flags.add('destructive')
  if (op.changes.some((c) => c.field === 'signing_alg') && op.kind === 'update')
    flags.add('downtime')
  return [...flags]
}

function riskBinding(op: PlannedOp): RiskFlag[] {
  // Removing a connection from an application stops people who sign in through it.
  return op.kind === 'delete' || op.kind === 'replace' ? ['downtime'] : []
}

const types: ResourceTypeSpec[] = [
  {
    key: APP,
    label: 'Auth0 application',
    scope: 'app',
    fields: applicationFields,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: true
    },
    reversible: true,
    refs: [],
    risk: (op) => riskApp(op),
    estimate: auth0Estimate
  },
  {
    key: API,
    label: 'Auth0 API',
    scope: 'app',
    fields: apiFields,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: (field) => field !== 'identifier',
    refs: [],
    risk: (op) => riskApi(op),
    estimate: auth0Estimate
  },
  {
    key: BINDING,
    label: 'Enabled connection',
    scope: 'app',
    fields: bindingFields,
    capabilities: {
      create: true,
      update: false,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: true,
    refs: [{ field: 'client', type: APP, required: true }],
    nameField: 'connection_id',
    risk: (op) => riskBinding(op),
    estimate: auth0Estimate
  }
]

// ── Observed (whitelists: nothing outside these lists is ever copied) ──

function tagsFromMeta(meta: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(asObj(meta)))
    if (k.startsWith(META_PREFIX) && typeof v === 'string')
      out[`${TAG_PREFIX}${k.slice(META_PREFIX.length)}`] = v
  return out
}

function metaFromTags(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(tags))
    if (k.startsWith(TAG_PREFIX)) out[`${META_PREFIX}${k.slice(TAG_PREFIX.length)}`] = String(v)
  return out
}

function observedApp(raw: unknown): Observed {
  const o = asObj(raw)
  // `client_secret`, `signing_keys`, `encryption_key` and `jwt_configuration` are never read.
  const id = str(o.client_id) ?? ''
  return {
    type: APP,
    externalId: id,
    name: str(o.name),
    fields: {
      client_id: id,
      name: str(o.name),
      app_type: str(o.app_type),
      description: str(o.description),
      callbacks: strs(o.callbacks),
      allowed_logout_urls: strs(o.allowed_logout_urls),
      allowed_origins: strs(o.allowed_origins),
      web_origins: strs(o.web_origins)
    },
    tags: tagsFromMeta(o.client_metadata),
    url: id ? `https://manage.auth0.com/#/applications/${encodeURIComponent(id)}/settings` : null
  }
}

function observedApi(raw: unknown): Observed {
  const o = asObj(raw)
  // `signing_secret` is never read.
  const id = str(o.id) ?? ''
  return {
    type: API,
    externalId: id,
    name: str(o.name),
    fields: {
      name: str(o.name),
      identifier: str(o.identifier),
      signing_alg: str(o.signing_alg),
      token_lifetime: typeof o.token_lifetime === 'number' ? o.token_lifetime : null,
      allow_offline_access: o.allow_offline_access === true,
      scopes: (Array.isArray(o.scopes) ? o.scopes : []).map((s) => ({
        value: str(asObj(s).value) ?? '',
        description: str(asObj(s).description) ?? ''
      }))
    },
    tags: {},
    url: id ? `https://manage.auth0.com/#/apis/${encodeURIComponent(id)}/settings` : null
  }
}

function bindingId(connectionId: string, clientId: string): string {
  return `${connectionId}:${clientId}`
}

function splitBindingId(externalId: string): { connectionId: string; clientId: string } | null {
  const i = externalId.indexOf(':')
  if (i <= 0 || i === externalId.length - 1) return null
  return { connectionId: externalId.slice(0, i), clientId: externalId.slice(i + 1) }
}

function observedBinding(connectionId: string, connectionName: string | null, clientId: string) {
  return {
    type: BINDING,
    externalId: bindingId(connectionId, clientId),
    name: `${connectionName ?? connectionId} · ${clientId}`,
    fields: { client: clientId, connection_id: connectionId, connection_name: connectionName },
    tags: {},
    url: `https://manage.auth0.com/#/connections/${encodeURIComponent(connectionId)}/clients`
  } satisfies Observed
}

// ── Plain REST types (application, api) ──

interface CrudType {
  type: string
  path: string
  /** Comma list sent as `fields`, so secrets are not even asked for. */
  fieldsQuery: string
  /** Writable fields compared by the diff, in order. */
  writable: string[]
  replaceOn: string[]
  tags: boolean
  toObserved(raw: unknown): Observed
  isListed(raw: unknown): boolean
  createBody(fields: Obj): Obj
  patchValue(field: string, to: unknown): unknown
}

const scopeList = (v: unknown): Array<{ value: string; description: string }> =>
  (Array.isArray(v) ? v : []).map((s) => ({
    value: String(asObj(s).value ?? ''),
    description: String(asObj(s).description ?? '')
  }))

const CRUD: Record<string, CrudType> = {
  [APP]: {
    type: APP,
    path: '/clients',
    fieldsQuery:
      'client_id,name,description,app_type,callbacks,allowed_logout_urls,allowed_origins,web_origins,client_metadata,global',
    writable: ['name', 'app_type', 'description', ...URL_FIELDS],
    replaceOn: [],
    tags: true,
    toObserved: observedApp,
    isListed: (raw) => asObj(raw).global !== true,
    createBody(f) {
      const body: Obj = {}
      for (const k of ['name', 'app_type', 'description']) if (str(f[k])) body[k] = f[k]
      for (const k of URL_FIELDS) if (Array.isArray(f[k])) body[k] = strs(f[k])
      if (!body.app_type) body.app_type = 'regular_web'
      return body
    },
    patchValue: (field, to) => (URL_FIELDS.includes(field) ? strs(to) : (to ?? ''))
  },
  [API]: {
    type: API,
    path: '/resource-servers',
    fieldsQuery: '',
    writable: ['name', 'signing_alg', 'token_lifetime', 'allow_offline_access', 'scopes'],
    replaceOn: ['identifier'],
    tags: false,
    toObserved: observedApi,
    isListed: (raw) => asObj(raw).is_system !== true,
    createBody(f) {
      const body: Obj = {}
      for (const k of ['name', 'identifier', 'signing_alg']) if (str(f[k])) body[k] = f[k]
      if (typeof f.token_lifetime === 'number') body.token_lifetime = f.token_lifetime
      if (typeof f.allow_offline_access === 'boolean')
        body.allow_offline_access = f.allow_offline_access
      if (Array.isArray(f.scopes)) body.scopes = scopeList(f.scopes)
      return body
    },
    patchValue: (field, to) => (field === 'scopes' ? scopeList(to) : to)
  }
}

/** A stable comparison form: lists as sorted JSON, empty text as null. */
function norm(v: unknown): string {
  if (Array.isArray(v)) {
    const items = v.map((x) =>
      x && typeof x === 'object'
        ? JSON.stringify({ v: asObj(x).value ?? '', d: asObj(x).description ?? '' })
        : String(x)
    )
    return JSON.stringify([...items].sort())
  }
  if (v === undefined || v === null || v === '') return 'null'
  return JSON.stringify(v)
}

function diffCrud(impl: CrudType, desired: DesiredResource, observed: Observed): FieldChange[] {
  const changes: FieldChange[] = []
  for (const key of impl.writable) {
    const want = desired.fields[key]
    if (want === undefined) continue
    const have = observed.fields[key]
    if (norm(want) !== norm(have)) changes.push({ field: key, from: have, to: want })
  }
  if (impl.tags) {
    const wantTags = Object.entries(desired.tags ?? {}).filter(([k]) => k.startsWith(TAG_PREFIX))
    if (wantTags.some(([k, v]) => observed.tags[k] !== v))
      changes.push({ field: 'tags', from: observed.tags, to: desired.tags })
  }
  return changes
}

function preconditionsOf(changes: FieldChange[], observed: Observed): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const c of changes)
    out[c.field] = c.field === 'tags' ? observed.tags : observed.fields[c.field]
  return out
}

function createChanges(impl: CrudType, desired: DesiredResource): FieldChange[] {
  const changes: FieldChange[] = []
  for (const key of [...impl.replaceOn, ...impl.writable])
    if (desired.fields[key] !== undefined) changes.push({ field: key, to: desired.fields[key] })
  return changes
}

function planCrud(
  impl: CrudType,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const base = (kind: PlannedOp['kind'], externalId: string | null, reason: string, extra = {}) =>
    ({
      kind,
      type: impl.type,
      resourceId: desired?.resourceId ?? null,
      externalId,
      reason,
      changes: [] as FieldChange[],
      preconditions: {} as Record<string, unknown>,
      risk: [] as RiskFlag[],
      ...extra
    }) satisfies PlannedOp
  const spec = types.find((t) => t.key === impl.type)
  const typeLabel = spec?.label ?? impl.type
  if (!desired) {
    if (!observed) return []
    return [
      base(
        'delete',
        observed.externalId,
        `Delete ${typedName(typeLabel, observed.name ?? observed.externalId)}.`,
        {
          preconditions: { name: observed.name }
        }
      )
    ]
  }
  const label = typedName(
    typeLabel,
    String(desired.fields.name ?? desired.fields.identifier ?? observed?.name ?? '')
  )
  if (!observed)
    return [
      base(
        'create',
        null,
        `Create ${label} (an Auth0 resource with the same identifier is refused: adopt it instead).`,
        { changes: createChanges(impl, desired) }
      )
    ]
  const replace = impl.replaceOn.filter(
    (k) => desired.fields[k] !== undefined && norm(desired.fields[k]) !== norm(observed.fields[k])
  )
  if (replace.length) {
    return [
      base(
        'replace',
        observed.externalId,
        `Replace ${label}: ${fieldWords(spec?.fields, replace)} cannot change in place.`,
        {
          changes: replace.map((field) => ({
            field,
            from: observed.fields[field],
            to: desired.fields[field]
          })),
          preconditions: {
            name: observed.name,
            ...Object.fromEntries(replace.map((k) => [k, observed.fields[k]]))
          }
        }
      )
    ]
  }
  const changes = diffCrud(impl, desired, observed)
  if (!changes.length) return [base('noop', observed.externalId, `${label} is up to date.`)]
  return [
    base(
      'update',
      observed.externalId,
      `Change ${fieldWords(spec?.fields, changes)} on ${label}.`,
      {
        changes,
        preconditions: preconditionsOf(changes, observed)
      }
    )
  ]
}

async function getCrud(ctx: ProviderContext, impl: CrudType, id: string): Promise<Observed | null> {
  const res = await mgmt(ctx, 'GET', `${impl.path}/${encodeURIComponent(id)}`, {
    query: impl.fieldsQuery ? { fields: impl.fieldsQuery, include_fields: true } : undefined,
    allow: [404]
  })
  return res.status === 404 ? null : impl.toObserved(res.body)
}

async function findExisting(
  ctx: ProviderContext,
  impl: CrudType,
  desired: DesiredResource
): Promise<Observed | null> {
  if (desired.externalId) return getCrud(ctx, impl, desired.externalId)
  if (impl.type === API) {
    const identifier = str(desired.fields.identifier)
    return identifier ? getCrud(ctx, impl, identifier) : null
  }
  // An application has no unique name: a rerun after an interrupted create finds the one the Hub
  // already made by the resource tag it wrote.
  const tag = desired.tags?.[`${TAG_PREFIX}resource`]
  if (!tag) return null
  for (let page = 0; page < 20; page++) {
    const { items, cursor } = await listCrud(ctx, impl, String(page))
    const hit = items.find((o) => o.tags[`${TAG_PREFIX}resource`] === tag)
    if (hit) return hit
    if (cursor === null) break
  }
  return null
}

async function listCrud(
  ctx: ProviderContext,
  impl: CrudType,
  cursor?: string | null
): Promise<ListPage> {
  const page = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0)
  const query: Record<string, string | number | boolean> = {
    page,
    per_page: PAGE,
    include_totals: false
  }
  if (impl.fieldsQuery) {
    query.fields = impl.fieldsQuery
    query.include_fields = true
  }
  const res = await mgmt(ctx, 'GET', impl.path, { query })
  const rows = Array.isArray(res.body) ? res.body : []
  return {
    items: rows.filter(impl.isListed).map(impl.toObserved),
    cursor: rows.length >= PAGE ? String(page + 1) : null
  }
}

function patchBody(impl: CrudType, changes: FieldChange[], desired: DesiredResource): Obj {
  const body: Obj = {}
  for (const c of changes) {
    if (c.field === 'tags') body.client_metadata = metaFromTags(desired.tags ?? {})
    else body[c.field] = impl.patchValue(c.field, c.to)
  }
  return body
}

function ok(observed: Observed | null, externalId: string | null, status: number): OpResult {
  return { ok: true, externalId, observed, answer: { status } }
}

async function createCrud(
  ctx: ProviderContext,
  impl: CrudType,
  desired: DesiredResource
): Promise<OpResult> {
  const existing = await findExisting(ctx, impl, desired)
  if (existing) {
    // The Hub's own recorded resource (resumed run): bring it to the wanted values.
    if (desired.externalId) return updateCrud(ctx, impl, existing.externalId, desired)
    // Found by the Hub's resource tag: made by an earlier, interrupted run. Nothing is changed.
    if (impl.type === APP) return ok(existing, existing.externalId, 200)
    // Anything else the Hub did not make is never patched silently.
    throw new ProviderError(
      'ALREADY_EXISTS',
      `${existing.name ?? existing.externalId} already exists at Auth0 and was not created by the Hub. Adopt it instead of creating it.`,
      { status: 409 }
    )
  }
  const body = impl.createBody(desired.fields)
  if (impl.tags) {
    const meta = metaFromTags(desired.tags ?? {})
    if (Object.keys(meta).length) body.client_metadata = meta
  }
  const res = await mgmt(ctx, 'POST', impl.path, { body })
  const observed = impl.toObserved(res.body)
  return ok(observed, observed.externalId, res.status)
}

async function updateCrud(
  ctx: ProviderContext,
  impl: CrudType,
  id: string,
  desired: DesiredResource
): Promise<OpResult> {
  const observed = await getCrud(ctx, impl, id)
  if (!observed)
    throw new ProviderError('NOT_FOUND', 'The resource no longer exists at Auth0.', { status: 404 })
  const changes = diffCrud(impl, desired, observed)
  if (!changes.length) return ok(observed, observed.externalId, 200)
  const res = await mgmt(ctx, 'PATCH', `${impl.path}/${encodeURIComponent(id)}`, {
    body: patchBody(impl, changes, desired)
  })
  const after = impl.toObserved(res.body)
  return ok(after, after.externalId, res.status)
}

async function deleteCrud(ctx: ProviderContext, impl: CrudType, id: string): Promise<OpResult> {
  const res = await mgmt(ctx, 'DELETE', `${impl.path}/${encodeURIComponent(id)}`, { allow: [404] })
  return ok(null, id, res.status)
}

// ── Connection binding ──

async function connectionName(
  ctx: ProviderContext,
  connectionId: string
): Promise<{ name: string | null } | null> {
  const res = await mgmt(ctx, 'GET', `/connections/${encodeURIComponent(connectionId)}`, {
    query: { fields: 'id,name', include_fields: true },
    allow: [404]
  })
  if (res.status === 404) return null
  return { name: str(asObj(res.body).name) }
}

async function enabledClients(ctx: ProviderContext, connectionId: string): Promise<string[]> {
  const out: string[] = []
  let from: string | null = null
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string | number> = { take: 100 }
    if (from) query.from = from
    const res = await mgmt(ctx, 'GET', `/connections/${encodeURIComponent(connectionId)}/clients`, {
      query
    })
    const body = asObj(res.body)
    const rows = Array.isArray(res.body)
      ? res.body
      : Array.isArray(body.clients)
        ? body.clients
        : []
    for (const r of rows) {
      const id = str(asObj(r).client_id)
      if (id) out.push(id)
    }
    from = str(body.next)
    if (!from) break
  }
  return out
}

async function observeBinding(ctx: ProviderContext, externalId: string): Promise<Observed | null> {
  const ids = splitBindingId(externalId)
  if (!ids) return null
  const conn = await connectionName(ctx, ids.connectionId)
  if (!conn) return null
  const clients = await enabledClients(ctx, ids.connectionId)
  return clients.includes(ids.clientId)
    ? observedBinding(ids.connectionId, conn.name, ids.clientId)
    : null
}

async function listBindings(ctx: ProviderContext, cursor?: string | null): Promise<ListPage> {
  const page = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0)
  const res = await mgmt(ctx, 'GET', '/connections', {
    query: { page, per_page: 20, include_totals: false, fields: 'id,name', include_fields: true }
  })
  const rows = Array.isArray(res.body) ? res.body : []
  const items: Observed[] = []
  for (const r of rows) {
    const id = str(asObj(r).id)
    if (!id) continue
    for (const clientId of await enabledClients(ctx, id))
      items.push(observedBinding(id, str(asObj(r).name), clientId))
  }
  return { items, cursor: rows.length >= 20 ? String(page + 1) : null }
}

const bindingLabel = () => types.find((t) => t.key === BINDING)?.label ?? BINDING

function planBinding(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  const op = (
    kind: PlannedOp['kind'],
    externalId: string | null,
    reason: string,
    extra: Partial<PlannedOp> = {}
  ): PlannedOp => ({
    kind,
    type: BINDING,
    resourceId: desired?.resourceId ?? null,
    externalId,
    reason,
    changes: [],
    preconditions: {},
    risk: [],
    ...extra
  })
  const connectionId = desired ? str(desired.fields.connection_id) : null
  if (!desired) {
    if (!observed) return []
    return [
      op('delete', observed.externalId, `Switch off ${typedName(bindingLabel(), observed.name)}.`, {
        preconditions: {
          client: observed.fields.client,
          connection_id: observed.fields.connection_id
        }
      })
    ]
  }
  const client = desired.refs.client
  const changes: FieldChange[] = [
    { field: 'client', to: typeof client === 'string' ? client : null },
    { field: 'connection_id', to: connectionId }
  ]
  if (!observed)
    return [
      op(
        'create',
        null,
        `Create ${typedName(bindingLabel(), connectionId)}: enable it for the application.`,
        {
          changes
        }
      )
    ]
  const sameClient = typeof client !== 'string' || client === observed.fields.client
  const sameConn = !connectionId || connectionId === observed.fields.connection_id
  if (sameClient && sameConn)
    return [
      op('noop', observed.externalId, `${typedName(bindingLabel(), observed.name)} is up to date.`)
    ]
  return [
    op(
      'replace',
      observed.externalId,
      `Replace ${typedName(bindingLabel(), observed.name)}: the connection or application changed (enable the new pair, switch off the old).`,
      {
        changes: [
          { field: 'client', from: observed.fields.client, to: client },
          { field: 'connection_id', from: observed.fields.connection_id, to: connectionId }
        ],
        preconditions: {
          client: observed.fields.client,
          connection_id: observed.fields.connection_id
        }
      }
    )
  ]
}

async function setBinding(
  ctx: ProviderContext,
  connectionId: string,
  clientId: string,
  enabled: boolean
): Promise<number> {
  const res = await mgmt(ctx, 'PATCH', `/connections/${encodeURIComponent(connectionId)}/clients`, {
    body: [{ client_id: clientId, status: enabled }],
    allow: enabled ? [] : [404]
  })
  return res.status
}

async function applyBinding(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const remove = async (externalId: string): Promise<OpResult> => {
    const ids = splitBindingId(externalId)
    if (!ids) throw new ProviderError('INVALID', 'That is not an enabled-connection id.')
    // Read before write: a pair that is already off is a success.
    const status = (await observeBinding(ctx, externalId))
      ? await setBinding(ctx, ids.connectionId, ids.clientId, false)
      : 204
    return ok(null, externalId, status)
  }
  const add = async (): Promise<OpResult> => {
    const connectionId = str(desired?.fields.connection_id)
    const clientId = desired ? desired.refs.client : null
    if (!connectionId || typeof clientId !== 'string')
      throw new ProviderError(
        'REF_UNRESOLVED',
        'The application this connection is for has not been created yet.'
      )
    const externalId = bindingId(connectionId, clientId)
    const existing = await observeBinding(ctx, externalId)
    if (existing) {
      if (desired?.externalId) return ok(existing, externalId, 200)
      throw new ProviderError(
        'ALREADY_EXISTS',
        'That connection is already enabled for the application and was not enabled by the Hub. Adopt it instead.',
        { status: 409 }
      )
    }
    const conn = await connectionName(ctx, connectionId)
    if (!conn)
      throw new ProviderError('NOT_FOUND', 'That Auth0 connection does not exist.', { status: 404 })
    const status = await setBinding(ctx, connectionId, clientId, true)
    return ok(observedBinding(connectionId, conn.name, clientId), externalId, status)
  }
  switch (op.kind) {
    case 'noop':
      return ok(op.externalId ? await observeBinding(ctx, op.externalId) : null, op.externalId, 200)
    case 'create':
      return add()
    case 'delete':
      return remove(String(op.externalId ?? ''))
    case 'replace':
      if (op.externalId) await remove(op.externalId)
      return add()
    default:
      throw new ProviderError(
        'UNSUPPORTED',
        'An enabled connection is switched on or off, not edited.'
      )
  }
}

// ── The adapter ──

const NEEDS: Array<{ type: string; scopes: string[] }> = [
  { type: APP, scopes: ['read:clients', 'create:clients', 'update:clients', 'delete:clients'] },
  {
    type: API,
    scopes: [
      'read:resource_servers',
      'create:resource_servers',
      'update:resource_servers',
      'delete:resource_servers'
    ]
  },
  { type: BINDING, scopes: ['read:connections', 'update:connections'] }
]

async function readsAllowed(ctx: ProviderContext): Promise<Set<string>> {
  // The token's scopes could not be read (an opaque token): probe the three read paths instead.
  const have = new Set<string>()
  const probes: Array<[string, string]> = [
    ['read:clients', '/clients'],
    ['read:resource_servers', '/resource-servers'],
    ['read:connections', '/connections']
  ]
  for (const [scope, path] of probes) {
    const res = await mgmt(ctx, 'GET', path, { query: { per_page: 1 }, allow: [401, 403] })
    if (res.status < 400) have.add(scope)
  }
  return have
}

export const auth0Provider: ProviderAdapter = {
  bundledPrices: AUTH0_BUNDLED,
  key: 'auth0',
  label: 'Auth0',
  connection: {
    fields: CONNECTION_FIELDS,
    hosts(config) {
      return domainAllowed(config) ? [] : [domainOf(config)]
    },
    describe(config) {
      return `Auth0 ${domainOf(config)}${domainOf(config).endsWith('.auth0.com') ? '' : ' (custom domain, confirmed)'} · client ${String(config.client_id ?? '')}`
    },
    validate(config, secrets) {
      const problems: string[] = []
      const d = domainAllowed(config)
      if (d) problems.push(d)
      if (!str(config.client_id)) problems.push('Enter the client ID.')
      if ('client_secret' in secrets && !secrets.client_secret)
        problems.push('Enter the client secret.')
      const a = audienceProblem(config)
      if (a) problems.push(a)
      return problems
    }
  },
  types,

  async testConnection(ctx): Promise<ConnectionTest> {
    let token: string
    try {
      token = await mintToken(ctx)
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : 'Could not reach Auth0.'
      return { ok: false, identity: null, permissions: [], missing: [], message }
    }
    const scopes = new Set(tokenScopes(token))
    const unreadable = scopes.size === 0
    const probed = unreadable ? await readsAllowed(ctx).catch(() => new Set<string>()) : scopes
    const permissions = NEEDS.flatMap((n) =>
      n.scopes.map((need) => ({ type: n.type, need, has: probed.has(need) }))
    )
    const missing = [...new Set(permissions.filter((p) => !p.has).map((p) => p.need))]
    return {
      ok: true,
      identity: `Management API client ${String(ctx.config.client_id ?? '')} on ${domainOf(ctx.config)}`,
      permissions,
      missing,
      message: unreadable
        ? 'Auth0 did not list the granted scopes; only read access was checked.'
        : missing.length
          ? `Grant ${missing.join(', ')} to this application on the Auth0 Management API.`
          : undefined
    }
  },

  async observe(ctx, type, externalId) {
    await managementToken(ctx)
    if (type === BINDING) return observeBinding(ctx, externalId)
    const impl = CRUD[type]
    if (!impl) throw new ProviderError('UNKNOWN_TYPE', `Auth0 has no resource type ${type}.`)
    return getCrud(ctx, impl, externalId)
  },

  async list(ctx, type, cursor) {
    if (type === BINDING) return listBindings(ctx, cursor)
    const impl = CRUD[type]
    if (!impl) throw new ProviderError('UNKNOWN_TYPE', `Auth0 has no resource type ${type}.`)
    return listCrud(ctx, impl, cursor)
  },

  /** Plan time: an API with the same identifier, an application-connection pair already enabled. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    await managementToken(ctx)
    if (type === BINDING) {
      const connectionId = str(desired.fields.connection_id)
      const clientId = desired.refs.client
      if (!connectionId || typeof clientId !== 'string') return null
      return observeBinding(ctx, bindingId(connectionId, clientId))
    }
    // Only an API has a unique name to look up; an application is found by the Hub's own tag at apply.
    if (type !== API) return null
    return findExisting(ctx, CRUD[API], desired)
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === BINDING) return planBinding(desired, observed)
    const impl = type ? CRUD[type] : undefined
    if (!impl) return []
    return planCrud(impl, desired, observed)
  },

  async apply(ctx, op, desired) {
    if (op.type === BINDING) return applyBinding(ctx, op, desired)
    const impl = CRUD[op.type]
    if (!impl) throw new ProviderError('UNKNOWN_TYPE', `Auth0 has no resource type ${op.type}.`)
    switch (op.kind) {
      case 'noop':
        return ok(
          op.externalId ? await getCrud(ctx, impl, op.externalId) : null,
          op.externalId,
          200
        )
      case 'create':
        if (!desired) throw new ProviderError('INVALID', 'A create needs the wanted values.')
        return createCrud(ctx, impl, desired)
      case 'update':
        if (!desired || !op.externalId)
          throw new ProviderError('INVALID', 'An update needs a resource.')
        return updateCrud(ctx, impl, op.externalId, desired)
      case 'delete':
        if (!op.externalId) throw new ProviderError('INVALID', 'A delete needs a resource id.')
        return deleteCrud(ctx, impl, op.externalId)
      case 'replace':
        if (!desired || !op.externalId)
          throw new ProviderError('INVALID', 'A replace needs a resource.')
        await deleteCrud(ctx, impl, op.externalId)
        return createCrud(ctx, impl, { ...desired, externalId: null })
      default:
        throw new ProviderError('INVALID', `Unknown operation ${String(op.kind)}.`)
    }
  }
}
