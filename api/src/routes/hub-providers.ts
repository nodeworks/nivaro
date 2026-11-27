import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam, isAppOwner, listApps, readApp } from '../services/hub/apps.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import {
  approveResourceChange,
  cancelResourceChange,
  declineResourceChange,
  discardResourceCreate,
  type HubActor,
  type PlanRequest,
  type PlanRequestOp,
  planResourceChange,
  ResourceChangeError,
  resumeResourceChange,
  startResourceChange,
  undoResourceChange
} from '../services/hub/providers/engine/contract.js'
import { createChangeIdOf, pendingCreateOf } from '../services/hub/providers/engine/discard.js'
import { publicStoredPlan } from '../services/hub/providers/engine/plan.js'
import {
  ensureCoreProviders,
  forgetConnectionTokens,
  getProvider,
  listProviders,
  makeProviderContext,
  type ProviderAdapter,
  ProviderError,
  type ResourceScope,
  type ResourceTypeSpec,
  RISK_FLAGS
} from '../services/hub/providers/index.js'
import {
  adoptResource,
  listUnmanaged,
  registerResourceObserveCron
} from '../services/hub/providers/observe.js'
import {
  APP_CONNECTIONS,
  appAllowedConnections,
  CONNECTIONS,
  createConnection,
  deleteConnection,
  type HubConnectionRow,
  HubProviderStoreError,
  type HubResourceChangeRow,
  type HubResourceRow,
  listChanges,
  listConnections,
  listResources,
  openConnectionSecrets,
  RESOURCE_CHANGES,
  readChange,
  readConnection,
  readResource,
  setAppAllowedConnections,
  updateConnection
} from '../services/hub/providers/store.js'
import { HUB_MASK } from '../services/hub/secrets.js'

/**
 * Hub third-party providers (HUB=on only, /api/hub, behind the Hub credential gate):
 *
 *   GET    /provider-types                  signed in     adapters + type specs, never connection data
 *   GET    /connections[?provider]          signed in     admins: all; owners: allowed for their apps
 *   POST   /connections                     admin         {provider, name, config, secrets}
 *   GET    /connections/:id                 signed in     (owner: only an allowed one, else 404)
 *   PATCH  /connections/:id                 admin         {name?, config?, secrets?} only keys sent change
 *   DELETE /connections/:id                 admin         409 CONNECTION_IN_USE while resources exist
 *   POST   /connections/:id/test            admin         identity + permissions, stored
 *   GET    /connections/:id/unmanaged       admin         ?type=&cursor=
 *   POST   /connections/:id/adopt           admin | owner of the app (own app scope only)
 *   GET|PUT /apps/:id/connections           owner | admin the app's allowed connections
 *   GET    /resources, /resources/:id       owners: only their apps' resources
 *   POST   /resources/plan                  signed in     the engine judges who may plan what
 *   POST   /resources/:id/discard           signed in     drop a create that never reached the provider
 *   GET    /resource-changes[/:id]          owners: only their apps' changes
 *   POST   /resource-changes/:id/{start,cancel,resume,undo}   signed in (the engine judges)
 *   POST   /resource-changes/:id/{approve,decline}            admin
 *
 * Secrets are write-only: every answer carries a mask, a fingerprint and the names of the secret
 * fields that hold a value — never a value, a sealed blob or a plain secret a plan was given.
 * Every write is logged (field NAMES only). The engine (engine/contract.ts) owns every gate
 * (freeze, window, production owner rule, shared-scope admin rule, typed confirm, approval).
 */

type Body = Record<string, unknown>

function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
) {
  return reply.code(status).send({
    statusCode: status,
    error: message,
    message,
    code,
    ...(details ? { details } : {})
  })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

function plainObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** How the request came, as the engine's gates want it. */
export function actorOf(req: FastifyRequest): HubActor {
  const method = req.authMethod
  let via: HubActor['via'] = 'session'
  if (req.mcpInner === true) via = 'mcp'
  else if (method === 'masquerade' || method === 'key_sim' || req.masqueradeAdminId) via = 'view_as'
  else if (method === 'api_key') via = 'key'
  return { id: userId(req), isAdmin: req.isAdmin === true, via }
}

/** Runs a handler, answering an engine / store / provider refusal as its HTTP error. */
async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (err) {
    if (err instanceof ResourceChangeError)
      return fail(reply, err.status, err.code, err.message, err.details)
    if (err instanceof HubProviderStoreError) {
      const status =
        err.code === 'RESOURCE_ALREADY_MANAGED'
          ? 409
          : err.code === 'CONNECTION_SECRET_BAD'
            ? 500
            : 404
      return fail(reply, status, err.code, err.message)
    }
    throw err
  }
}

// ── Output: masked, never a secret ──

function adapterOf(provider: string): ProviderAdapter | null {
  ensureCoreProviders()
  return getProvider(provider)
}

