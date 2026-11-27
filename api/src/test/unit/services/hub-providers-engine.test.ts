import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub third-party providers, Task 1: the change engine against real SQLite rows (every Hub
// migration up to 582) and a fake adapter registered through the registry: plan → start → run →
// resume / undo / approval, every gate it reuses (freezes, open moves, the production rule, the
// owner's allowed connections, shared scope), the plan hash + precondition fingerprint, the
// per-resource locks and heartbeat, and that no plain secret ever lands in a stored row, a step,
// an error or an audit comment.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db, migrationsDir: '/nowhere' }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { logActivity } = await import('../../../services/activity.js')
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
// Load the engine's run and plan modules in full before any test: contract.ts reaches run.ts by a
// dynamic import, and under a loaded machine two lazy loads raced and run.ts saw plan.ts half-made
// ("Cannot access … before initialization", 33 tests at once).
await import('../../../services/hub/providers/engine/plan.js')
await import('../../../services/hub/providers/engine/run.js')
const engine = await import('../../../services/hub/providers/engine/contract.js')
const deps = await import('../../../services/hub/providers/engine/deps.js')
const locks = await import('../../../services/hub/providers/engine/locks.js')
const { HUB_MASK } = await import('../../../services/hub/secrets.js')
const { ProviderError: PE } = await import('../../../services/hub/providers/types.js')

import type { HubActor, PlanRequest } from '../../../services/hub/providers/engine/contract.js'
import type {
  DesiredResource,
  Observed,
  PlannedOp,
  ProviderAdapter,
  ResourceTypeSpec
} from '../../../services/hub/providers/types.js'

const MIGRATIONS = [
  '542_hub_tables',
  '543_hub_promotions',
  '544_hub_databases',
  '545_hub_creations',
  '546_hub_stack_settings',
  '550_hub_oidc',
  '551_hub_signins',
  '552_hub_shared_deployments',
  '553_hub_moves',
  '555_hub_stack_files',
  '565_hub_release_ops',
  '566_hub_fleet',
  '567_hub_capacity',
  '568_hub_ops',
  '569_hub_data',
  '570_hub_people_owner_policy',
  '571_hub_app_templates',
  '573_hub_change_ops',
  '582_hub_providers'
]

const ADMIN: HubActor = {
  id: '0a1b2c3d-0000-4000-8000-000000000001',
  isAdmin: true,
  via: 'session'
}
const OWNER: HubActor = {
  id: '0a1b2c3d-0000-4000-8000-000000000002',
  isAdmin: false,
  via: 'session'
}
const STRANGER: HubActor = {
  id: '0a1b2c3d-0000-4000-8000-000000000003',
  isAdmin: false,
  via: 'session'
}
const SECRET = 'test-secret-plain-value-7731'
const SECRET2 = 'test-secret-second-value-9042'

// ── The fake provider ──

interface Thing {
  type: string
  fields: Record<string, unknown>
  version: number
  tags: Record<string, string>
  token?: string
  /** Things inside it (a bucket's objects). */
  objects?: number
}

const provider = {
  things: new Map<string, Thing>(),
  n: 0,
  calls: [] as Array<{ kind: string; action?: string; name?: unknown; ext: string | null }>,
  observes: 0,
  dispatches: 0,
  tokensSeen: [] as Array<string | undefined>,
  failNext: null as Error | null,
  onApply: null as null | ((op: PlannedOp) => Promise<void> | void),
  existing: null as Observed | null
}

const PLAIN_KEYS = ['name', 'size', 'zone', 'public', 'costly']

function observedOf(id: string): Observed | null {
  const t = provider.things.get(id)
  if (!t) return null
  return {
    type: t.type,
    externalId: id,
    name: String(t.fields.name ?? id),
    fields: { ...t.fields },
    tags: { ...t.tags },
    version: String(t.version)
  }
}

const field = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  label: key,
  kind: 'string' as const,
  ...extra
})

function boxType(key: string, scope: 'app' | 'shared'): ResourceTypeSpec {
  return {
    key,
    label: key === 'fake.net' ? 'Network' : 'Box',
    scope,
    fields: [
      field('name', { required: true }),
      field('size', { kind: 'number' }),
      field('zone', { replaceOnChange: true }),
      field('net', { kind: 'ref', refType: 'fake.net' }),
      field('parent', { kind: 'ref', refType: 'fake.box' }),
      field('token', { kind: 'secret' }),
      field('public', { kind: 'boolean' }),
      field('costly', { kind: 'boolean' }),
      field('dispatch', { kind: 'object', trigger: true, fields: [field('ref')] })
    ],
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: true,
      tag: true
    },
    reversible: true,
    refs: [
      { field: 'net', type: 'fake.net' },
      { field: 'parent', type: 'fake.box' }
    ],
    risk: (op, desired) => {
      const out: Array<'destructive' | 'public_exposure'> = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive')
      if (desired?.fields.public === true) out.push('public_exposure')
      return out
    },
    costClass: (d: DesiredResource) => (d.fields.costly === true ? 'monthly' : 'none')
  }
}

