import { randomBytes } from 'node:crypto'
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
import { numSegment, rcCall, taskIdOf, waitTask } from './client.js'
import { RC_BUNDLED, redisCloudPlanPrice, subscriptionEstimate } from './pricing.js'

/**
 * Redis Cloud (`redis-cloud`): account key + user key (`x-api-key`, `x-api-secret-key`) and the
 * account id the keys must belong to (checked by Test and before every read and write). Host
 * `api.redislabs.com`. Two types:
 *
 *  - `redis-cloud.subscription` (shared): an Essentials (fixed plan) subscription can be created,
 *    renamed, moved to another plan and deleted; a Pro subscription can only be adopted and read.
 *    External id `fixed:<id>` / `pro:<id>`.
 *  - `redis-cloud.database` (app): name, eviction policy, replication, persistence, in an
 *    Essentials subscription (create) or a Pro one (adopt, update, delete; never created). The
 *    memory limit comes from the plan and is read-only. External id `<kind>:<subId>/<dbId>`.
 *
 * Writes are asynchronous tasks: `apply` polls `/tasks/:id` until it completes, bounded (a
 * RETRYABLE `TASK_PENDING` when it runs out). The task id of a create is kept in the connection's
 * in-memory cache so that a resume in the same process polls it instead of finding its own
 * half-made resource and calling it a collision; after a Hub restart that create stops with
 * ALREADY_EXISTS and the person adopts it.
 *
 * The database output `redis_url` (secret) is re-readable (the API shows the default user's
 * password), so it is not once-only.
 */

const TYPE_SUB = 'redis-cloud.subscription'
const TYPE_DB = 'redis-cloud.database'
const PAGE = 100

const EVICTION = [
  'noeviction',
  'allkeys-lru',
  'allkeys-lfu',
  'allkeys-random',
  'volatile-lru',
  'volatile-lfu',
  'volatile-random',
  'volatile-ttl'
]
const PERSISTENCE = [
  'none',
  'aof-every-1-second',
  'aof-every-write',
  'snapshot-every-1-hour',
  'snapshot-every-6-hours',
  'snapshot-every-12-hours'
]

type Kind = 'fixed' | 'pro'

// ── Small helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function sameValue(a: unknown, b: unknown): boolean {
  const x = norm(a)
  const y = norm(b)
  if (typeof x === 'number' || typeof y === 'number') return Number(x) === Number(y)
  return x === y
}

function diffFields(
  keys: string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (!sameValue(want[k], have[k])) out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
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

function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} at Redis Cloud. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

const proOnly = (what: string) =>
  new ProviderError(
    'PRO_ADOPT_ONLY',
    `${what} is on a Redis Cloud Pro subscription: the Hub reads and adopts those, and changes them in the Redis Cloud console.`
  )

/** `fixed:123` / `pro:123` → its parts (ids are numeric: nothing odd reaches a URL path). */
function parseSub(ext: unknown): { kind: Kind; id: string } {
  const m = /^(fixed|pro):(\d{1,12})$/.exec(typeof ext === 'string' ? ext : '')
  if (!m) throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return { kind: m[1] as Kind, id: m[2] }
}

function parseDb(ext: unknown): { kind: Kind; sub: string; id: string } {
  const m = /^(fixed|pro):(\d{1,12})\/(\d{1,12})$/.exec(typeof ext === 'string' ? ext : '')
  if (!m) throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return { kind: m[1] as Kind, sub: m[2], id: m[3] }
}

const subBase = (kind: Kind, id: string) =>
  `${kind === 'fixed' ? '/fixed' : ''}/subscriptions/${numSegment(id)}`

// ── The pinned account ──

const ACCOUNT_OK = 'account-ok'
const ACCOUNT_CHECK_MS = 5 * 60_000

/**
 * The keys must belong to the account this connection pins (every read and write). Checked once
 * per few minutes per connection (the answer is cached in the connection's token cache).
 */
