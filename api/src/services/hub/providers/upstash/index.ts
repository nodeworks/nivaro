import { fieldWords, typedName } from '../plan-words.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag
} from '../types.js'
import { segment, upstashCall } from './client.js'
import { UPSTASH_BUNDLED, upstashEstimate } from './pricing.js'

/**
 * Upstash (`upstash`): account email + API key (HTTP Basic). Host `api.upstash.com`. One type,
 * `upstash.redis_database`: region (set at create; a change is a replace), eviction on/off, TLS
 * always on. The connection string is the output `redis_url` (secret): the Hub seals it and a
 * binding to the stack secret `REDIS_URL` carries it; unlike a once-only key Upstash shows the
 * password again, so it can be re-read (`readOutputs`).
 *
 * External id = the database id. Upstash has no tags and no account id: the API key is the
 * account, so the connection itself is the pin. A deleted database is "gone".
 */

const TYPE_DB = 'upstash.redis_database'

export const UPSTASH_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'sa-east-1'
]

// ── Small helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function diffFields(
  keys: string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (norm(want[k]) !== norm(have[k]))
      out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
}

function alreadyExists(name: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `A database named ${name} already exists at Upstash. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

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

// ── Observed mapper (never carries the password or a REST token) ──

function isDeleted(d: any): boolean {
  return String(d?.state ?? '').toLowerCase() === 'deleted'
}

function dbObserved(d: any): Observed {
  const id = String(d.database_id ?? d.id)
  return {
    type: TYPE_DB,
    externalId: id,
    name: d.database_name ?? d.name ?? null,
    fields: {
      name: d.database_name ?? d.name ?? null,
      region: d.primary_region ?? d.region ?? null,
      eviction: d.eviction === true,
      tls: d.tls !== false,
      plan: d.database_type ?? d.type ?? null,
      endpoint: d.endpoint ?? null,
      port: typeof d.port === 'number' ? d.port : null
    },
    tags: {},
    version: null,
    status: d.state ?? null,
    url: `https://console.upstash.com/redis/${encodeURIComponent(id)}`
  }
}

/** The connection URL from a database record; absent parts → no output. */
export function redisUrlOf(d: any): string | null {
  const pw = typeof d?.password === 'string' ? d.password : ''
  const host = typeof d?.endpoint === 'string' ? d.endpoint : ''
  if (!pw || !host) return null
  const port = typeof d?.port === 'number' ? d.port : 6379
  return `rediss://default:${encodeURIComponent(pw)}@${host}:${port}`
}

const outputsOf = (d: any): Record<string, string> => {
  const url = redisUrlOf(d)
  return url ? { redis_url: url } : {}
}

// ── Reads ──

async function readRaw(ctx: ProviderContext, id: string): Promise<any | null> {
  const r = await upstashCall(ctx, 'GET', `/v2/redis/database/${segment(id)}`, { allow: [404] })
  if (r.status === 404 || !r.body || typeof r.body !== 'object' || isDeleted(r.body)) return null
  return r.body
}

async function readDb(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const raw = await readRaw(ctx, id)
  return raw ? dbObserved(raw) : null
}

async function listRaw(ctx: ProviderContext): Promise<any[]> {
  const r = await upstashCall(ctx, 'GET', '/v2/redis/databases')
  return (Array.isArray(r.body) ? r.body : []).filter((d) => d && !isDeleted(d))
}

// ── Planning ──

const FIELDS: ResourceTypeSpec['fields'] = [
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    required: true,
    pattern: '^[A-Za-z0-9._-]{1,64}$'
  },
  {
    key: 'region',
    label: 'Primary region',
    kind: 'enum',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    options: UPSTASH_REGIONS.map((r) => ({ value: r, label: r })),
    help: 'The AWS region the data lives in. Changing it makes a new, empty database.'
  },
  {
    key: 'eviction',
    label: 'Eviction',
    kind: 'boolean',
    default: false,
    help: 'Evict old keys when the database is full instead of refusing writes.'
  },
  { key: 'tls', label: 'TLS', kind: 'boolean', readOnly: true, help: 'Always on.' },
  { key: 'plan', label: 'Plan', kind: 'string', readOnly: true },
  { key: 'endpoint', label: 'Endpoint', kind: 'string', readOnly: true }
]