function describeConnection(row: HubConnectionRow): string | null {
  try {
    return adapterOf(row.provider)?.connection.describe(row.config) ?? null
  } catch {
    return null
  }
}

/**
 * The connection's values that resource fields choose from (FieldSpec.optionsFrom: AWS `region`
 * → the connection's `regions`). Only non-secret list fields a type names; never anything else.
 */
function fieldOptionsOf(row: HubConnectionRow): Record<string, string[]> {
  const adapter = adapterOf(row.provider)
  if (!adapter) return {}
  const named = new Set<string>()
  const walk = (fields: ResourceTypeSpec['fields']) => {
    for (const f of fields) {
      if (f.optionsFrom) named.add(f.optionsFrom)
      if (f.items) walk([f.items])
      if (f.fields) walk(f.fields)
    }
  }
  for (const t of adapter.types) walk(t.fields)
  const out: Record<string, string[]> = {}
  for (const key of named) {
    const spec = adapter.connection.fields.find((f) => f.key === key)
    if (!spec || spec.secret || spec.kind !== 'list') continue
    const v = row.config[key]
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []
    out[key] = list.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, 100)
  }
  return out
}

/** The full connection for an administrator. */
function connectionOut(row: HubConnectionRow) {
  return {
    id: row.id,
    provider: row.provider,
    provider_label: adapterOf(row.provider)?.label ?? row.provider,
    name: row.name,
    description: describeConnection(row),
    field_options: fieldOptionsOf(row),
    config: row.config,
    secret_mask: row.secret_mask,
    secret_fingerprint: row.secret_fingerprint,
    secret_keys: row.secret_keys,
    status: row.status,
    last_test_at: row.last_test_at,
    last_test: row.last_test,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

/** What an app owner sees of a connection their app may use: enough to pick it, no settings. */
function connectionSummary(row: HubConnectionRow) {
  return {
    id: row.id,
    provider: row.provider,
    provider_label: adapterOf(row.provider)?.label ?? row.provider,
    name: row.name,
    description: describeConnection(row),
    field_options: fieldOptionsOf(row),
    status: row.status
  }
}

const isSealed = (v: unknown): boolean =>
  !!v && typeof v === 'object' && typeof (v as { $sealed?: unknown }).$sealed === 'string'

/** The stored desired fields with every sealed secret reduced to its fingerprint. */
function desiredOut(desired: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!desired) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(desired)) {
    if (isSealed(v))
      out[k] = { secret: true, fingerprint: (v as { fingerprint?: unknown }).fingerprint ?? null }
    else out[k] = v
  }
  return out
}

/**
 * A resource for the answer. A row with no provider id (its create never reached the provider,
 * or is running now) carries `pending_create`: its change, that change's status, and whether
 * resume can run it (engine/discard.ts). `cache` keeps one read per change across a list.
 */
async function resourceOut(
  row: HubResourceRow,
  cache: Map<number, Promise<HubResourceChangeRow | null>> = new Map()
) {
  let pending: ReturnType<typeof pendingCreateOf> = null
  if (!row.external_id && !row.deleted_at) {
    const id = createChangeIdOf(row)
    let change: HubResourceChangeRow | null = null
    if (id != null) {
      if (!cache.has(id))
        cache.set(
          id,
          readChange(id).catch(() => null)
        )
      change = (await cache.get(id)) ?? null
    }
    pending = pendingCreateOf(row, change)
  }
  return { ...row, desired: desiredOut(row.desired), pending_create: pending }
}

function specFor(type: string | null | undefined): ResourceTypeSpec | null {
  if (!type) return null
  ensureCoreProviders()
  const dot = type.indexOf('.')
  return dot > 0
    ? (getProvider(type.slice(0, dot))?.types.find((t) => t.key === type) ?? null)
    : null
}

/**
 * Fail closed: with a resolved type spec only the keys it declares as non-secret pass through;
 * a secret field, an unknown key, or no spec at all masks the value.
 */
function maskedFields(
  fields: Record<string, unknown> | undefined,
  spec: ResourceTypeSpec | null
): Record<string, unknown> | undefined {
  if (!fields) return fields
  const plainKeys = new Set(
    (spec?.fields ?? []).filter((f) => f.kind !== 'secret').map((f) => f.key)
  )
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (isSealed(v))
      out[k] = { secret: true, fingerprint: (v as { fingerprint?: unknown }).fingerprint ?? null }
    else if (spec && plainKeys.has(k)) out[k] = v
    else {
      const sv = plainObject(v)
      // A SecretValue keeps its fingerprint / changed flag but never `plain`; anything else is masked.
      out[k] = sv && typeof sv.fingerprint === 'string' ? { ...sv, plain: undefined } : HUB_MASK
    }
  }
  return out
}