async function ensureAccount(ctx: ProviderContext): Promise<void> {
  const pinned = String(ctx.config.accountId ?? '')
  if (ctx.tokens.get(`${ACCOUNT_OK}:${pinned}`)) return
  const r = await rcCall(ctx, 'GET', '/')
  const seen = String(r.body?.account?.id ?? '')
  if (!pinned || seen !== pinned)
    throw new ProviderError(
      'REDIS_CLOUD_OUT_OF_ACCOUNT',
      `These keys belong to Redis Cloud account ${seen || 'unknown'}, not the pinned account ${pinned || 'none'}. Nothing was changed.`
    )
  ctx.tokens.set(
    `${ACCOUNT_OK}:${pinned}`,
    '1',
    new Date(ctx.now().getTime() + ACCOUNT_CHECK_MS + 60_000)
  )
}

// ── Observed mappers (never carry a password) ──

function subObserved(kind: Kind, s: any): Observed {
  const id = String(s.id)
  const pro = kind === 'pro'
  const detail = Array.isArray(s.cloudDetails) ? s.cloudDetails[0] : null
  const region = pro ? (detail?.regions?.[0]?.region ?? null) : (s.region ?? null)
  return {
    type: TYPE_SUB,
    externalId: `${kind}:${id}`,
    name: s.name ?? null,
    fields: {
      name: s.name ?? null,
      kind,
      planId: pro ? null : (s.planId ?? null),
      planName: pro ? null : (s.planName ?? null),
      paymentMethodId: s.paymentMethodId ?? null,
      provider: pro ? (detail?.provider ?? null) : (s.provider ?? null),
      region
    },
    tags: {},
    version: null,
    status: s.status ?? null,
    url: 'https://cloud.redis.io/#/subscriptions'
  }
}

function dbObserved(kind: Kind, sub: string, d: any): Observed {
  const id = String(d.databaseId ?? d.id)
  return {
    type: TYPE_DB,
    externalId: `${kind}:${sub}/${id}`,
    name: d.name ?? null,
    fields: {
      // A ref field reads as the referenced resource's provider id.
      subscription: `${kind}:${sub}`,
      name: d.name ?? null,
      protocol: d.protocol ?? null,
      dataEvictionPolicy: d.dataEvictionPolicy ?? null,
      replication: d.replication === true,
      dataPersistence: d.dataPersistence ?? null,
      memoryLimitInGb: d.memoryLimitInGb ?? d.datasetSizeInGb ?? null,
      endpoint: d.publicEndpoint ?? null
    },
    tags: {},
    version: null,
    status: d.status ?? null,
    url: 'https://cloud.redis.io/#/databases'
  }
}

/** The connection URL from a database record; no password or endpoint → no output. */
export function redisUrlOf(d: any): string | null {
  const pw = typeof d?.security?.password === 'string' ? d.security.password : ''
  const endpoint = typeof d?.publicEndpoint === 'string' ? d.publicEndpoint : ''
  if (!pw || !endpoint) return null
  const scheme = d?.security?.enableTls === true ? 'rediss' : 'redis'
  return `${scheme}://default:${encodeURIComponent(pw)}@${endpoint}`
}

const outputsOf = (d: any): Record<string, string> => {
  const url = redisUrlOf(d)
  return url ? { redis_url: url } : {}
}

// ── Reads ──

async function readSubRaw(ctx: ProviderContext, ext: string): Promise<any | null> {
  const { kind, id } = parseSub(ext)
  const r = await rcCall(ctx, 'GET', subBase(kind, id), { allow: [404] })
  return r.status === 404 || !r.body || typeof r.body !== 'object' ? null : r.body
}

async function readSub(ctx: ProviderContext, ext: string): Promise<Observed | null> {
  await ensureAccount(ctx)
  const raw = await readSubRaw(ctx, ext)
  return raw ? subObserved(parseSub(ext).kind, raw) : null
}