const WRITABLE = ['name', 'eviction']

const specLabel = 'Upstash Redis database'
const words = (changes: Array<{ field: string }>) => fieldWords(FIELDS, changes)

const BIND_NOTE =
  ' Bind its connection URL to REDIS_URL; the environment’s Redis mode then switches to external on the next stack apply.'

function planDb(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: TYPE_DB,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(specLabel, observed.name)} and every key in it. There is no way back.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  if (!observed) {
    return [
      {
        kind: 'create',
        type: TYPE_DB,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(specLabel, String(desired.fields.name ?? ''))}.${BIND_NOTE}`,
        changes: ['name', 'region', 'eviction']
          .filter((k) => norm(desired.fields[k]) !== null)
          .map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: []
      }
    ]
  }
  const replace = diffFields(['region'], desired.fields, observed.fields)
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: TYPE_DB,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(specLabel, observed.name)}: ${words(replace)} cannot change in place, so the data is deleted and a new, empty database is made.`,
        changes: replace,
        preconditions: { name: observed.fields.name, region: observed.fields.region },
        risk: []
      }
    ]
  const changes = diffFields(WRITABLE, desired.fields, observed.fields)
  if (!changes.length) return []
  const pre: Record<string, unknown> = {}
  for (const c of changes) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: TYPE_DB,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${words(changes)} on ${typedName(specLabel, observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

// ── Applying ──

function regionOf(desired: DesiredResource): string {
  const region = String(desired.fields.region ?? '')
  if (!UPSTASH_REGIONS.includes(region))
    throw new ProviderError('INVALID_FIELDS', `${region || 'No region'} is not an Upstash region.`)
  return region
}

async function createDb(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const name = String(desired.fields.name ?? '').trim()
  if (!name) throw new ProviderError('INVALID_FIELDS', 'The database needs a name.')
  const region = regionOf(desired)
  // A resumed create already has its provider id on the row: just read it back.
  if (desired.externalId) {
    const raw = await readRaw(ctx, desired.externalId)
    if (raw)
      return ok(String(raw.database_id), dbObserved(raw), { already: 'exists' }, outputsOf(raw))
  }
  const existing = (await listRaw(ctx)).find((d) => (d.database_name ?? d.name) === name)
  if (existing) throw alreadyExists(name)
  const r = await upstashCall(ctx, 'POST', '/v2/redis/database', {
    body: {
      database_name: name,
      platform: 'aws',
      primary_region: region,
      read_regions: [],
      tls: true,
      eviction: desired.fields.eviction === true
    }
  })
  const made = r.body
  if (!made?.database_id)
    throw new ProviderError('PROVIDER_REJECTED', 'Upstash did not return the new database.')
  return ok(String(made.database_id), dbObserved(made), { created: true }, outputsOf(made))
}

async function removeDb(ctx: ProviderContext, id: string): Promise<void> {
  await upstashCall(ctx, 'DELETE', `/v2/redis/database/${segment(id)}`, { allow: [404] })
}

async function applyDb(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    return createDb(ctx, desired)
  }
  if (op.kind === 'delete') {
    const id = op.externalId as string
    await removeDb(ctx, id)
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'replace') {
    const id = op.externalId as string
    await removeDb(ctx, id)
    return createDb(ctx, { ...desired, externalId: null })
  }
  const id = op.externalId as string
  const have = await readRaw(ctx, id)
  if (!have) throw new ProviderError('NOT_FOUND', 'The database no longer exists.', { status: 404 })
  const seen = dbObserved(have)
  const diff = diffFields(WRITABLE, desired.fields, seen.fields)
  if (!diff.length) return ok(id, seen, { already: 'matches' }, outputsOf(have))
  for (const c of diff) {
    if (c.field === 'name') {
      const name = String(c.to ?? '').trim()
      if (!name) throw new ProviderError('INVALID_FIELDS', 'The database needs a name.')
      await upstashCall(ctx, 'POST', `/v2/redis/rename/${segment(id)}`, { body: { name } })
    } else if (c.field === 'eviction') {
      await upstashCall(
        ctx,
        'POST',
        `/v2/redis/${c.to === true ? 'enable' : 'disable'}-eviction/${segment(id)}`
      )
    }
  }
  const after = await readRaw(ctx, id)
  return ok(
    id,
    after ? dbObserved(after) : null,
    { changed: diff.map((c) => c.field) },
    after ? outputsOf(after) : undefined
  )
}

// ── Types ──

const TYPES: ResourceTypeSpec[] = [
  {
    key: TYPE_DB,
    label: specLabel,
    scope: 'app',
    nameField: 'name',
    fields: FIELDS,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [],
    outputs: [{ key: 'redis_url', label: 'Redis connection URL', secret: true }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive', 'data_loss')
      return out
    },
    costClass: () => 'monthly',
    estimate: upstashEstimate
  }
]

// ── The adapter ──

export const upstashAdapter: ProviderAdapter = {
  bundledPrices: UPSTASH_BUNDLED,
  key: 'upstash',
  label: 'Upstash',
  connection: {
    fields: [
      {
        key: 'email',
        label: 'Account email',
        kind: 'string',
        required: true,
        placeholder: 'you@example.com',
        help: 'The Upstash account the API key belongs to.'
      },
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'string',
        secret: true,
        required: true,
        help: 'Upstash console → Account → Management API. The key has the account’s full access.'
      }
    ],
    hosts: () => ['api.upstash.com'],
    describe: (config) => `Upstash ${String(config.email ?? '')}`,
    validate(config, secrets) {
      const problems: string[] = []
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(config.email ?? '')))
        problems.push('The account email does not look like an email address.')
      if (secrets.apiKey !== undefined && !secrets.apiKey.trim())
        problems.push('The API key is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const needs = (has: boolean) => [
      { type: TYPE_DB, need: 'read Redis databases', has },
      { type: TYPE_DB, need: 'manage Redis databases (the API key is account-wide)', has }
    ]
    try {
      await upstashCall(ctx, 'GET', '/v2/redis/databases')
    } catch (err) {
      if (err instanceof ProviderError) {
        const permissions = needs(false)
        return {
          ok: false,
          identity: null,
          permissions,
          missing: permissions.map((p) => p.need),
          message: ctx.scrub(err.message)
        }
      }
      throw err
    }
    return {
      ok: true,
      identity: `Upstash account ${String(ctx.config.email ?? '')}`,
      permissions: needs(true),
      missing: []
    }
  },

  async observe(ctx, type, externalId) {
    if (type !== TYPE_DB) throw new ProviderError('UNKNOWN_TYPE', `Upstash has no ${type}.`)
    return readDb(ctx, externalId)
  },

  async list(ctx, type): Promise<ListPage> {
    if (type !== TYPE_DB) throw new ProviderError('UNKNOWN_TYPE', `Upstash has no ${type}.`)
    return { items: (await listRaw(ctx)).map(dbObserved), cursor: null }
  },

  /** Plan time: a database of that name on the account. */
  async findExisting(ctx, type, desired) {
    if (type !== TYPE_DB || desired.externalId) return null
    const name = String(desired.fields.name ?? '').trim()
    if (!name) return null
    const hit = (await listRaw(ctx)).find((d) => (d.database_name ?? d.name) === name)
    return hit ? dbObserved(hit) : null
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type !== TYPE_DB) throw new ProviderError('UNKNOWN_TYPE', `Upstash has no ${String(type)}.`)
    return planDb(desired, observed)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    if (op.type !== TYPE_DB) throw new ProviderError('UNKNOWN_TYPE', `Upstash has no ${op.type}.`)
    return applyDb(ctx, op, desired)
  },

  /** The URL is re-readable (Upstash shows the password again): not once-only. */
  async readOutputs(ctx, type, externalId) {
    if (type !== TYPE_DB) return {}
    const raw = await readRaw(ctx, externalId)
    return raw ? outputsOf(raw) : {}
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Upstash.', checkedAt }
    const state = String(seen.status ?? '').toLowerCase()
    if (state === 'active') return { status: 'ok', checkedAt, details: { state } }
    return {
      status: 'warn',
      message: `Database is ${state || 'in an unknown state'}.`,
      checkedAt,
      details: { state }
    }
  }
}