/**
 * A change row for the answer: a plain secret the person sent with the request (kept in the
 * stored plan's request) never leaves. An op without a type (update / delete by resourceId) takes
 * the type of its stored resource row, else of the plan's computed op for that resource.
 */
async function changeOut(row: HubResourceChangeRow) {
  const plan = row.plan
  if (!plan) return row
  if (!plan.request) return row
  const ops: unknown[] = []
  for (const op of plan.request.ops ?? []) {
    let type = op.type ?? null
    if (!type && op.resourceId != null) type = (await readResource(op.resourceId))?.type ?? null
    if (!type && op.resourceId != null)
      type = plan.ops?.find((p) => p.resourceId === op.resourceId)?.type ?? null
    ops.push({ ...op, fields: maskedFields(op.fields, specFor(type)) })
  }
  // The engine's sealed envelope of new secret values and the sealed before-state of secret
  // fields (undo data) never leave either (engine/plan.ts publicStoredPlan).
  const steps = row.steps.map((st) => ({
    ...st,
    beforeDesired: st.beforeDesired
      ? Object.fromEntries(
          Object.entries(st.beforeDesired).map(([k, v]) => {
            const o = plainObject(v)
            return [
              k,
              o && typeof o.$sealed === 'string'
                ? { secret: true, fingerprint: o.fingerprint ?? null }
                : v
            ]
          })
        )
      : (st.beforeDesired ?? null)
  }))
  return { ...row, steps, plan: { ...publicStoredPlan(plan), request: { ...plan.request, ops } } }
}

// ── Who may see what ──

async function ownedAppIds(req: FastifyRequest): Promise<Set<number>> {
  return new Set((await listApps(userId(req), false)).map((a) => a.id))
}

/** An admin, or the owner of this app. */
async function mayUseApp(req: FastifyRequest, appId: number): Promise<boolean> {
  return req.isAdmin === true || (await isAppOwner(appId, userId(req)))
}

/** Connection ids allowed for any app the caller owns. */
async function ownerConnectionIds(req: FastifyRequest): Promise<Set<number>> {
  const out = new Set<number>()
  for (const id of await ownedAppIds(req))
    for (const c of await appAllowedConnections(id)) out.add(c)
  return out
}

function notFound(reply: FastifyReply, what: string) {
  return fail(reply, 404, 'NOT_FOUND', `No such ${what}.`)
}

// ── Connection input ──

function stringRecord(v: unknown): Record<string, string | null> | null {
  const o = plainObject(v)
  if (!o) return null
  const out: Record<string, string | null> = {}
  for (const [k, x] of Object.entries(o)) {
    if (x === null) out[k] = null
    else if (typeof x === 'string') out[k] = x
    else return null
  }
  return out
}

function checkRequired(
  adapter: ProviderAdapter,
  config: Record<string, unknown>,
  secretsAfter: Set<string>
): string[] {
  const problems: string[] = []
  for (const f of adapter.connection.fields) {
    if (!f.required) continue
    if (f.secret) {
      if (!secretsAfter.has(f.key)) problems.push(`${f.label} is required.`)
    } else {
      const v = config[f.key]
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))
        problems.push(`${f.label} is required.`)
    }
  }
  return problems
}

/** Splits unknown keys out: a config key that is not a field, a secret sent as config, vice versa. */
function checkKeys(
  adapter: ProviderAdapter,
  config: Record<string, unknown>,
  secrets: Record<string, unknown>
): string[] {
  const plain = new Set(adapter.connection.fields.filter((f) => !f.secret).map((f) => f.key))
  const sec = new Set(adapter.connection.fields.filter((f) => f.secret).map((f) => f.key))
  const problems: string[] = []
  for (const k of Object.keys(config))
    if (!plain.has(k))
      problems.push(sec.has(k) ? `${k} is a secret: send it in secrets.` : `Unknown field ${k}.`)
  for (const k of Object.keys(secrets))
    if (!sec.has(k))
      problems.push(
        plain.has(k) ? `${k} is not a secret: send it in config.` : `Unknown secret ${k}.`
      )
  return problems
}

/** The hosts a config may call, as a set; an unreadable config counts as a different one. */
function hostsChanged(
  adapter: ProviderAdapter,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): boolean {
  try {
    const a = new Set(adapter.connection.hosts(before))
    const b = new Set(adapter.connection.hosts(after))
    return a.size !== b.size || [...a].some((h) => !b.has(h))
  } catch {
    return true
  }
}

function invalid(reply: FastifyReply, problems: string[]) {
  return fail(reply, 400, 'INVALID_FIELDS', problems.join(' '), { problems })
}

function activityLog(
  req: FastifyRequest,
  action: string,
  collection: string,
  item: string | number,
  comment: string
) {
  return logActivity({
    action,
    user: userId(req),
    collection,
    item: String(item),
    comment: comment.slice(0, 400),
    req
  })
}

// ── Plan input ──