async function listSubs(ctx: ProviderContext, kind: Kind): Promise<any[]> {
  const r = await rcCall(ctx, 'GET', kind === 'fixed' ? '/fixed/subscriptions' : '/subscriptions', {
    allow: [403, 404]
  })
  return r.status === 200 && Array.isArray(r.body?.subscriptions) ? r.body.subscriptions : []
}

async function readDbRaw(ctx: ProviderContext, ext: string): Promise<any | null> {
  const { kind, sub, id } = parseDb(ext)
  const r = await rcCall(ctx, 'GET', `${subBase(kind, sub)}/databases/${numSegment(id)}`, {
    allow: [404]
  })
  return r.status === 404 || !r.body || typeof r.body !== 'object' ? null : r.body
}

async function readDb(ctx: ProviderContext, ext: string): Promise<Observed | null> {
  await ensureAccount(ctx)
  const raw = await readDbRaw(ctx, ext)
  if (!raw) return null
  const { kind, sub } = parseDb(ext)
  return dbObserved(kind, sub, raw)
}

/** Every database of one subscription (paged by offset; bounded). */
async function listDbs(ctx: ProviderContext, kind: Kind, sub: string): Promise<any[]> {
  const out: any[] = []
  for (let offset = 0, page = 0; page < 20; page++, offset += PAGE) {
    const r = await rcCall(ctx, 'GET', `${subBase(kind, sub)}/databases`, {
      query: { offset, limit: PAGE },
      allow: [404]
    })
    if (r.status === 404) break
    const holder = Array.isArray(r.body?.subscription)
      ? r.body.subscription[0]
      : r.body?.subscription
    const dbs: any[] = Array.isArray(holder?.databases) ? holder.databases : []
    out.push(...dbs)
    if (dbs.length < PAGE) break
  }
  return out
}

// ── Planning ──

const SUB_FIELDS: ResourceTypeSpec['fields'] = [
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    required: true,
    pattern: '^[A-Za-z0-9._ -]{1,80}$'
  },
  {
    key: 'planId',
    label: 'Essentials plan id',
    kind: 'number',
    required: true,
    min: 1,
    help: 'The id of a Redis Cloud Essentials (fixed) plan. A plan change is billed at the new plan’s price.'
  },
  {
    key: 'paymentMethodId',
    label: 'Payment method id',
    kind: 'number',
    createOnly: true,
    min: 1,
    help: 'Needed for a paid plan.'
  },
  { key: 'kind', label: 'Subscription kind', kind: 'string', readOnly: true },
  { key: 'planName', label: 'Plan', kind: 'string', readOnly: true },
  { key: 'provider', label: 'Cloud', kind: 'string', readOnly: true },
  { key: 'region', label: 'Region', kind: 'string', readOnly: true }
]

const DB_FIELDS: ResourceTypeSpec['fields'] = [
  {
    key: 'subscription',
    label: 'Subscription',
    kind: 'ref',
    refType: TYPE_SUB,
    required: true,
    createOnly: true
  },
  { key: 'name', label: 'Name', kind: 'string', required: true, pattern: '^[A-Za-z0-9._-]{1,40}$' },
  {
    key: 'protocol',
    label: 'Protocol',
    kind: 'enum',
    createOnly: true,
    default: 'redis',
    options: [
      { value: 'redis', label: 'Redis' },
      { value: 'memcached', label: 'Memcached' }
    ]
  },
  {
    key: 'dataEvictionPolicy',
    label: 'Eviction policy',
    kind: 'enum',
    default: 'noeviction',
    options: EVICTION.map((v) => ({ value: v, label: v }))
  },
  { key: 'replication', label: 'Replication', kind: 'boolean', default: false },
  {
    key: 'dataPersistence',
    label: 'Data persistence',
    kind: 'enum',
    default: 'none',
    options: PERSISTENCE.map((v) => ({ value: v, label: v }))
  },
  {
    key: 'memoryLimitInGb',
    label: 'Memory limit (GB)',
    kind: 'number',
    readOnly: true,
    help: 'Set by the subscription’s plan.'
  },
  { key: 'endpoint', label: 'Public endpoint', kind: 'string', readOnly: true }
]