function plan(_ctx: unknown, desired: DesiredResource | null, observed: Observed | null) {
  if (!desired)
    return observed
      ? [
          {
            kind: 'delete' as const,
            type: observed.type,
            resourceId: null,
            externalId: observed.externalId,
            reason: `Delete ${observed.name}.`,
            changes: [],
            preconditions: {},
            risk: []
          }
        ]
      : []
  const changes: Array<{ field: string; from?: unknown; to?: unknown; secret?: boolean }> = []
  for (const k of PLAIN_KEYS)
    if (
      k in desired.fields &&
      JSON.stringify(desired.fields[k]) !== JSON.stringify(observed?.fields[k])
    )
      changes.push({ field: k, from: observed?.fields[k], to: desired.fields[k] })
  for (const k of ['net', 'parent'])
    if (k in desired.refs && desired.refs[k] !== (observed?.fields[k] ?? null))
      changes.push({ field: k, from: observed?.fields[k], to: desired.refs[k] })
  const token = desired.fields.token as { changed?: boolean } | undefined
  if (token?.changed) changes.push({ field: 'token', secret: true })
  if (!observed)
    return [
      {
        kind: 'create' as const,
        type: desired.type,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create box ${String(desired.fields.name)}.`,
        changes,
        preconditions: {},
        risk: []
      }
    ]
  if (desired.fields.dispatch)
    return [
      {
        kind: 'update' as const,
        type: desired.type,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        action: 'dispatch',
        reason: 'Run the workflow.',
        changes: [{ field: 'dispatch', to: desired.fields.dispatch }],
        preconditions: { $exists: true },
        risk: []
      }
    ]
  if (!changes.length) return []
  const replace = changes.some((c) => c.field === 'zone')
  return [
    {
      kind: replace ? ('replace' as const) : ('update' as const),
      type: desired.type,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `${replace ? 'Replace' : 'Update'} ${observed.name}: ${changes.map((c) => c.field).join(', ')}.`,
      changes,
      preconditions: {},
      risk: []
    }
  ]
}

function writeFields(d: DesiredResource): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PLAIN_KEYS) if (k in d.fields) out[k] = d.fields[k]
  for (const k of ['net', 'parent']) if (d.refs[k]) out[k] = d.refs[k]
  return out
}

const fakeAdapter: ProviderAdapter = {
  key: 'fake',
  label: 'Fake',
  connection: {
    fields: [
      { key: 'org', label: 'Org', kind: 'string' },
      { key: 'apiKey', label: 'Key', kind: 'string', secret: true }
    ],
    hosts: () => ['api.fake.example'],
    describe: () => 'Fake'
  },
  types: [boxType('fake.box', 'app'), boxType('fake.net', 'shared')],
  testConnection: async () => ({ ok: true, identity: 'fake', permissions: [], missing: [] }),
  observe: async (_ctx, _type, id) => {
    provider.observes++
    return observedOf(id)
  },
  list: async () => ({ items: [], cursor: null }),
  plan: plan as ProviderAdapter['plan'],
  async apply(ctx, op, desired) {
    provider.calls.push({
      kind: op.kind,
      ...(op.action ? { action: op.action } : {}),
      name: desired?.fields.name,
      ext: op.externalId
    })
    provider.tokensSeen.push((desired?.fields.token as { plain?: string } | undefined)?.plain)
    if (provider.failNext) {
      const e = provider.failNext
      provider.failNext = null
      throw e
    }
    await provider.onApply?.(op)
    if (op.kind === 'create') {
      const id = `${op.type === 'fake.net' ? 'net' : 'box'}-${++provider.n}`
      provider.things.set(id, {
        type: op.type,
        fields: writeFields(desired as DesiredResource),
        version: 1,
        tags: { ...(desired as DesiredResource).tags }
      })
      return { ok: true, externalId: id, observed: observedOf(id) }
    }
    const id = op.externalId as string
    if (op.kind === 'delete') {
      if ((provider.things.get(id)?.objects ?? 0) > 0 && op.data?.deleteAllObjects !== true)
        throw new PE('BUCKET_NOT_EMPTY', `Bucket ${id} is not empty.`)
      provider.things.delete(id)
      return { ok: true, externalId: id, observed: null }
    }
    if (op.kind === 'replace') {
      provider.things.delete(id)
      const nid = `box-${++provider.n}`
      provider.things.set(nid, {
        type: op.type,
        fields: writeFields(desired as DesiredResource),
        version: 1,
        tags: {}
      })
      return { ok: true, externalId: nid, observed: observedOf(nid) }
    }
    const t = provider.things.get(id)
    if (!t) throw new Error(`gone ${ctx.provider}`)
    if (op.action === 'dispatch') provider.dispatches++
    else t.fields = { ...t.fields, ...writeFields(desired as DesiredResource) }
    t.version++
    return { ok: true, externalId: id, observed: observedOf(id) }
  },
  snapshot: async (_ctx, _type, id) => ({
    kind: 'before_state',
    id: `snap-${id}`,
    createdAt: new Date().toISOString()
  }),
  async findExisting(_ctx, _type, desired) {
    return provider.existing && provider.existing.name === desired.fields.name
      ? provider.existing
      : null
  }
}

// ── Fixtures ──

let appId: number
let devEnv: number
let prodEnv: number
let connId: number
let otherConn: number

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  const [a] = await db('nivaro_hub_apps').insert({ key: 'shop', name: 'Shop' })
  appId = Number(a)
  const [d] = await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'dev',
    position: 0,
    base_url: 'https://dev.example.com',
    hub_token: 'sealed-dev'
  })
  devEnv = Number(d)
  const [p] = await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'production',
    position: 1,
    base_url: 'https://prod.example.com',
    hub_token: 'sealed-prod'
  })
  prodEnv = Number(p)
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER.id })
  connId = (
    await store.createConnection({
      provider: 'fake',
      name: 'Fake org',
      config: { org: 'nodeworks' },
      secrets: { apiKey: 'test-secret-connection-key' }
    })
  ).id
  otherConn = (
    await store.createConnection({ provider: 'fake', name: 'Other', config: {}, secrets: {} })
  ).id
  await store.setAppAllowedConnections(appId, [connId])
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  registry.resetProvidersForTest()
  registry.registerProvider(fakeAdapter)
  locks.resetMemoryResourceLocksForTest()
  deps.resetResourceEngineForTest()
  deps.configureResourceEngine({
    lock: () => locks.memoryResourceLock(),
    inline: true,
    notify: { notify: vi.fn(async () => null), adminBase: () => '', page: null }
  })
  Object.assign(provider, {
    things: new Map(),
    calls: [],
    observes: 0,
    dispatches: 0,
    tokensSeen: [],
    failNext: null,
    onApply: null,
    existing: null
  })
  vi.mocked(logActivity).mockClear()
  for (const t of [
    'nivaro_hub_resources',
    'nivaro_hub_resource_changes',
    'nivaro_hub_freezes',
    'nivaro_hub_moves'
  ])
    await db(t).del()
})

const appReq = (ops: PlanRequest['ops'], env = devEnv): PlanRequest => ({
  connectionId: connId,
  scope: 'app',
  appId,
  environmentId: env,
  ops
})

async function applied(req: PlanRequest, actor: HubActor = ADMIN, confirm?: string) {
  const p = await engine.planResourceChange(req, actor)
  const out = await engine.startResourceChange(
    p.changeId,
    { planHash: p.planHash, ...(confirm ? { confirm } : {}) },
    actor
  )
  return { plan: p, out }
}

async function createBox(name: string, fields: Record<string, unknown> = {}, env = devEnv) {
  const { out } = await applied(
    appReq([{ action: 'create', type: 'fake.box', fields: { name, ...fields } }], env)
  )
  expect(out.status).toBe('applied')
  const row = (await store.listResources({ type: 'fake.box' })).find((r) => r.name === name)
  if (!row) throw new Error('not created')
  return row
}

const rawChange = async (id: number) =>
  (await db('nivaro_hub_resource_changes').where({ id }).first()) as Record<string, unknown>

// ── Tests ──

describe('plan', () => {
  it('plans create/update/replace/delete with reasons', async () => {
    const p = await engine.planResourceChange(
      appReq([
        { action: 'create', type: 'fake.box', fields: { name: 'alpha', size: 1, zone: 'a' } }
      ]),
      ADMIN
    )
    expect(p.status).toBe('planned')
    expect(p.ops).toHaveLength(1)
    expect(p.ops[0]).toMatchObject({ kind: 'create', reason: 'Create box alpha.' })
    expect(p.needsConfirm).toBeNull()
    expect(provider.observes).toBe(0)
    await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    const row = (await store.listResources({ type: 'fake.box' }))[0]
    expect(row.external_id).toBe('box-1')
    expect(row.tags).toMatchObject({
      'nivaro-hub:app': 'shop',
      'nivaro-hub:env': 'dev',
      'nivaro-hub:resource': String(row.id)
    })

    const up = await engine.planResourceChange(
      appReq([{ action: 'update', resourceId: row.id, fields: { size: 2 } }]),
      ADMIN
    )
    expect(up.ops[0]).toMatchObject({ kind: 'update', reason: 'Update alpha: size.' })
    expect(up.ops[0].changes).toEqual([{ field: 'size', from: 1, to: 2 }])
    // The engine binds the update to what it read: the changed field and the version.
    expect(up.ops[0].preconditions).toEqual({ $exists: true, $version: '1', size: 1 })

    const rep = await engine.planResourceChange(
      appReq([{ action: 'update', resourceId: row.id, fields: { zone: 'b' } }]),
      ADMIN
    )
    expect(rep.ops[0]).toMatchObject({ kind: 'replace', risk: ['destructive'] })
    expect(rep.needsConfirm).toBe('alpha')

    const del = await engine.planResourceChange(
      appReq([{ action: 'delete', resourceId: row.id }]),
      ADMIN
    )
    expect(del.ops[0]).toMatchObject({
      kind: 'delete',
      reason: 'Delete alpha.',
      risk: ['destructive']
    })
    expect(del.needsConfirm).toBe('alpha')
  })

  it('plan_hash covers ops + precondition fingerprint', async () => {
    const row = await createBox('beta', { size: 1 })
    const req = appReq([{ action: 'update', resourceId: row.id, fields: { size: 5 } }])
    const a = await engine.planResourceChange(req, ADMIN)
    const b = await engine.planResourceChange(req, ADMIN)
    expect(a.planHash).toMatch(/^[0-9a-f]{64}$/)
    expect(b.planHash).toBe(a.planHash)
    const stored = (await store.readChange(a.changeId))?.plan
    expect(stored?.preconditionFingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Same ops, but the provider's version moved: another fingerprint, another hash.
    const thing = provider.things.get(row.external_id as string) as Thing
    thing.version = 9
    const c = await engine.planResourceChange(req, ADMIN)
    expect(c.ops.map((o) => o.kind)).toEqual(['update'])
    expect(c.planHash).not.toBe(a.planHash)
    expect((await store.readChange(c.changeId))?.plan?.preconditionFingerprint).not.toBe(
      stored?.preconditionFingerprint
    )
    // Other fields to apply: another hash.
    const d = await engine.planResourceChange(
      appReq([{ action: 'update', resourceId: row.id, fields: { size: 6 } }]),
      ADMIN
    )
    expect(d.planHash).not.toBe(c.planHash)
  })

  it('stale hash → STALE_PLAN', async () => {
    const row = await createBox('gamma', { size: 1 })
    const p = await engine.planResourceChange(
      appReq([{ action: 'update', resourceId: row.id, fields: { size: 2 } }]),
      ADMIN
    )
    await expect(
      engine.startResourceChange(p.changeId, { planHash: 'f'.repeat(64) }, ADMIN)
    ).rejects.toMatchObject({ code: 'STALE_PLAN', status: 409 })
    // The provider changed after the plan: the start re-reads, refuses, and the change is stale.
    ;(provider.things.get(row.external_id as string) as Thing).version++
    await expect(
      engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    ).rejects.toMatchObject({ code: 'STALE_PLAN' })
    expect((await store.readChange(p.changeId))?.status).toBe('stale')
    expect(provider.calls.filter((c) => c.kind === 'update')).toHaveLength(0)
  })

  it('orders an in-change parent first (negative ref = request op)', async () => {
    const p = await engine.planResourceChange(
      appReq([
        {
          action: 'create',
          type: 'fake.box',
          fields: { name: 'child', parent: { resourceId: -2 } }
        },
        { action: 'create', type: 'fake.box', fields: { name: 'parent' } }
      ]),
      ADMIN
    )
    expect(p.ops.map((o) => o.reason)).toEqual(['Create box parent.', 'Create box child.'])
    await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    const rows = await store.listResources({ type: 'fake.box' })
    const parent = rows.find((r) => r.name === 'parent')
    const child = rows.find((r) => r.name === 'child')
    expect(child?.desired?.parent).toEqual({ resourceId: parent?.id })
    expect(child?.refs).toEqual([{ field: 'parent', resourceId: parent?.id }])
    expect(provider.things.get(child?.external_id as string)?.fields.parent).toBe(
      parent?.external_id
    )
  })

  it('refuses bad fields before any provider call', async () => {
    await expect(
      engine.planResourceChange(
        appReq([{ action: 'create', type: 'fake.box', fields: { size: 'big', nope: 1 } }]),
        ADMIN
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS', details: { problems: expect.any(Array) } })
    await expect(
      engine.planResourceChange(
        appReq([{ action: 'create', type: 'other.box', fields: { name: 'x' } }]),
        ADMIN
      )
    ).rejects.toMatchObject({ code: 'UNKNOWN_TYPE' })
  })

  it('turns a findExisting hit into ALREADY_EXISTS (never adopts by itself)', async () => {
    provider.existing = {
      type: 'fake.box',
      externalId: 'box-77',
      name: 'dup',
      fields: { name: 'dup' },
      tags: {}
    }
    const p = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'dup' } }]),
      ADMIN
    )
    expect(p.blockers.map((b) => b.code)).toEqual(['ALREADY_EXISTS'])
    await expect(
      engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(await store.listResources({ type: 'fake.box' })).toHaveLength(0)
  })
})

describe('run', () => {
  it('stops on precondition change', async () => {
    const a = await createBox('one', { size: 1 })
    const b = await createBox('two', { size: 1 })
    const p = await engine.planResourceChange(
      appReq([
        { action: 'update', resourceId: a.id, fields: { size: 2 } },
        { action: 'update', resourceId: b.id, fields: { size: 2 } }
      ]),
      ADMIN
    )
    provider.calls = []
    // While the first step runs, someone changes the second resource at the provider.
    provider.onApply = (op) => {
      if (op.externalId === a.external_id) {
        const t = provider.things.get(b.external_id as string) as Thing
        t.fields.size = 40
        t.version++
      }
    }
    const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    expect(out.status).toBe('failed')
    const ch = await store.readChange(p.changeId)
    expect(ch?.error_code).toBe('PRECONDITION_CHANGED')
    expect(ch?.steps.map((s) => s.status)).toEqual(['done', 'failed'])
    expect(ch?.steps[1].error).toMatchObject({ code: 'PRECONDITION_CHANGED', retryable: false })
    expect(provider.calls.map((c) => c.ext)).toEqual([a.external_id])
    expect(provider.things.get(b.external_id as string)?.fields.size).toBe(40)
    // A precondition change is not retryable: resume is refused (plan again).
    await expect(engine.resumeResourceChange(p.changeId, ADMIN)).rejects.toMatchObject({
      code: 'BAD_STATUS'
    })
  })

  it('resume skips recorded successes', async () => {
    const p = await engine.planResourceChange(
      appReq([
        { action: 'create', type: 'fake.box', fields: { name: 'r1' } },
        { action: 'create', type: 'fake.box', fields: { name: 'r2' } },
        { action: 'create', type: 'fake.box', fields: { name: 'r3' } }
      ]),
      ADMIN
    )
    const { ProviderError } = await import('../../../services/hub/providers/types.js')
    let n = 0
    provider.onApply = () => {
      n++
      if (n === 2)
        throw new ProviderError('RATE_LIMITED', 'slow down', { retryable: true, status: 429 })
    }
    const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    expect(out.status).toBe('failed')
    const failed = await store.readChange(p.changeId)
    expect(failed?.steps.map((s) => s.status)).toEqual(['done', 'failed', 'pending'])
    expect(failed?.steps[1].error).toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: true,
      status: 429
    })
    const done = await engine.resumeResourceChange(p.changeId, ADMIN)
    expect(done.status).toBe('applied')
    expect(provider.calls.map((c) => c.name)).toEqual(['r1', 'r2', 'r2', 'r3'])
    // The row made before the failed call is reused, never a second one.
    expect((await store.listResources({ type: 'fake.box' })).map((r) => r.name).sort()).toEqual([
      'r1',
      'r2',
      'r3'
    ])
  })

  it('interrupted after lost heartbeat', async () => {
    // A Hub that died mid-apply: `applying`, an old heartbeat, no lock.
    const p = await engine.planResourceChange(
      appReq([
        { action: 'create', type: 'fake.box', fields: { name: 'h1' } },
        { action: 'create', type: 'fake.box', fields: { name: 'h2' } },
        { action: 'create', type: 'fake.box', fields: { name: 'h3' } }
      ]),
      ADMIN
    )
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let n = 0
    provider.onApply = async () => {
      if (++n === 2) await gate
    }
    deps.configureResourceEngine({ inline: false, heartbeatMs: 5 })
    await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    await vi.waitFor(() => expect(n).toBe(2))
    // Another process takes the change over: this run's lock renewals fail.
    locks.resetMemoryResourceLocksForTest()
    await locks.memoryResourceLock().take(locks.hubResourceChangeLockKey(p.changeId))
    await new Promise((r) => setTimeout(r, 30))
    release()
    await vi.waitFor(async () =>
      expect((await store.readChange(p.changeId))?.status).toBe('interrupted')
    )
    const ch = await store.readChange(p.changeId)
    expect(ch?.error_code).toBe('LOCK_LOST')
    // The step in flight finished and is recorded; nothing after it was sent.
    expect(ch?.steps.map((s) => s.status)).toEqual(['done', 'done', 'pending'])
    expect(provider.calls.map((c) => c.name)).toEqual(['h1', 'h2'])

    // The heal path: a run row left `applying` by a dead process.
    locks.resetMemoryResourceLocksForTest()
    await store.updateChange(p.changeId, {
      status: 'applying',
      run_key: 'dead',
      heartbeat_at: new Date(Date.now() - 10 * 60_000)
    })
    deps.configureResourceEngine({ inline: true })
    expect(await engine.healResourceChanges()).toBe(1)
    expect((await store.readChange(p.changeId))?.status).toBe('interrupted')
    // A fresh heartbeat is never healed.
    await store.updateChange(p.changeId, { status: 'applying', heartbeat_at: new Date() })
    expect(await engine.healResourceChanges()).toBe(0)
    await store.updateChange(p.changeId, { status: 'interrupted' })
    const before = provider.calls.length
    const out = await engine.resumeResourceChange(p.changeId, ADMIN)
    expect(out.status).toBe('applied')
    // h1 and h2 were recorded done: only h3 runs.
    expect(provider.calls.slice(before).map((c) => c.name)).toEqual(['h3'])
  })

  it('refuses a second run on a resource another change holds (RESOURCE_BUSY)', async () => {
    const row = await createBox('busy', { size: 1 })
    const p = await engine.planResourceChange(
      appReq([{ action: 'update', resourceId: row.id, fields: { size: 3 } }]),
      ADMIN
    )
    await locks.memoryResourceLock().take(locks.hubResourceLockKey(row.id))
    await expect(
      engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    ).rejects.toMatchObject({ code: 'RESOURCE_BUSY' })
    expect((await store.readChange(p.changeId))?.status).toBe('planned')
  })

  it('snapshot taken before delete when type supports it', async () => {
    const row = await createBox('snapme')
    const { out } = await applied(
      appReq([{ action: 'delete', resourceId: row.id }]),
      ADMIN,
      'snapme'
    )
    expect(out.status).toBe('applied')
    const ch = await store.readChange(out.changeId)
    expect(ch?.steps[0].snapshot).toMatchObject({
      kind: 'before_state',
      id: `snap-${row.external_id}`
    })
    expect(ch?.steps[0].before?.externalId).toBe(row.external_id)
    expect((await store.readResource(row.id))?.deleted_at).not.toBeNull()
  })

  it('one-shot trigger: a re-apply after a dispatch does not dispatch again', async () => {
    const row = await createBox('wf')
    const { out } = await applied(
      appReq([{ action: 'update', resourceId: row.id, fields: { dispatch: { ref: 'main' } } }])
    )
    expect(out.status).toBe('applied')
    expect(provider.dispatches).toBe(1)
    expect((await store.readResource(row.id))?.desired).not.toHaveProperty('dispatch')
    const again = await engine.planResourceChange(
      appReq([{ action: 'reapply', resourceId: row.id }]),
      ADMIN
    )
    expect(again.ops.map((o) => o.kind)).toEqual(['noop'])
    await engine.startResourceChange(again.changeId, { planHash: again.planHash }, ADMIN)
    expect(provider.dispatches).toBe(1)
  })

  it('one-shot: a named op clears a changed field the provider does not report back', async () => {
    const { withoutOneShot } = await import('../../../services/hub/providers/engine/run.js')
    const type = {
      ...boxType('fake.box', 'app'),
      fields: boxType('fake.box', 'app').fields.map((f) => ({ ...f, trigger: false }))
    }
    const op = {
      kind: 'update' as const,
      type: 'fake.box',
      resourceId: 1,
      externalId: 'x',
      reason: '',
      changes: [
        { field: 'dispatch', to: true },
        { field: 'size', to: 2 }
      ],
      preconditions: {},
      risk: [],
      action: 'dispatch'
    }
    const after = { type: 'fake.box', externalId: 'x', name: 'x', fields: { size: 2 }, tags: {} }
    expect(withoutOneShot(type, op, { name: 'x', size: 2, dispatch: true }, after)).toEqual({
      name: 'x',
      size: 2
    })
    // A plain write keeps every field.
    const plain = { ...op, action: undefined }
    expect(withoutOneShot(type, plain, { name: 'x', dispatch: true }, after)).toEqual({
      name: 'x',
      dispatch: true
    })
  })

  it('cancel before start and while applying', async () => {
    const p = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'c1' } }]),
      ADMIN
    )
    await expect(engine.cancelResourceChange(p.changeId, STRANGER)).rejects.toMatchObject({
      code: 'ADMIN_ONLY'
    })
    expect((await engine.cancelResourceChange(p.changeId, ADMIN)).status).toBe('cancelled')
    const q = await engine.planResourceChange(
      appReq([
        { action: 'create', type: 'fake.box', fields: { name: 'c2' } },
        { action: 'create', type: 'fake.box', fields: { name: 'c3' } }
      ]),
      ADMIN
    )
    provider.onApply = async () => {
      await engine.cancelResourceChange(q.changeId, ADMIN)
    }
    const out = await engine.startResourceChange(q.changeId, { planHash: q.planHash }, ADMIN)
    expect(out.status).toBe('cancelled')
    expect(provider.calls.map((c) => c.name)).toEqual(['c2'])
  })
})

describe('gates', () => {
  it('typed confirm required for destructive/data_loss', async () => {
    const row = await createBox('doomed')
    const p = await engine.planResourceChange(
      appReq([{ action: 'delete', resourceId: row.id }]),
      ADMIN
    )
    expect(p.needsConfirm).toBe('doomed')
    await expect(
      engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    ).rejects.toMatchObject({ code: 'CONFIRM_MISMATCH', status: 400 })
    await expect(
      engine.startResourceChange(p.changeId, { planHash: p.planHash, confirm: 'Doomed' }, ADMIN)
    ).rejects.toMatchObject({ code: 'CONFIRM_MISMATCH' })
    const out = await engine.startResourceChange(
      p.changeId,
      { planHash: p.planHash, confirm: 'doomed' },
      ADMIN
    )
    expect(out.status).toBe('applied')
    // Several destructive ops: the app key.
    const x = await createBox('x1')
    const y = await createBox('y1')
    const many = await engine.planResourceChange(
      appReq([
        { action: 'delete', resourceId: x.id },
        { action: 'delete', resourceId: y.id }
      ]),
      ADMIN
    )
    expect(many.needsConfirm).toBe('shop')
  })

  it('public_exposure needs admin', async () => {
    const p = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'open', public: true } }]),
      OWNER
    )
    expect(p.blockers.map((b) => b.code)).toContain('ADMIN_ONLY')
    await expect(
      engine.startResourceChange(p.changeId, { planHash: p.planHash }, OWNER)
    ).rejects.toMatchObject({ code: 'ADMIN_ONLY', status: 403 })
    const q = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'open', public: true } }]),
      ADMIN
    )
    expect(q.blockers).toEqual([])
    expect(
      (await engine.startResourceChange(q.changeId, { planHash: q.planHash }, ADMIN)).status
    ).toBe('applied')
  })

  it('cost → pending_approval for owner, direct for admin; approve with stale hash refused', async () => {
    const req = appReq([
      { action: 'create', type: 'fake.box', fields: { name: 'pricey', costly: true } }
    ])
    const p = await engine.planResourceChange(req, OWNER)
    expect(p.needsApproval).toBe(true)
    expect(p.ops[0].risk).toContain('cost')
    const pending = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, OWNER)
    expect(pending.status).toBe('pending_approval')
    expect(provider.calls).toHaveLength(0)
    await expect(
      engine.startResourceChange(p.changeId, { planHash: p.planHash }, OWNER)
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(
      engine.approveResourceChange(p.changeId, { planHash: p.planHash }, OWNER)
    ).rejects.toMatchObject({ code: 'ADMIN_ONLY' })
    await expect(
      engine.approveResourceChange(p.changeId, { planHash: '0'.repeat(64) }, ADMIN)
    ).rejects.toMatchObject({ code: 'STALE_PLAN' })
    const ok = await engine.approveResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    expect(ok.status).toBe('applied')
    expect((await store.readChange(p.changeId))?.approved_by).toBe(ADMIN.id)

    // A plan that moved while it waited: approval refused, the change turns stale.
    const row = (await store.listResources({ type: 'fake.box' }))[0]
    const q = await engine.planResourceChange(
      appReq([{ action: 'update', resourceId: row.id, fields: { size: 9 } }]),
      OWNER
    )
    // (an update of a costly box adds no new cost: runs directly)
    expect(q.needsApproval).toBe(false)
    const r = await engine.planResourceChange(
      appReq([
        {
          action: 'create',
          type: 'fake.box',
          fields: { name: 'pricey2', costly: true, parent: { resourceId: row.id } }
        }
      ]),
      OWNER
    )
    await engine.startResourceChange(r.changeId, { planHash: r.planHash }, OWNER)
    ;(provider.things.get(row.external_id as string) as Thing).version++
    await store.updateResource(row.id, { external_id: 'box-moved' })
    await expect(
      engine.approveResourceChange(r.changeId, { planHash: r.planHash }, ADMIN)
    ).rejects.toMatchObject({ code: 'STALE_PLAN' })
    expect((await store.readChange(r.changeId))?.status).toBe('stale')

    // Admin's own cost change runs directly; an owner's can be declined.
    const a = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'pricey3', costly: true } }]),
      ADMIN
    )
    expect(a.needsApproval).toBe(false)
    expect(
      (await engine.startResourceChange(a.changeId, { planHash: a.planHash }, ADMIN)).status
    ).toBe('applied')
    const d = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'pricey4', costly: true } }]),
      OWNER
    )
    await engine.startResourceChange(d.changeId, { planHash: d.planHash }, OWNER)
    await expect(engine.declineResourceChange(d.changeId, ' ', ADMIN)).rejects.toMatchObject({
      code: 'INVALID_FIELDS'
    })
    const dec = await engine.declineResourceChange(d.changeId, 'Too dear this quarter', ADMIN)
    expect(dec.status).toBe('declined')
    expect((await store.readChange(d.changeId))?.decline_reason).toBe('Too dear this quarter')
  })

  it('a promotion or retirement acts for an owner on its own resources only, never grants the connection', async () => {
    const { judgeAccess } = await import('../../../services/hub/providers/engine/gates.js')
    const conn = await store.readConnection(otherConn)
    if (!conn) throw new Error('no connection')
    const row = await store.insertResource({
      connection_id: otherConn,
      provider: 'fake',
      type: 'fake.box',
      external_id: 'box-carried',
      scope: 'app',
      app_id: appId,
      environment_id: devEnv
    })
    const base = {
      connection: conn,
      scope: 'app' as const,
      appId,
      environmentId: devEnv,
      types: []
    }
    const upd = [{ action: 'update', resourceId: row.id }]
    const del = [{ action: 'delete', resourceId: row.id }]
    // A change on an existing resource, carried by a promotion: allowed per resource.
    await expect(
      judgeAccess({ ...base, rows: [row], carriedBy: 'promotion', requestOps: upd }, OWNER)
    ).resolves.toMatchObject({ app: { id: appId } })
    await expect(
      judgeAccess({ ...base, rows: [row], carriedBy: 'retirement', requestOps: del }, OWNER)
    ).resolves.toMatchObject({ app: { id: appId } })
    // Not carried, a create inside the carried change, or a creation: the allowed list decides.
    await expect(judgeAccess({ ...base, rows: [row] }, OWNER)).rejects.toMatchObject({
      code: 'CONNECTION_NOT_ALLOWED'
    })
    for (const requestOps of [
      [...upd, { action: 'create' }],
      [{ action: 'adopt' }],
      [{ action: 'update', resourceId: row.id + 999 }],
      []
    ])
      await expect(
        judgeAccess({ ...base, rows: [row], carriedBy: 'promotion', requestOps }, OWNER)
      ).rejects.toMatchObject({ code: 'CONNECTION_NOT_ALLOWED' })
    await expect(
      judgeAccess({ ...base, rows: [row], carriedBy: 'creation', requestOps: upd }, OWNER)
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_ALLOWED' })
    // Planned ops are judged too: a grant answer never lets a create or replace through.
    const { assertCarriedGrantOps } = await import(
      '../../../services/hub/providers/engine/gates.js'
    )
    const via = { viaCarriedGrant: true }
    const ids = new Set([row.id])
    expect(() => assertCarriedGrantOps(via, [{ kind: 'update' }], [row.id], ids)).not.toThrow()
    for (const kind of ['create', 'replace'])
      expect(() => assertCarriedGrantOps(via, [{ kind }], [row.id], ids)).toThrow(
        expect.objectContaining({ code: 'CONNECTION_NOT_ALLOWED' })
      )
    expect(() => assertCarriedGrantOps(via, [{ kind: 'update' }], [null], ids)).toThrow()
    expect(() =>
      assertCarriedGrantOps({ viaCarriedGrant: false }, [{ kind: 'create' }], [null], ids)
    ).not.toThrow()
    const granted = await judgeAccess(
      { ...base, rows: [row], carriedBy: 'promotion', requestOps: upd },
      OWNER
    )
    expect(granted.viaCarriedGrant).toBe(true)
    // The allowed list itself never grows.
    expect(await store.appAllowedConnections(appId)).toEqual([connId])
  })

  it('owner refused on foreign connection and shared scope', async () => {
    await expect(
      engine.planResourceChange(
        {
          ...appReq([{ action: 'create', type: 'fake.box', fields: { name: 'n' } }]),
          connectionId: otherConn
        },
        OWNER
      )
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_ALLOWED', status: 403 })
    await expect(
      engine.planResourceChange(
        {
          connectionId: connId,
          scope: 'shared',
          ops: [{ action: 'create', type: 'fake.net', fields: { name: 'vpc' } }]
        },
        OWNER
      )
    ).rejects.toMatchObject({ code: 'SHARED_ADMIN_ONLY', status: 403 })
    // A shared type smuggled into app scope.
    await expect(
      engine.planResourceChange(
        appReq([{ action: 'create', type: 'fake.net', fields: { name: 'vpc' } }]),
        OWNER
      )
    ).rejects.toMatchObject({ code: 'SHARED_ADMIN_ONLY' })
    await expect(
      engine.planResourceChange(
        appReq([{ action: 'create', type: 'fake.box', fields: { name: 'n' } }]),
        STRANGER
      )
    ).rejects.toMatchObject({ code: 'ADMIN_ONLY', status: 403 })
    // Refused before any provider call.
    expect(provider.observes + provider.calls.length).toBe(0)
    // The allowed connection works for the owner.
    const ok = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'n' } }]),
      OWNER
    )
    expect(
      (await engine.startResourceChange(ok.changeId, { planHash: ok.planHash }, OWNER)).status
    ).toBe('applied')
    // An agent and View-as plan, never apply.
    const mcp = { ...ADMIN, via: 'mcp' as const }
    const m = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'm' } }]),
      mcp
    )
    await expect(
      engine.startResourceChange(m.changeId, { planHash: m.planHash }, mcp)
    ).rejects.toMatchObject({ code: 'HUB_WRITE_NOT_FOR_AGENTS' })
    await expect(
      engine.startResourceChange(m.changeId, { planHash: m.planHash }, { ...ADMIN, via: 'view_as' })
    ).rejects.toMatchObject({ code: 'DELEGATED_NO_WRITE' })
  })

  it('refs stay inside the environment: never across to production', async () => {
    await db('nivaro_hub_apps').where({ id: appId }).update({ owners_deploy_production: false })
    const prodBox = await createBox('prod-db', {}, prodEnv)
    const ref = (resourceId: number, actor: HubActor) =>
      engine.planResourceChange(
        appReq([
          { action: 'create', type: 'fake.box', fields: { name: 'stg', parent: { resourceId } } }
        ]),
        actor
      )
    // An owner's dev change pointing at a production resource: refused before any provider call.
    provider.observes = 0
    await expect(ref(prodBox.id, OWNER)).rejects.toMatchObject({
      code: 'INVALID_FIELDS',
      message: expect.stringContaining(
        "must point at this environment's resources, an app-level one, or a shared one"
      )
    })
    // Cross-environment refs are refused for admins too (none are needed: shared and app-level
    // resources cover what environments share).
    await expect(ref(prodBox.id, ADMIN)).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    expect(provider.observes).toBe(0)
    // An app-level resource (no environment) of the same app is allowed.
    const { out } = await applied({
      connectionId: connId,
      scope: 'app',
      appId,
      ops: [{ action: 'create', type: 'fake.box', fields: { name: 'app-wide' } }]
    })
    expect(out.status).toBe('applied')
    const appWide = (await store.listResources({ type: 'fake.box' })).find(
      (r) => r.name === 'app-wide'
    )
    expect(appWide?.environment_id).toBeNull()
    const ok = await ref(appWide?.id as number, OWNER)
    expect(ok.blockers).toEqual([])
    expect(
      (await engine.startResourceChange(ok.changeId, { planHash: ok.planHash }, OWNER)).status
    ).toBe('applied')
  })

  it('SHARED_IN_USE refuses delete of referenced shared resource', async () => {
    const shared = { connectionId: connId, scope: 'shared' as const }
    const n = await engine.planResourceChange(
      { ...shared, ops: [{ action: 'create', type: 'fake.net', fields: { name: 'vpc' } }] },
      ADMIN
    )
    await engine.startResourceChange(n.changeId, { planHash: n.planHash }, ADMIN)
    const net = (await store.listResources({ type: 'fake.net' }))[0]
    expect(net.scope).toBe('shared')
    const box = await createBox('uses-net', { net: { resourceId: net.id } })
    expect(provider.things.get(box.external_id as string)?.fields.net).toBe(net.external_id)
    const del = await engine.planResourceChange(
      { ...shared, ops: [{ action: 'delete', resourceId: net.id }] },
      ADMIN
    )
    expect(del.blockers.map((b) => b.code)).toEqual(['SHARED_IN_USE'])
    await expect(
      engine.startResourceChange(del.changeId, { planHash: del.planHash, confirm: 'vpc' }, ADMIN)
    ).rejects.toMatchObject({ code: 'SHARED_IN_USE', status: 409 })
    expect(provider.things.has(net.external_id as string)).toBe(true)
  })

  it('BUCKET_NOT_EMPTY: refused at the provider; deleteAllObjects is an admin typing the phrase', async () => {
    const row = await createBox('bucket1')
    ;(provider.things.get(row.external_id as string) as Thing).objects = 3
    const { out } = await applied(
      appReq([{ action: 'delete', resourceId: row.id }]),
      ADMIN,
      'bucket1'
    )
    expect(out.status).toBe('failed')
    const ch = await store.readChange(out.changeId)
    expect(ch?.error_code).toBe('BUCKET_NOT_EMPTY')
    expect(ch?.steps[0].error).toMatchObject({ code: 'BUCKET_NOT_EMPTY', retryable: false })
    expect((await store.readResource(row.id))?.deleted_at).toBeNull()
    await expect(
      engine.planResourceChange(
        appReq([{ action: 'delete', resourceId: row.id, fields: { deleteAllObjects: true } }]),
        OWNER
      )
    ).rejects.toMatchObject({ code: 'ADMIN_ONLY' })
    const all = await engine.planResourceChange(
      appReq([{ action: 'delete', resourceId: row.id, fields: { deleteAllObjects: true } }]),
      ADMIN
    )
    expect(all.needsConfirm).toBe('delete all objects in bucket1')
    expect(all.ops[0].risk).toEqual(expect.arrayContaining(['destructive', 'data_loss']))
    await expect(
      engine.startResourceChange(
        all.changeId,
        { planHash: all.planHash, confirm: 'bucket1' },
        ADMIN
      )
    ).rejects.toMatchObject({ code: 'CONFIRM_MISMATCH' })
    const done = await engine.startResourceChange(
      all.changeId,
      { planHash: all.planHash, confirm: 'delete all objects in bucket1' },
      ADMIN
    )
    expect(done.status).toBe('applied')
    expect(provider.things.has(row.external_id as string)).toBe(false)
  })

  it('FROZEN / MOVE_OPEN / production owner gate', async () => {
    const req = appReq([{ action: 'create', type: 'fake.box', fields: { name: 'gated' } }])
    await db('nivaro_hub_freezes').insert({
      app_id: null,
      name: 'Year end',
      recurrence: 'none',
      starts_at: new Date(Date.now() - 60_000),
      ends_at: new Date(Date.now() + 3_600_000)
    })
    const p = await engine.planResourceChange(req, ADMIN)
    expect(p.gates.find((g) => g.code === 'FROZEN')).toMatchObject({ passed: false })
    await expect(
      engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    ).rejects.toMatchObject({ code: 'FROZEN', status: 409 })
    await db('nivaro_hub_freezes').del()

    await db('nivaro_hub_moves').insert({
      app_id: appId,
      environment_id: devEnv,
      from_placement_id: 1,
      to_placement_id: 2,
      kind: 'to_shared',
      routing: 'manual',
      status: 'running',
      steps: '[]'
    })
    const q = await engine.planResourceChange(req, ADMIN)
    expect(q.gates.find((g) => g.code === 'MOVE_OPEN')).toMatchObject({ passed: false })
    await expect(
      engine.startResourceChange(q.changeId, { planHash: q.planHash }, ADMIN)
    ).rejects.toMatchObject({ code: 'MOVE_OPEN' })
    await db('nivaro_hub_moves').del()

    // Production: owners only with owners_deploy_production; admins always.
    const prod = appReq([{ action: 'create', type: 'fake.box', fields: { name: 'live' } }], prodEnv)
    await expect(engine.planResourceChange(prod, OWNER)).rejects.toMatchObject({
      code: 'PRODUCTION_ADMIN_ONLY',
      status: 403
    })
    await db('nivaro_hub_apps').where({ id: appId }).update({ owners_deploy_production: true })
    const o = await engine.planResourceChange(prod, OWNER)
    expect(o.gates.find((g) => g.code === 'PRODUCTION_ADMIN_ONLY')).toMatchObject({
      passed: true,
      message: 'Production environment.'
    })
    await db('nivaro_hub_apps').where({ id: appId }).update({ owners_deploy_production: false })
    const a = await engine.planResourceChange(prod, ADMIN)
    expect(
      (await engine.startResourceChange(a.changeId, { planHash: a.planHash }, ADMIN)).status
    ).toBe('applied')
  })
})

describe('ways back', () => {
  it('undo plans back to before-state', async () => {
    const row = await createBox('first', { size: 1 })
    const { out } = await applied(
      appReq([{ action: 'update', resourceId: row.id, fields: { name: 'second', size: 2 } }])
    )
    expect(out.status).toBe('applied')
    const undo = await engine.undoResourceChange(out.changeId, ADMIN)
    expect(undo.status).toBe('planned')
    expect(undo.ops[0].kind).toBe('update')
    expect(undo.ops[0].changes).toEqual([
      { field: 'name', from: 'second', to: 'first' },
      { field: 'size', from: 2, to: 1 }
    ])
    expect((await store.readChange(undo.changeId))?.plan?.undoOf).toBe(out.changeId)
    expect(
      (await engine.startResourceChange(undo.changeId, { planHash: undo.planHash }, ADMIN)).status
    ).toBe('applied')
    expect(provider.things.get(row.external_id as string)?.fields).toMatchObject({
      name: 'first',
      size: 1
    })
    // Only the newest change of a resource can be undone.
    await expect(engine.undoResourceChange(out.changeId, ADMIN)).rejects.toMatchObject({
      code: 'NOT_REVERSIBLE'
    })
    // A create is undone by a delete.
    const made = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'temp' } }]),
      ADMIN
    )
    await engine.startResourceChange(made.changeId, { planHash: made.planHash }, ADMIN)
    const back = await engine.undoResourceChange(made.changeId, ADMIN)
    expect(back.ops.map((o) => o.kind)).toEqual(['delete'])
    expect(back.needsConfirm).toBe('temp')
  })

  it('audit rows hub-resource-* with field names only', async () => {
    const row = await createBox('audited', { size: 1, token: SECRET })
    await applied(
      appReq([
        { action: 'update', resourceId: row.id, fields: { name: 'zebra-value', token: SECRET2 } }
      ])
    )
    const calls = vi
      .mocked(logActivity)
      .mock.calls.map((c) => c[0] as { action: string; comment?: string; collection?: string })
    const actions = calls.map((c) => c.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'hub-resource-change-start',
        'hub-resource-create',
        'hub-resource-update',
        'hub-resource-change-end'
      ])
    )
    expect(actions.every((a) => a.startsWith('hub-resource-'))).toBe(true)
    expect(calls.every((c) => c.collection === 'nivaro_hub_resource_changes')).toBe(true)
    const update = calls.find((c) => c.action === 'hub-resource-update')
    expect(JSON.parse(update?.comment ?? '{}').fields).toEqual(['name', 'token'])
    const all = calls.map((c) => c.comment ?? '').join('\n')
    expect(all).not.toContain('zebra-value')
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain(SECRET2)
  })
})

describe('secrets', () => {
  it('never stores a plain secret value in the change or resource rows', async () => {
    const p = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'vault', token: SECRET } }]),
      ADMIN
    )
    expect(JSON.stringify(p)).not.toContain(SECRET)
    expect(p.ops[0].changes).toContainEqual({ field: 'token', secret: true })
    const raw = await rawChange(p.changeId)
    expect(JSON.stringify(raw)).not.toContain(SECRET)
    const plan = JSON.parse(String(raw.plan))
    expect(plan.request.ops[0].fields.token).toEqual({
      fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
      changed: true
    })
    await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    expect(provider.tokensSeen).toEqual([SECRET])
    expect(JSON.stringify(await rawChange(p.changeId))).not.toContain(SECRET)
    const resRaw = await db('nivaro_hub_resources').first()
    expect(JSON.stringify(resRaw)).not.toContain(SECRET)

    // An update that does not touch the secret still hands its plain value to apply.
    const row = (await store.listResources({ type: 'fake.box' }))[0]
    const keep = await engine.planResourceChange(
      appReq([{ action: 'update', resourceId: row.id, fields: { size: 4, token: HUB_MASK } }]),
      ADMIN
    )
    expect(keep.ops[0].changes).toEqual([{ field: 'size', to: 4 }])
    await engine.startResourceChange(keep.changeId, { planHash: keep.planHash }, ADMIN)
    expect(provider.tokensSeen.at(-1)).toBe(SECRET)
    const step = (await store.readChange(keep.changeId))?.steps[0]
    expect(JSON.stringify(step)).not.toContain(SECRET)
  })

  it('scrubs a plain secret a provider error echoes', async () => {
    const { ProviderError } = await import('../../../services/hub/providers/types.js')
    const p = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name: 'leaky', token: SECRET } }]),
      ADMIN
    )
    provider.failNext = new ProviderError(
      'BAD_TOKEN',
      `token ${SECRET} rejected (key test-secret-connection-key)`,
      { status: 400 }
    )
    const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    expect(out.status).toBe('failed')
    const ch = await store.readChange(p.changeId)
    expect(ch?.steps[0].error?.message).toContain(HUB_MASK)
    expect(JSON.stringify(ch)).not.toContain(SECRET)
    expect(JSON.stringify(ch)).not.toContain('test-secret-connection-key')
    const all = vi
      .mocked(logActivity)
      .mock.calls.map((c) => JSON.stringify(c[0]))
      .join('\n')
    expect(all).not.toContain(SECRET)
  })
})

const discard = await import('../../../services/hub/providers/engine/discard.js')

describe('a create that never reached the provider (Task 3b D)', () => {
  async function failedCreate(name: string, error: Error, actor: HubActor = ADMIN) {
    const p = await engine.planResourceChange(
      appReq([{ action: 'create', type: 'fake.box', fields: { name } }]),
      actor
    )
    provider.failNext = error
    const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, actor)
    expect(out.status).toBe('failed')
    const row = (await store.listResources({ type: 'fake.box' })).find((r) => r.name === name)
    if (!row) throw new Error('no row')
    return { changeId: p.changeId, row }
  }

  it('marks the row with its change; AUTH_FAILED keeps its code and is not resumable', async () => {
    const { changeId, row } = await failedCreate(
      'keyless',
      new PE('AUTH_FAILED', 'AWS refused the connection’s keys (AuthFailure).', { status: 401 })
    )
    expect(row.external_id).toBeNull()
    expect(discard.createChangeIdOf(row)).toBe(changeId)
    const ch = await store.readChange(changeId)
    expect(ch?.error_code).toBe('AUTH_FAILED')
    expect(ch?.steps[0].error).toMatchObject({ code: 'AUTH_FAILED', retryable: false })
    expect(discard.pendingCreateOf(row, ch)).toEqual({
      change_id: changeId,
      status: 'failed',
      resumable: false
    })
  })

  it('AUTH_FAILED stays refused while the keys are the same (Task 11c)', async () => {
    const { changeId, row } = await failedCreate(
      'same-keys',
      new PE('AUTH_FAILED', 'Vercel refused the token.', { status: 401 })
    )
    const conn = await store.readConnection(connId)
    const ch = await store.readChange(changeId)
    expect(ch?.steps[0].connectionFingerprint).toBe(conn?.secret_fingerprint)
    expect(discard.pendingCreateOf(row, ch, conn?.secret_fingerprint)?.resumable).toBe(false)
    await expect(engine.resumeResourceChange(changeId, ADMIN)).rejects.toMatchObject({
      code: 'BAD_STATUS'
    })
    expect((await store.readChange(changeId))?.status).toBe('failed')
  })

  it('AUTH_FAILED resumes once the connection keys changed (Task 11c)', async () => {
    const { changeId, row } = await failedCreate(
      'new-keys',
      new PE('AUTH_FAILED', 'Vercel refused the token.', { status: 401 })
    )
    const before = await store.readConnection(connId)
    await store.updateConnection(connId, { secrets: { apiKey: 'test-secret-rotated-key' } })
    try {
      const now = await store.readConnection(connId)
      expect(now?.secret_fingerprint).not.toBe(before?.secret_fingerprint)
      const ch = await store.readChange(changeId)
      expect(discard.pendingCreateOf(row, ch, now?.secret_fingerprint)?.resumable).toBe(true)
      // Unknown fingerprint (a caller that did not read the connection) never lets it through.
      expect(discard.pendingCreateOf(row, ch)?.resumable).toBe(false)
      const done = await engine.resumeResourceChange(changeId, ADMIN)
      expect(done.status).toBe('applied')
      expect((await store.readResource(row.id))?.external_id).toBeTruthy()
    } finally {
      await store.updateConnection(connId, { secrets: { apiKey: 'test-secret-connection-key' } })
    }
  })

  it('a retryable failure is resumable, and the resumed create clears the mark', async () => {
    const { changeId, row } = await failedCreate(
      'later',
      new PE('RATE_LIMITED', 'slow down', { retryable: true, status: 429 })
    )
    expect(discard.pendingCreateOf(row, await store.readChange(changeId))?.resumable).toBe(true)
    const done = await engine.resumeResourceChange(changeId, ADMIN)
    expect(done.status).toBe('applied')
    const after = await store.readResource(row.id)
    expect(after?.external_id).toBeTruthy()
    expect(after && discard.createChangeIdOf(after)).toBeNull()
    expect(after && discard.pendingCreateOf(after, null)).toBeNull()
  })

  it('discard drops the row with no provider call, closes the change and audits it', async () => {
    const { changeId, row } = await failedCreate(
      'gone-soon',
      new PE('AUTH_FAILED', 'bad keys', { status: 403 })
    )
    provider.calls = []
    const observes = provider.observes
    vi.mocked(logActivity).mockClear()
    const out = await engine.discardResourceCreate(row.id, ADMIN)
    expect(out).toEqual({ resourceId: row.id, changeId })
    expect(provider.calls).toEqual([])
    expect(provider.observes).toBe(observes)
    expect((await store.readResource(row.id))?.deleted_at).toBeTruthy()
    expect((await store.listResources({ type: 'fake.box' })).map((r) => r.id)).not.toContain(row.id)
    const ch = await store.readChange(changeId)
    expect(ch).toMatchObject({ status: 'cancelled', error_code: 'DISCARDED' })
    const audit = vi.mocked(logActivity).mock.calls.map((c) => c[0] as { action: string })
    expect(audit.map((a) => a.action)).toEqual(['hub-resource-discard'])
    // The change cannot be resumed into the row that is gone.
    await expect(engine.resumeResourceChange(changeId, ADMIN)).rejects.toMatchObject({
      code: 'BAD_STATUS'
    })
    await expect(engine.discardResourceCreate(row.id, ADMIN)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('the person who started it may discard; anyone else may not', async () => {
    const { row } = await failedCreate('owned', new PE('AUTH_FAILED', 'no', { status: 401 }), OWNER)
    await expect(engine.discardResourceCreate(row.id, STRANGER)).rejects.toMatchObject({
      code: 'ADMIN_ONLY'
    })
    await expect(
      engine.discardResourceCreate(row.id, { ...OWNER, via: 'mcp' })
    ).rejects.toMatchObject({ code: 'HUB_WRITE_NOT_FOR_AGENTS' })
    await expect(engine.discardResourceCreate(row.id, OWNER)).resolves.toMatchObject({
      resourceId: row.id
    })
  })

  it('refuses while the change runs, and for a resource the provider has', async () => {
    const { changeId, row } = await failedCreate('busy', new PE('AUTH_FAILED', 'no'))
    await db('nivaro_hub_resource_changes')
      .where({ id: changeId })
      .update({ status: 'applying', heartbeat_at: new Date(), run_key: 'r1' })
    await expect(engine.discardResourceCreate(row.id, ADMIN)).rejects.toMatchObject({
      code: 'RESOURCE_BUSY'
    })
    const real = await createBox('real')
    await expect(engine.discardResourceCreate(real.id, ADMIN)).rejects.toMatchObject({
      code: 'BAD_STATUS'
    })
    expect((await store.readResource(real.id))?.deleted_at).toBeNull()
  })
})