const PLAN_ACTIONS = new Set(['create', 'update', 'delete', 'adopt', 'reapply', 'accept'])
const MAX_OPS = 100

function planRequestOf(b: Body): PlanRequest | string {
  const connectionId = idParam(b.connectionId)
  if (connectionId === null) return 'connectionId is required.'
  if (b.scope !== 'app' && b.scope !== 'shared') return 'scope must be app or shared.'
  const scope = b.scope as ResourceScope
  const appId = b.appId === undefined || b.appId === null ? undefined : idParam(b.appId)
  const environmentId =
    b.environmentId === undefined || b.environmentId === null ? undefined : idParam(b.environmentId)
  if (appId === null || environmentId === null) return 'appId / environmentId must be ids.'
  if (scope === 'app' && appId === undefined) return 'appId is required for scope app.'
  if (!Array.isArray(b.ops) || b.ops.length === 0) return 'ops must list at least one change.'
  if (b.ops.length > MAX_OPS) return `At most ${MAX_OPS} changes in one plan.`
  const ops: PlanRequestOp[] = []
  for (const raw of b.ops) {
    const o = plainObject(raw)
    if (!o || typeof o.action !== 'string' || !PLAN_ACTIONS.has(o.action))
      return 'Every op needs an action: create, update, delete, adopt, reapply or accept.'
    const op: PlanRequestOp = { action: o.action as PlanRequestOp['action'] }
    if (o.resourceId !== undefined && o.resourceId !== null) {
      const id = idParam(o.resourceId)
      if (id === null) return 'resourceId must be an id.'
      op.resourceId = id
    }
    if (o.type !== undefined && o.type !== null) {
      if (typeof o.type !== 'string') return 'type must be text.'
      op.type = o.type
    }
    if (o.externalId !== undefined && o.externalId !== null) {
      if (typeof o.externalId !== 'string') return 'externalId must be text.'
      op.externalId = o.externalId
    }
    if (o.fields !== undefined && o.fields !== null) {
      const f = plainObject(o.fields)
      if (!f) return 'fields must be an object.'
      op.fields = f
    }
    ops.push(op)
  }
  return {
    connectionId,
    scope,
    ...(appId !== undefined ? { appId } : {}),
    ...(environmentId !== undefined ? { environmentId } : {}),
    ops
  }
}

// ── Provider types ──

function typeOut(t: ResourceTypeSpec) {
  return {
    key: t.key,
    label: t.label,
    scope: t.scope,
    fields: t.fields,
    capabilities: t.capabilities,
    // A function = reversible for some fields only.
    reversible: typeof t.reversible === 'function' ? 'partial' : t.reversible,
    refs: t.refs,
    name_field: t.nameField ?? 'name',
    has_cost_class: typeof t.costClass === 'function'
  }
}