const SUB_WRITABLE = ['name', 'planId']
const DB_WRITABLE = ['name', 'dataEvictionPolicy', 'replication', 'dataPersistence']

const subWords = (c: Array<{ field: string }>) => fieldWords(SUB_FIELDS, c)
const dbWords = (c: Array<{ field: string }>) => fieldWords(DB_FIELDS, c)

const BIND_NOTE =
  ' Bind its connection URL to REDIS_URL; the environment’s Redis mode then switches to external on the next stack apply.'

function planSub(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    if (observed.fields.kind === 'pro') throw proOnly(`${typedName('Subscription', observed.name)}`)
    return [
      {
        kind: 'delete',
        type: TYPE_SUB,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName('Redis Cloud subscription', observed.name)}. Redis Cloud refuses it while it still holds databases.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  if (!observed) {
    if (desired.fields.kind === 'pro') throw proOnly('This subscription')
    return [
      {
        kind: 'create',
        type: TYPE_SUB,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName('Redis Cloud subscription', String(desired.fields.name ?? ''))} on an Essentials plan.`,
        changes: ['name', 'planId', 'paymentMethodId']
          .filter((k) => norm(desired.fields[k]) !== null)
          .map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: []
      }
    ]
  }
  const changes = diffFields(SUB_WRITABLE, desired.fields, observed.fields)
  if (!changes.length) return []
  if (observed.fields.kind === 'pro') throw proOnly(`${typedName('Subscription', observed.name)}`)
  const pre: Record<string, unknown> = {}
  for (const c of changes) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: TYPE_SUB,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${subWords(changes)} on ${typedName('Redis Cloud subscription', observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

function planDb(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: TYPE_DB,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName('Redis Cloud database', observed.name)} and every key in it. There is no way back.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  const wantedSub = desired.refs?.subscription
  if (!observed) {
    if (typeof wantedSub === 'string' && wantedSub.startsWith('pro:'))
      throw proOnly('This database')
    return [
      {
        kind: 'create',
        type: TYPE_DB,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName('Redis Cloud database', String(desired.fields.name ?? ''))}.${BIND_NOTE}`,
        changes: ['name', 'protocol', 'dataEvictionPolicy', 'replication', 'dataPersistence']
          .filter((k) => norm(desired.fields[k]) !== null)
          .map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: []
      }
    ]
  }
  if (typeof wantedSub === 'string' && wantedSub !== observed.fields.subscription)
    return [
      {
        kind: 'replace',
        type: TYPE_DB,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName('Redis Cloud database', observed.name)}: a database cannot move to another subscription, so its data is deleted and a new, empty database is made.`,
        changes: [{ field: 'subscription', from: observed.fields.subscription, to: wantedSub }],
        preconditions: { name: observed.fields.name, subscription: observed.fields.subscription },
        risk: []
      }
    ]
  const changes = diffFields(DB_WRITABLE, desired.fields, observed.fields)
  if (!changes.length) return []
  const pre: Record<string, unknown> = {}
  for (const c of changes) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: TYPE_DB,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${dbWords(changes)} on ${typedName('Redis Cloud database', observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

// ── Applying ──

/** The task id of a create is remembered for an hour (see the header). */
const TASK_KEEP_MS = 60 * 60_000 + 60_000
const taskKey = (type: string, desired: DesiredResource) =>
  `task:${type}:${desired.resourceId ?? String(desired.fields.name ?? '')}`

const rememberTask = (ctx: ProviderContext, key: string, taskId: string) =>
  ctx.tokens.set(key, taskId, new Date(ctx.now().getTime() + TASK_KEEP_MS))

/** Waits for a task; a failure other than "still working" forgets the remembered id. */
async function finishTask(ctx: ProviderContext, key: string | null, taskId: string) {
  try {
    const done = await waitTask(ctx, taskId)
    if (key) ctx.tokens.delete(key)
    return done
  } catch (err) {
    if (key && !(err instanceof ProviderError && err.code === 'TASK_PENDING'))
      ctx.tokens.delete(key)
    throw err
  }
}

async function createSub(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const name = String(desired.fields.name ?? '').trim()
  if (!name) throw new ProviderError('INVALID_FIELDS', 'The subscription needs a name.')
  if (desired.fields.kind === 'pro') throw proOnly('This subscription')
  const planId = Number(desired.fields.planId)
  if (!Number.isInteger(planId) || planId < 1)
    throw new ProviderError('INVALID_FIELDS', 'The subscription needs an Essentials plan id.')
  const key = taskKey(TYPE_SUB, desired)
  let taskId = ctx.tokens.get(key)
  if (!taskId) {
    if (desired.externalId) {
      const raw = await readSubRaw(ctx, desired.externalId)
      if (raw) return ok(desired.externalId, subObserved('fixed', raw), { already: 'exists' })
    }
    const taken = [...(await listSubs(ctx, 'fixed')), ...(await listSubs(ctx, 'pro'))].some(
      (s) => s?.name === name
    )
    if (taken) throw alreadyExists(`A subscription named ${name} already exists`)
    const body: Record<string, unknown> = { name, planId }
    if (norm(desired.fields.paymentMethodId) !== null)
      body.paymentMethodId = Number(desired.fields.paymentMethodId)
    const r = await rcCall(ctx, 'POST', '/fixed/subscriptions', { body })
    taskId = taskIdOf(r.body)
    rememberTask(ctx, key, taskId)
  }
  const done = await finishTask(ctx, key, taskId)
  if (done.resourceId == null)
    throw new ProviderError('PROVIDER_REJECTED', 'Redis Cloud did not name the new subscription.')
  const raw = await readSubRaw(ctx, `fixed:${done.resourceId}`)
  return ok(`fixed:${done.resourceId}`, raw ? subObserved('fixed', raw) : null, {
    created: true,
    task: taskId
  })
}

async function applySub(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    return createSub(ctx, desired)
  }
  const ext = op.externalId as string
  const { kind, id } = parseSub(ext)
  if (kind === 'pro') throw proOnly('This subscription')
  if (op.kind === 'delete') {
    const have = await readSubRaw(ctx, ext)
    if (!have) return ok(ext, null, { already_gone: true })
    const dbs = await listDbs(ctx, 'fixed', id)
    if (dbs.length)
      throw new ProviderError(
        'SUBSCRIPTION_NOT_EMPTY',
        `The subscription still holds ${dbs.length} database${dbs.length === 1 ? '' : 's'}. Delete them first.`
      )
    const r = await rcCall(ctx, 'DELETE', subBase('fixed', id), { allow: [404] })
    if (r.status !== 404) await finishTask(ctx, null, taskIdOf(r.body))
    return ok(ext, null)
  }
  if (!desired || op.kind !== 'update')
    throw new ProviderError(
      'CAPABILITY_MISSING',
      'A subscription can only be created, changed or deleted.'
    )
  const have = await readSubRaw(ctx, ext)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The subscription no longer exists.', { status: 404 })
  const seen = subObserved('fixed', have)
  const diff = diffFields(SUB_WRITABLE, desired.fields, seen.fields)
  if (!diff.length) return ok(ext, seen, { already: 'matches' })
  const body: Record<string, unknown> = {}
  for (const c of diff) body[c.field] = c.field === 'planId' ? Number(c.to) : c.to
  const r = await rcCall(ctx, 'PUT', subBase('fixed', id), { body })
  await finishTask(ctx, null, taskIdOf(r.body))
  const after = await readSubRaw(ctx, ext)
  return ok(ext, after ? subObserved('fixed', after) : null, { changed: diff.map((c) => c.field) })
}

function subRefOf(desired: DesiredResource | null): { kind: Kind; id: string } {
  const ref = desired?.refs?.subscription
  if (typeof ref !== 'string' || !ref)
    throw new ProviderError(
      'INVALID_FIELDS',
      'The subscription this database belongs to is not created yet.'
    )
  return parseSub(ref)
}

async function createDb(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const name = String(desired.fields.name ?? '').trim()
  if (!name) throw new ProviderError('INVALID_FIELDS', 'The database needs a name.')
  const sub = subRefOf(desired)
  if (sub.kind === 'pro') throw proOnly('This database')
  const subRaw = await readSubRaw(ctx, `fixed:${sub.id}`)
  if (!subRaw)
    throw new ProviderError('NOT_FOUND', 'The subscription no longer exists.', { status: 404 })
  const key = taskKey(TYPE_DB, desired)
  let taskId = ctx.tokens.get(key)
  const password = randomBytes(24).toString('base64url')
  if (!taskId) {
    if (String(subRaw.status ?? '') !== 'active')
      throw new ProviderError(
        'SUBSCRIPTION_NOT_READY',
        `The subscription is ${String(subRaw.status ?? 'not ready')}; wait for it to be active.`,
        { retryable: true }
      )
    if (desired.externalId) {
      const raw = await readDbRaw(ctx, desired.externalId)
      if (raw)
        return ok(
          desired.externalId,
          dbObserved('fixed', sub.id, raw),
          { already: 'exists' },
          outputsOf(raw)
        )
    }
    if ((await listDbs(ctx, 'fixed', sub.id)).some((d) => d?.name === name))
      throw alreadyExists(`A database named ${name} already exists in this subscription`)
    const r = await rcCall(ctx, 'POST', `${subBase('fixed', sub.id)}/databases`, {
      body: {
        name,
        protocol: String(desired.fields.protocol ?? 'redis'),
        dataPersistence: String(desired.fields.dataPersistence ?? 'none'),
        dataEvictionPolicy: String(desired.fields.dataEvictionPolicy ?? 'noeviction'),
        replication: desired.fields.replication === true,
        enableDefaultUser: true,
        password
      },
      extraScrub: [password]
    })
    taskId = taskIdOf(r.body)
    rememberTask(ctx, key, taskId)
  }
  const done = await finishTask(ctx, key, taskId)
  if (done.resourceId == null)
    throw new ProviderError('PROVIDER_REJECTED', 'Redis Cloud did not name the new database.')
  const ext = `fixed:${sub.id}/${done.resourceId}`
  const raw = await readDbRaw(ctx, ext)
  return ok(
    ext,
    raw ? dbObserved('fixed', sub.id, raw) : null,
    { created: true, task: taskId },
    raw ? outputsOf(raw) : undefined
  )
}

async function removeDb(ctx: ProviderContext, ext: string): Promise<void> {
  const { kind, sub, id } = parseDb(ext)
  const r = await rcCall(ctx, 'DELETE', `${subBase(kind, sub)}/databases/${numSegment(id)}`, {
    allow: [404]
  })
  if (r.status !== 404) await finishTask(ctx, null, taskIdOf(r.body))
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
  const ext = op.externalId as string
  const { kind, sub, id } = parseDb(ext)
  if (op.kind === 'delete') {
    await removeDb(ctx, ext)
    return ok(ext, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'replace') {
    await removeDb(ctx, ext)
    return createDb(ctx, { ...desired, externalId: null })
  }
  // A named target must be the subscription this change names.
  const wanted = desired.refs?.subscription
  if (typeof wanted === 'string' && wanted !== `${kind}:${sub}`)
    throw new ProviderError(
      'TARGET_MISMATCH',
      `Database ${ext} belongs to a different subscription than the one this change names. Nothing was changed.`
    )
  const have = await readDbRaw(ctx, ext)
  if (!have) throw new ProviderError('NOT_FOUND', 'The database no longer exists.', { status: 404 })
  const seen = dbObserved(kind, sub, have)
  const diff = diffFields(DB_WRITABLE, desired.fields, seen.fields)
  if (!diff.length) return ok(ext, seen, { already: 'matches' }, outputsOf(have))
  const body: Record<string, unknown> = {}
  for (const c of diff) body[c.field] = c.to
  const r = await rcCall(ctx, 'PUT', `${subBase(kind, sub)}/databases/${numSegment(id)}`, { body })
  await finishTask(ctx, null, taskIdOf(r.body))
  const after = await readDbRaw(ctx, ext)
  return ok(
    ext,
    after ? dbObserved(kind, sub, after) : null,
    { changed: diff.map((c) => c.field) },
    after ? outputsOf(after) : undefined
  )
}

// ── Types ──

const FULL = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: false }

const TYPES: ResourceTypeSpec[] = [
  {
    key: TYPE_SUB,
    label: 'Redis Cloud subscription',
    scope: 'shared',
    nameField: 'name',
    fields: SUB_FIELDS,
    capabilities: FULL,
    reversible: false,
    refs: [],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive')
      return out
    },
    costClass: () => 'monthly',
    estimate: subscriptionEstimate
  },
  {
    key: TYPE_DB,
    label: 'Redis Cloud database',
    scope: 'app',
    nameField: 'name',
    fields: DB_FIELDS,
    capabilities: FULL,
    reversible: false,
    refs: [{ field: 'subscription', type: TYPE_SUB, required: true }],
    outputs: [{ key: 'redis_url', label: 'Redis connection URL', secret: true }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive', 'data_loss')
      return out
    }
  }
]

// ── The adapter ──

export const redisCloudAdapter: ProviderAdapter = {
  bundledPrices: RC_BUNDLED,
  key: 'redis-cloud',
  label: 'Redis Cloud',
  connection: {
    fields: [
      {
        key: 'accountId',
        label: 'Account id',
        kind: 'string',
        required: true,
        placeholder: '12345',
        help: 'Pinned: the keys must belong to this Redis Cloud account.'
      },
      {
        key: 'accountKey',
        label: 'Account key',
        kind: 'string',
        secret: true,
        required: true,
        help: 'The API account key (sent as x-api-key).'
      },
      {
        key: 'userKey',
        label: 'User key',
        kind: 'string',
        secret: true,
        required: true,
        help: 'The API user key (sent as x-api-secret-key).'
      }
    ],
    hosts: () => ['api.redislabs.com'],
    describe: (config) => `Redis Cloud account ${String(config.accountId ?? '')}`,
    validate(config, secrets) {
      const problems: string[] = []
      if (!/^\d{1,12}$/.test(String(config.accountId ?? '')))
        problems.push('The account id is a number.')
      if (secrets.accountKey !== undefined && !secrets.accountKey.trim())
        problems.push('The account key is empty.')
      if (secrets.userKey !== undefined && !secrets.userKey.trim())
        problems.push('The user key is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const needs = (has: boolean) =>
      TYPES.flatMap((t) => [
        { type: t.key, need: `read ${t.key}`, has },
        { type: t.key, need: `write ${t.key} (user role Owner or Manager)`, has }
      ])
    const fail = (message: string): ConnectionTest => {
      const permissions = needs(false)
      return {
        ok: false,
        identity: null,
        permissions,
        missing: permissions.map((p) => p.need),
        message
      }
    }
    let account: any
    try {
      const r = await rcCall(ctx, 'GET', '/')
      account = r.body?.account
    } catch (err) {
      if (err instanceof ProviderError) return fail(ctx.scrub(err.message))
      throw err
    }
    const seen = String(account?.id ?? '')
    const pinned = String(ctx.config.accountId ?? '')
    if (!seen || seen !== pinned)
      return fail(
        `These keys belong to account ${seen || 'unknown'}, not the pinned account ${pinned || 'none'}.`
      )
    let canRead = false
    try {
      const r = await rcCall(ctx, 'GET', '/fixed/subscriptions', { allow: [403] })
      canRead = r.status === 200
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err
    }
    const permissions = needs(canRead)
    return {
      ok: canRead,
      identity: `account ${String(account?.name ?? seen)} (${seen})`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need)
    }
  },

  async observe(ctx, type, externalId) {
    if (type === TYPE_SUB) return readSub(ctx, externalId)
    if (type === TYPE_DB) return readDb(ctx, externalId)
    throw new ProviderError('UNKNOWN_TYPE', `Redis Cloud has no ${type}.`)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    await ensureAccount(ctx)
    if (type === TYPE_SUB) {
      const kind: Kind = cursor === 'pro' ? 'pro' : 'fixed'
      const subs = await listSubs(ctx, kind)
      return {
        items: subs.map((s) => subObserved(kind, s)),
        cursor: kind === 'fixed' ? 'pro' : null
      }
    }
    if (type !== TYPE_DB) throw new ProviderError('UNKNOWN_TYPE', `Redis Cloud has no ${type}.`)
    // One subscription per page; the cursor is the index into fixed subscriptions then Pro ones.
    const all: Array<{ kind: Kind; id: string }> = [
      ...(await listSubs(ctx, 'fixed')).map((s) => ({ kind: 'fixed' as Kind, id: String(s.id) })),
      ...(await listSubs(ctx, 'pro')).map((s) => ({ kind: 'pro' as Kind, id: String(s.id) }))
    ]
    const at = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0
    const target = all[at]
    if (!target) return { items: [], cursor: null }
    const dbs = await listDbs(ctx, target.kind, target.id)
    return {
      items: dbs.map((d) => dbObserved(target.kind, target.id, d)),
      cursor: at + 1 < all.length ? String(at + 1) : null
    }
  },

  /** Plan time: a subscription of that name, or a database of that name in the subscription. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    const name = String(desired.fields.name ?? '').trim()
    if (!name) return null
    await ensureAccount(ctx)
    if (type === TYPE_SUB) {
      for (const kind of ['fixed', 'pro'] as Kind[]) {
        const hit = (await listSubs(ctx, kind)).find((s) => s?.name === name)
        if (hit) return subObserved(kind, hit)
      }
      return null
    }
    if (type !== TYPE_DB) return null
    const ref = desired.refs?.subscription
    // A subscription made in the same change has no id yet, so nothing can collide yet.
    if (typeof ref !== 'string' || !ref) return null
    const { kind, id } = parseSub(ref)
    const hit = (await listDbs(ctx, kind, id)).find((d) => d?.name === name)
    return hit ? dbObserved(kind, id, hit) : null
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === TYPE_SUB) return planSub(desired, observed)
    if (type === TYPE_DB) return planDb(desired, observed)
    throw new ProviderError('UNKNOWN_TYPE', `Redis Cloud has no ${String(type)}.`)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    await ensureAccount(ctx)
    if (op.type === TYPE_SUB) return applySub(ctx, op, desired)
    if (op.type === TYPE_DB) return applyDb(ctx, op, desired)
    throw new ProviderError('UNKNOWN_TYPE', `Redis Cloud has no ${op.type}.`)
  },

  /** The URL is re-readable (the API shows the default user's password): not once-only. */
  async readOutputs(ctx, type, externalId) {
    if (type !== TYPE_DB) return {}
    await ensureAccount(ctx)
    const raw = await readDbRaw(ctx, externalId)
    return raw ? outputsOf(raw) : {}
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Redis Cloud.', checkedAt }
    const state = String(seen.status ?? '').toLowerCase()
    if (state === 'active') return { status: 'ok', checkedAt, details: { state } }
    if (state === 'error' || state === 'deleting' || state === 'deleted')
      return { status: 'down', message: `It is ${state}.`, checkedAt, details: { state } }
    return {
      status: 'warn',
      message: `It is ${state || 'in an unknown state'}.`,
      checkedAt,
      details: { state }
    }
  },

  priceApi: (ctx, skuKey) => redisCloudPlanPrice(ctx, skuKey)
}