export async function hubProviderRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return

  // The periodic read of managed resources (drift, gone); a no-op where crons do not tick.
  registerResourceObserveCron(app)

  // ── Types ──

  app.get('/provider-types', { preHandler: requireAuth }, async () => {
    ensureCoreProviders()
    return {
      data: {
        // The vocabulary risk flags come from; which flags one change raises is shown on its plan.
        risk_flags: RISK_FLAGS,
        providers: listProviders().map((p) => ({
          key: p.key,
          label: p.label,
          connection: { fields: p.connection.fields },
          types: p.types.map(typeOut)
        }))
      }
    }
  })

  // ── Connections ──

  app.get('/connections', { preHandler: requireAuth }, async (req) => {
    const provider = (req.query as { provider?: string } | undefined)?.provider
    const filter = provider ? { provider } : {}
    if (req.isAdmin) return { data: (await listConnections(filter)).map(connectionOut) }
    const ids = [...(await ownerConnectionIds(req))]
    return { data: (await listConnections({ ...filter, ids })).map(connectionSummary) }
  })

  app.post('/connections', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const b = body(req)
      ensureCoreProviders()
      const adapter = typeof b.provider === 'string' ? getProvider(b.provider) : null
      if (!adapter) return fail(reply, 400, 'UNKNOWN_PROVIDER', 'No such provider.')
      const name = typeof b.name === 'string' ? b.name.trim() : ''
      if (!name || name.length > 200)
        return invalid(reply, ['A name (up to 200 characters) is required.'])
      const config = b.config === undefined ? {} : plainObject(b.config)
      const rawSecrets = b.secrets === undefined ? {} : stringRecord(b.secrets)
      if (!config) return invalid(reply, ['config must be an object.'])
      if (!rawSecrets) return invalid(reply, ['secrets must be an object of text values.'])
      const secrets = Object.fromEntries(
        Object.entries(rawSecrets).filter(
          ([, v]) => typeof v === 'string' && v !== '' && v !== HUB_MASK
        )
      ) as Record<string, string>
      const problems = [
        ...checkKeys(adapter, config, secrets),
        ...checkRequired(adapter, config, new Set(Object.keys(secrets)))
      ]
      if (!problems.length) problems.push(...(adapter.connection.validate?.(config, secrets) ?? []))
      if (problems.length) return invalid(reply, problems)
      const row = await createConnection({
        provider: adapter.key,
        name,
        config,
        secrets,
        createdBy: userId(req)
      })
      await activityLog(
        req,
        'hub-connection-create',
        CONNECTIONS,
        row.id,
        `${adapter.key} ${name} · secrets: ${Object.keys(secrets).join(', ') || 'none'}`
      )
      return reply.code(201).send({ data: connectionOut(row) })
    })
  )

  app.get('/connections/:id', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      const row = id === null ? null : await readConnection(id)
      if (!row) return notFound(reply, 'connection')
      if (req.isAdmin) return { data: connectionOut(row) }
      if (!(await ownerConnectionIds(req)).has(row.id)) return notFound(reply, 'connection')
      return { data: connectionSummary(row) }
    })
  )

  app.patch('/connections/:id', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      const row = id === null ? null : await readConnection(id)
      if (!row) return notFound(reply, 'connection')
      const adapter = adapterOf(row.provider)
      if (!adapter)
        return fail(reply, 409, 'UNKNOWN_PROVIDER', 'This connection’s provider is not registered.')
      const b = body(req)
      const patch: Parameters<typeof updateConnection>[1] = { updatedBy: userId(req) }
      const changed: string[] = []
      if (b.name !== undefined) {
        const name = typeof b.name === 'string' ? b.name.trim() : ''
        if (!name || name.length > 200)
          return invalid(reply, ['A name (up to 200 characters) is required.'])
        patch.name = name
        changed.push('name')
      }
      let config = row.config
      if (b.config !== undefined) {
        const c = plainObject(b.config)
        if (!c) return invalid(reply, ['config must be an object.'])
        config = { ...row.config, ...c }
        patch.config = config
        changed.push(...Object.keys(c).map((k) => `config.${k}`))
      }
      const sent = b.secrets === undefined ? {} : stringRecord(b.secrets)
      if (!sent) return invalid(reply, ['secrets must be an object of text values.'])
      const problems = checkKeys(
        adapter,
        b.config === undefined ? {} : (plainObject(b.config) ?? {}),
        sent
      )
      const after = new Set(row.secret_keys)
      let secretsTouched = false
      for (const [k, v] of Object.entries(sent)) {
        if (v === HUB_MASK) continue
        secretsTouched = true
        if (v === null || v === '') after.delete(k)
        else after.add(k)
        changed.push(`secrets.${k}`)
      }
      if (secretsTouched) patch.secrets = sent
      problems.push(...checkRequired(adapter, config, after))
      if (
        !problems.length &&
        (secretsTouched || b.config !== undefined) &&
        adapter.connection.validate
      ) {
        const open = await openConnectionSecrets(row)
        const merged = { ...open }
        for (const [k, v] of Object.entries(sent)) {
          if (v === HUB_MASK) continue
          if (v === null || v === '') delete merged[k]
          else merged[k] = v
        }
        problems.push(...adapter.connection.validate(config, merged))
      }
      if (problems.length) return invalid(reply, problems)
      // A stored credential is never sent to a host it was not entered for: changing the hosts
      // the connection may call needs every secret field typed in again, in this same request.
      if (b.config !== undefined && hostsChanged(adapter, row.config, config)) {
        const need = new Set(row.secret_keys)
        for (const f of adapter.connection.fields) if (f.secret && f.required) need.add(f.key)
        const missing = [...need].filter((k) => {
          const v = sent[k]
          return typeof v !== 'string' || v === '' || v === HUB_MASK
        })
        if (missing.length)
          return fail(
            reply,
            409,
            'SECRET_REQUIRED_ON_HOST_CHANGE',
            `This change moves the connection to other hosts. Enter the secrets again in the same request: ${missing.join(', ')}.`,
            { secrets: missing }
          )
      }
      // New credentials or settings: what the last test said no longer holds.
      if (secretsTouched || b.config !== undefined) {
        patch.status = 'untested'
        patch.lastTest = null
        patch.lastTestAt = null
      }
      const updated = await updateConnection(row.id, patch)
      if (!updated) return notFound(reply, 'connection')
      if (secretsTouched || b.config !== undefined) forgetConnectionTokens(row.id)
      await activityLog(
        req,
        'hub-connection-update',
        CONNECTIONS,
        row.id,
        changed.join(', ') || 'no change'
      )
      return { data: connectionOut(updated) }
    })
  )

  app.delete('/connections/:id', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      const row = id === null ? null : await readConnection(id)
      if (!row) return notFound(reply, 'connection')
      const resources = await listResources({ connectionId: row.id })
      const running = await listChanges({
        connectionId: row.id,
        status: ['applying', 'pending_approval'],
        limit: 1
      })
      if (resources.length || running.length)
        return fail(
          reply,
          409,
          'CONNECTION_IN_USE',
          resources.length
            ? `This connection still manages ${resources.length} resource(s). Delete or hand them over first.`
            : 'This connection has a change in progress.',
          { resources: resources.length }
        )
      await deleteConnection(row.id)
      forgetConnectionTokens(row.id)
      await activityLog(
        req,
        'hub-connection-delete',
        CONNECTIONS,
        row.id,
        `${row.provider} ${row.name}`
      )
      return { data: { deleted: true } }
    })
  )

  app.post('/connections/:id/test', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      const row = id === null ? null : await readConnection(id)
      if (!row) return notFound(reply, 'connection')
      const adapter = adapterOf(row.provider)
      if (!adapter)
        return fail(reply, 409, 'UNKNOWN_PROVIDER', 'This connection’s provider is not registered.')
      const secrets = await openConnectionSecrets(row)
      const ctx = makeProviderContext({
        adapter,
        connectionId: row.id,
        config: row.config,
        secrets
      })
      let result: Awaited<ReturnType<ProviderAdapter['testConnection']>>
      try {
        result = await adapter.testConnection(ctx)
      } catch (err) {
        const message = ctx.scrub(err instanceof Error ? err.message : String(err)).slice(0, 500)
        result = {
          ok: false,
          identity: null,
          permissions: [],
          missing: [],
          message:
            err instanceof ProviderError ? message : `The provider did not answer: ${message}`
        }
      }
      // The adapter's own text could name a credential: scrub whatever it said.
      if (result.message) result = { ...result, message: ctx.scrub(result.message) }
      if (result.identity) result = { ...result, identity: ctx.scrub(result.identity) }
      await updateConnection(row.id, {
        status: result.ok ? 'ok' : 'failing',
        lastTest: result,
        lastTestAt: new Date(),
        updatedBy: userId(req)
      })
      await activityLog(
        req,
        'hub-connection-test',
        CONNECTIONS,
        row.id,
        result.ok
          ? 'ok'
          : `failing${result.missing.length ? ` · missing ${result.missing.join(', ')}` : ''}`
      )
      return { data: result }
    })
  )

  app.get('/connections/:id/unmanaged', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      const row = id === null ? null : await readConnection(id)
      if (!row) return notFound(reply, 'connection')
      const q = (req.query ?? {}) as { type?: string; cursor?: string }
      if (!q.type) return invalid(reply, ['type is required.'])
      const page = await listUnmanaged(row.id, q.type, q.cursor || undefined, actorOf(req))
      return { data: page }
    })
  )

  app.post('/connections/:id/adopt', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      const row = id === null ? null : await readConnection(id)
      if (!row) return notFound(reply, 'connection')
      const b = body(req)
      if (typeof b.type !== 'string' || !b.type) return invalid(reply, ['type is required.'])
      if (typeof b.externalId !== 'string' || !b.externalId)
        return invalid(reply, ['externalId is required.'])
      if (b.scope !== 'app' && b.scope !== 'shared')
        return invalid(reply, ['scope must be app or shared.'])
      const appId = b.appId === undefined || b.appId === null ? undefined : idParam(b.appId)
      const environmentId =
        b.environmentId === undefined || b.environmentId === null
          ? undefined
          : idParam(b.environmentId)
      if (appId === null || environmentId === null)
        return invalid(reply, ['appId / environmentId must be ids.'])
      if (b.scope === 'app' && appId === undefined)
        return invalid(reply, ['appId is required for scope app.'])
      if (!req.isAdmin) {
        // Before any provider call: owners adopt only into their own app, through a connection
        // allowed for it. The engine-side check (Task 4) repeats this.
        if (b.scope === 'shared')
          return fail(
            reply,
            403,
            'SHARED_ADMIN_ONLY',
            'Shared infrastructure is for Hub administrators.'
          )
        if (appId === undefined || !(await isAppOwner(appId, userId(req))))
          return notFound(reply, 'app')
        if (!(await appAllowedConnections(appId)).includes(row.id))
          return fail(
            reply,
            403,
            'CONNECTION_NOT_ALLOWED',
            'This connection is not allowed for that app.'
          )
      }
      const resource = await adoptResource(
        row.id,
        {
          type: b.type,
          externalId: b.externalId,
          scope: b.scope,
          ...(appId !== undefined ? { appId } : {}),
          ...(environmentId !== undefined ? { environmentId } : {})
        },
        actorOf(req)
      )
      await activityLog(
        req,
        'hub-resource-adopt',
        CONNECTIONS,
        row.id,
        `${b.type} ${b.scope}${appId ? ` app ${appId}` : ''}`
      )
      return reply.code(201).send({ data: resource })
    })
  )

  // ── Allowed connections per app ──

  app.get('/apps/:id/connections', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      if (id === null || !(await readApp(id)) || !(await mayUseApp(req, id)))
        return notFound(reply, 'app')
      const ids = await appAllowedConnections(id)
      const rows = await listConnections({ ids })
      return {
        data: {
          connection_ids: ids,
          connections: rows.map(req.isAdmin ? connectionOut : connectionSummary)
        }
      }
    })
  )

  app.put('/apps/:id/connections', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      if (id === null || !(await readApp(id))) return notFound(reply, 'app')
      const raw = body(req).connection_ids
      if (!Array.isArray(raw)) return invalid(reply, ['connection_ids must be a list of ids.'])
      const ids: number[] = []
      for (const x of raw) {
        const n = idParam(x)
        if (n === null) return invalid(reply, ['connection_ids must be a list of ids.'])
        ids.push(n)
      }
      const unique = [...new Set(ids)]
      const found = new Set((await listConnections({ ids: unique })).map((c) => c.id))
      const missing = unique.filter((n) => !found.has(n))
      if (missing.length)
        return fail(
          reply,
          404,
          'CONNECTION_NOT_FOUND',
          `No such connection: ${missing.join(', ')}.`
        )
      const before = await appAllowedConnections(id)
      const after = await setAppAllowedConnections(id, unique, userId(req))
      await activityLog(
        req,
        'hub-app-connections-set',
        APP_CONNECTIONS,
        id,
        `app ${id}: ${before.join(',') || 'none'} -> ${after.join(',') || 'none'}`
      )
      return { data: { connection_ids: after } }
    })
  )

  // ── Resources ──

  app.get('/resources', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const q = (req.query ?? {}) as Record<string, string | undefined>
      const filter: Parameters<typeof listResources>[0] = {}
      const appId = q.app ? idParam(q.app) : undefined
      if (q.app && appId === null) return invalid(reply, ['app must be an id.'])
      if (q.environment && idParam(q.environment) === null)
        return invalid(reply, ['environment must be an id.'])
      if (q.connection && idParam(q.connection) === null)
        return invalid(reply, ['connection must be an id.'])
      if (q.scope && q.scope !== 'app' && q.scope !== 'shared')
        return invalid(reply, ['scope must be app or shared.'])
      if (appId) {
        if (!(await mayUseApp(req, appId))) return notFound(reply, 'app')
        filter.appId = appId
      }
      if (q.environment) filter.environmentId = idParam(q.environment) as number
      if (q.provider) filter.provider = q.provider
      if (q.connection) filter.connectionId = idParam(q.connection) as number
      if (q.type) filter.type = q.type
      if (q.scope) filter.scope = q.scope as ResourceScope
      if (q.drift === '1' || q.drift === 'true') filter.drift = true
      let rows = await listResources(filter)
      if (!req.isAdmin) {
        const own = await ownedAppIds(req)
        rows = rows.filter((r) => r.scope === 'app' && r.app_id !== null && own.has(r.app_id))
      }
      const cache = new Map<number, Promise<HubResourceChangeRow | null>>()
      return { data: await Promise.all(rows.map((r) => resourceOut(r, cache))) }
    })
  )

  app.get('/resources/:id', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      const row = id === null ? null : await readResource(id)
      if (!row || row.deleted_at) return notFound(reply, 'resource')
      if (
        !req.isAdmin &&
        (row.scope !== 'app' || row.app_id === null || !(await isAppOwner(row.app_id, userId(req))))
      )
        return notFound(reply, 'resource')
      return { data: await resourceOut(row) }
    })
  )

  app.post('/resources/:id/discard', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      const row = id === null ? null : await readResource(id)
      if (!row || row.deleted_at) return notFound(reply, 'resource')
      // An owner never learns a row of another app (or a shared one) exists.
      if (
        !req.isAdmin &&
        (row.scope !== 'app' || row.app_id === null || !(await isAppOwner(row.app_id, userId(req))))
      )
        return notFound(reply, 'resource')
      // The engine writes the audit row (hub-resource-discard).
      return { data: await discardResourceCreate(row.id, actorOf(req)) }
    })
  )

  app.post('/resources/plan', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const parsed = planRequestOf(body(req))
      if (typeof parsed === 'string') return invalid(reply, [parsed])
      const plan = await planResourceChange(parsed, actorOf(req))
      await activityLog(
        req,
        'hub-resource-plan',
        RESOURCE_CHANGES,
        plan.changeId,
        `${parsed.ops.map((o) => `${o.action} ${o.type ?? o.resourceId ?? ''}`.trim()).join(', ')} · ${parsed.scope}`
      )
      return { data: plan }
    })
  )

  // ── Changes ──

  app.get('/resource-changes', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const q = (req.query ?? {}) as Record<string, string | undefined>
      const filter: Parameters<typeof listChanges>[0] = {}
      const appId = q.app ? idParam(q.app) : undefined
      if (q.app && appId === null) return invalid(reply, ['app must be an id.'])
      if (appId) {
        if (!(await mayUseApp(req, appId))) return notFound(reply, 'app')
        filter.appId = appId
      }
      if (q.environment) {
        const e = idParam(q.environment)
        if (e === null) return invalid(reply, ['environment must be an id.'])
        filter.environmentId = e
      }
      if (q.connection) {
        const c = idParam(q.connection)
        if (c === null) return invalid(reply, ['connection must be an id.'])
        filter.connectionId = c
      }
      if (q.scope && q.scope !== 'app' && q.scope !== 'shared')
        return invalid(reply, ['scope must be app or shared.'])
      if (q.scope) filter.scope = q.scope as ResourceScope
      if (q.status) filter.status = q.status.split(',').filter(Boolean) as never
      if (q.limit) filter.limit = Number(q.limit) || 50
      if (q.before) filter.beforeId = idParam(q.before) ?? undefined
      let rows = await listChanges(filter)
      if (!req.isAdmin) {
        const own = await ownedAppIds(req)
        rows = rows.filter((r) => r.scope === 'app' && r.app_id !== null && own.has(r.app_id))
      }
      return { data: await Promise.all(rows.map(changeOut)) }
    })
  )

  app.get('/resource-changes/:id', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id: string }).id)
      const row = id === null ? null : await readChange(id)
      if (!row) return notFound(reply, 'change')
      if (
        !req.isAdmin &&
        (row.scope !== 'app' || row.app_id === null || !(await isAppOwner(row.app_id, userId(req))))
      )
        return notFound(reply, 'change')
      return { data: await changeOut(row) }
    })
  )

  /** Reads the change's id, 404 for a bad one; the engine judges everything else. */
  const changeId = (req: FastifyRequest) => idParam((req.params as { id: string }).id)

  app.post('/resource-changes/:id/start', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = changeId(req)
      if (id === null) return notFound(reply, 'change')
      const b = body(req)
      if (typeof b.planHash !== 'string' || !b.planHash)
        return invalid(reply, ['planHash is required.'])
      if (b.confirm !== undefined && b.confirm !== null && typeof b.confirm !== 'string')
        return invalid(reply, ['confirm must be text.'])
      const plan = await startResourceChange(
        id,
        {
          planHash: b.planHash,
          ...(typeof b.confirm === 'string' ? { confirm: b.confirm } : {}),
          // A production change's ticked pre-deploy checklist (version resource-change-<id>).
          ...(Number.isSafeInteger(b.checklistRunId) && Number(b.checklistRunId) > 0
            ? { checklistRunId: Number(b.checklistRunId) }
            : {})
        },
        actorOf(req)
      )
      await activityLog(req, 'hub-resource-start', RESOURCE_CHANGES, id, plan.status)
      return reply.code(202).send({ data: plan })
    })
  )
  app.post('/resource-changes/:id/cancel', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = changeId(req)
      if (id === null) return notFound(reply, 'change')
      const plan = await cancelResourceChange(id, actorOf(req))
      await activityLog(req, 'hub-resource-cancel', RESOURCE_CHANGES, id, plan.status)
      return { data: plan }
    })
  )
  app.post('/resource-changes/:id/resume', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = changeId(req)
      if (id === null) return notFound(reply, 'change')
      const plan = await resumeResourceChange(id, actorOf(req))
      await activityLog(req, 'hub-resource-resume', RESOURCE_CHANGES, id, plan.status)
      return reply.code(202).send({ data: plan })
    })
  )
  app.post('/resource-changes/:id/undo', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = changeId(req)
      if (id === null) return notFound(reply, 'change')
      const plan = await undoResourceChange(id, actorOf(req))
      await activityLog(
        req,
        'hub-resource-undo',
        RESOURCE_CHANGES,
        id,
        `new change ${plan.changeId}`
      )
      return { data: plan }
    })
  )
  app.post('/resource-changes/:id/approve', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = changeId(req)
      if (id === null) return notFound(reply, 'change')
      const b = body(req)
      if (typeof b.planHash !== 'string' || !b.planHash)
        return invalid(reply, ['planHash is required.'])
      const plan = await approveResourceChange(id, { planHash: b.planHash }, actorOf(req))
      await activityLog(req, 'hub-resource-approve', RESOURCE_CHANGES, id, plan.status)
      return reply.code(202).send({ data: plan })
    })
  )
  app.post('/resource-changes/:id/decline', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = changeId(req)
      if (id === null) return notFound(reply, 'change')
      const reason = typeof body(req).reason === 'string' ? (body(req).reason as string).trim() : ''
      if (!reason) return invalid(reply, ['A reason is required.'])
      const plan = await declineResourceChange(id, reason.slice(0, 1000), actorOf(req))
      await activityLog(req, 'hub-resource-decline', RESOURCE_CHANGES, id, 'declined')
      return { data: plan }
    })
  )
}
