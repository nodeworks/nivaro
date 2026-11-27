import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers, Wave 2 framework (Task 13): a resource's outputs and their bindings, against real
// SQLite rows (every Hub migration up to 584) and a fake adapter: an apply's outputs are sealed and
// never stored anywhere else, a once-only output is never re-read (only rotated), a stack binding
// saves the stack's settings without deploying, app settings go through the hub link only for
// allow-listed keys, and owners bind only their own app's environments.

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
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, unknown>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const id = req.headers['x-user']
    if (typeof id !== 'string') throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(sign), authenticate: vi.fn(sign) }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { logActivity } = await import('../../../services/activity.js')
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const engine = await import('../../../services/hub/providers/engine/contract.js')
const deps = await import('../../../services/hub/providers/engine/deps.js')
const locks = await import('../../../services/hub/providers/engine/locks.js')
const bindings = await import('../../../services/hub/providers/engine/bindings.js')
const link = await import('../../../services/hub/providers/app-settings-link.js')
const { applyHubSettings } = await import('../../../services/hub-link/settings-apply.js')
const { openSecret, sealSecret } = await import('../../../services/hub/secrets.js')
const stack = await import('../../../services/hub/docker/stack-settings.js')
const Fastify = (await import('fastify')).default
const { hubProviderOutputRoutes } = await import('../../../routes/hub-provider-outputs.js')

import type { HubActor } from '../../../services/hub/providers/engine/contract.js'
import type { HubResourceRow } from '../../../services/hub/providers/store.js'
import type {
  DesiredResource,
  Observed,
  OpResult,
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
  '582_hub_providers',
  '584_hub_provider_bindings'
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

const DSN = 'postgres://app:test-secret-dsn-password-5521@db.fake.example/app'
const URL_OUT = 'https://db.fake.example/console/app'
const KEY = 'test-secret-once-only-key-8830'
const KEY2 = 'test-secret-rotated-key-4417'
const HUB_TOKEN = 'test-secret-hub-token-for-dev-environment-0001'

// ── The fake provider: a database that hands out a DSN, a URL and a once-only key ──

const provider = {
  things: new Map<string, { name: string; version: number }>(),
  n: 0,
  reads: 0,
  nextKey: KEY
}

const dbType: ResourceTypeSpec = {
  key: 'fakeout.db',
  label: 'Database',
  scope: 'app',
  fields: [
    { key: 'name', label: 'Name', kind: 'string', required: true },
    { key: 'rotate_outputs', label: 'Rotate the key', kind: 'boolean', trigger: true }
  ],
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
  risk: () => [],
  outputs: [
    { key: 'dsn', label: 'Connection string', secret: true },
    { key: 'url', label: 'Console URL', secret: false },
    { key: 'key', label: 'Service key', secret: true, onceOnly: true }
  ]
}
const sharedType: ResourceTypeSpec = { ...dbType, key: 'fakeout.shared', scope: 'shared' }

const observedOf = (id: string): Observed | null => {
  const t = provider.things.get(id)
  return t
    ? { type: 'fakeout.db', externalId: id, name: t.name, fields: { name: t.name }, tags: {} }
    : null
}

function plan(
  _ctx: unknown,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) return []
  const base = { type: desired.type, resourceId: desired.resourceId, risk: [], preconditions: {} }
  if (!observed)
    return [
      { ...base, kind: 'create', externalId: null, reason: 'Create the database.', changes: [] }
    ]
  if (desired.fields.rotate_outputs === true)
    return [
      {
        ...base,
        kind: 'update',
        externalId: observed.externalId,
        action: 'rotate',
        reason: 'Rotate the service key.',
        changes: [{ field: 'rotate_outputs', to: true }]
      }
    ]
  return []
}

const fakeAdapter: ProviderAdapter = {
  key: 'fakeout',
  label: 'Fake outputs',
  connection: {
    fields: [{ key: 'apiKey', label: 'Key', kind: 'string', secret: true }],
    hosts: () => ['api.fake.example'],
    describe: () => 'Fake'
  },
  types: [dbType, sharedType],
  testConnection: async () => ({ ok: true, identity: 'fake', permissions: [], missing: [] }),
  observe: async (_ctx, _type, id) => observedOf(id),
  list: async () => ({ items: [], cursor: null }),
  plan: plan as ProviderAdapter['plan'],
  async apply(_ctx, op, desired): Promise<OpResult> {
    if (op.kind === 'create') {
      const id = `db-${++provider.n}`
      provider.things.set(id, { name: String(desired?.fields.name), version: 1 })
      return {
        ok: true,
        externalId: id,
        // An adapter that echoes a value in its answer and observed state: both get scrubbed.
        observed: {
          ...(observedOf(id) as Observed),
          fields: { name: String(desired?.fields.name), dsn: DSN }
        },
        answer: { request: 'r-1', note: `made ${DSN}` },
        outputs: { dsn: DSN, url: URL_OUT, key: KEY, undeclared: 'test-secret-undeclared-0000' }
      }
    }
    if (op.action === 'rotate') {
      const id = op.externalId as string
      return {
        ok: true,
        externalId: id,
        observed: observedOf(id),
        outputs: { key: provider.nextKey }
      }
    }
    return { ok: true, externalId: op.externalId, observed: observedOf(op.externalId as string) }
  },
  async readOutputs() {
    provider.reads++
    // The provider answers the once-only key too: the engine must drop it.
    return { dsn: DSN, url: URL_OUT, key: 'test-secret-should-never-be-stored-1' }
  }
}

// ── Fixtures ──

let appId: number
let otherApp: number
let devEnv: number
let prodEnv: number
let otherEnv: number
let connId: number

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  await db.schema.createTable('nivaro_settings', (t) => {
    t.increments('id')
    t.string('smtp_host')
    t.integer('smtp_port')
    t.text('smtp_pass')
    t.dateTime('updated_at')
  })
  appId = Number((await db('nivaro_hub_apps').insert({ key: 'shop', name: 'Shop' }))[0])
  otherApp = Number((await db('nivaro_hub_apps').insert({ key: 'blog', name: 'Blog' }))[0])
  devEnv = Number(
    (
      await db('nivaro_hub_environments').insert({
        app_id: appId,
        key: 'dev',
        position: 0,
        base_url: 'https://dev.example.com',
        hub_token: sealSecret(HUB_TOKEN)
      })
    )[0]
  )
  prodEnv = Number(
    (
      await db('nivaro_hub_environments').insert({
        app_id: appId,
        key: 'production',
        position: 1,
        base_url: 'https://prod.example.com'
      })
    )[0]
  )
  otherEnv = Number(
    (
      await db('nivaro_hub_environments').insert({
        app_id: otherApp,
        key: 'dev',
        position: 0,
        base_url: 'https://blog-dev.example.com'
      })
    )[0]
  )
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER.id })
  connId = (
    await store.createConnection({
      provider: 'fakeout',
      name: 'Fake',
      config: {},
      secrets: { apiKey: 'test-secret-connection-key' }
    })
  ).id
  await store.setAppAllowedConnections(appId, [connId])
})

afterAll(async () => {
  link._setAppSettingsFetchForTests(null)
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
  Object.assign(provider, { things: new Map(), reads: 0, nextKey: KEY })
  vi.mocked(logActivity).mockClear()
  link._setAppSettingsFetchForTests(null)
  for (const t of [
    'nivaro_hub_resources',
    'nivaro_hub_resource_changes',
    'nivaro_hub_resource_outputs',
    'nivaro_hub_resource_bindings',
    'nivaro_hub_stack_settings',
    'nivaro_hub_deploys'
  ])
    await db(t).del()
})

async function created(): Promise<HubResourceRow> {
  const p = await engine.planResourceChange(
    {
      connectionId: connId,
      scope: 'app',
      appId,
      environmentId: devEnv,
      ops: [{ action: 'create', type: 'fakeout.db', fields: { name: 'orders' } }]
    },
    ADMIN
  )
  const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
  expect(out.status).toBe('applied')
  const [row] = await store.listResources({ type: 'fakeout.db' })
  return row
}

const everything = async () =>
  JSON.stringify({
    resources: await db('nivaro_hub_resources').select('*'),
    changes: await db('nivaro_hub_resource_changes').select('*'),
    bindings: await db('nivaro_hub_resource_bindings').select('*'),
    audit: vi.mocked(logActivity).mock.calls
  })

describe('outputs', () => {
  it('output value sealed and absent from observed, steps, audit', async () => {
    const row = await created()
    const stored = await db('nivaro_hub_resource_outputs')
      .where({ resource_id: row.id })
      .orderBy('key')
      .select('key', 'value', 'fingerprint')
    // Declared outputs only: the undeclared key is dropped.
    expect(stored.map((r) => r.key)).toEqual(['dsn', 'key', 'url'])
    for (const r of stored) {
      expect(r.value).not.toContain('test-secret')
      expect(r.fingerprint).toMatch(/^[0-9a-f]{32}$/)
    }
    expect(openSecret(stored.find((r) => r.key === 'dsn')?.value)).toBe(DSN)
    const all = await everything()
    for (const v of [DSN, KEY, 'test-secret-dsn-password-5521', 'test-secret-undeclared-0000'])
      expect(all).not.toContain(v)
    // The view answers keys, fingerprints and times — never a value.
    const view = await bindings.outputsView(row)
    expect(view.map((o) => [o.key, o.set, o.lost])).toEqual([
      ['dsn', true, false],
      ['url', true, false],
      ['key', true, false]
    ])
    expect(JSON.stringify(view)).not.toContain('test-secret')
  })

  it('onceOnly output lost → rotate op offered, never re-read', async () => {
    const row = await created()
    await db('nivaro_hub_resource_outputs')
      .where({ resource_id: row.id })
      .whereIn('key', ['key', 'url'])
      .del()
    const view = await bindings.outputsView(row)
    expect(view.find((o) => o.key === 'key')).toMatchObject({
      set: false,
      lost: true,
      rotate: true
    })
    expect(view.find((o) => o.key === 'url')).toMatchObject({ set: false, lost: false })

    await bindings.setBindings(
      row,
      [
        {
          output_key: 'key',
          environment_id: devEnv,
          target: 'stack_secret',
          target_key: 'DB_PASSWORD'
        },
        {
          output_key: 'url',
          environment_id: devEnv,
          target: 'stack_setting',
          target_key: 'PUBLIC_URL'
        }
      ],
      ADMIN
    )
    const out = await bindings.pushBindings(row.id)
    // The re-readable URL was read again (once); the once-only key never stored from a re-read.
    expect(provider.reads).toBe(1)
    const keys = await db('nivaro_hub_resource_outputs').where({ resource_id: row.id }).pluck('key')
    expect(keys.sort()).toEqual(['dsn', 'url'])
    expect(await everything()).not.toContain('test-secret-should-never-be-stored-1')
    const lost = (await bindings.listBindings(row.id)).find((b) => b.output_key === 'key')
    expect(lost?.last_error).toMatch(/rotate it/)
    expect(out.find((o) => o.bindingId === lost?.id)?.ok).toBe(false)

    // The rotation: a plain update with the trigger field; the new key is sealed, the trigger cleared.
    provider.nextKey = KEY2
    const p = await engine.planResourceChange(
      {
        connectionId: connId,
        scope: 'app',
        appId,
        environmentId: devEnv,
        ops: [{ action: 'update', resourceId: row.id, fields: { rotate_outputs: true } }]
      },
      ADMIN
    )
    expect(p.ops[0]).toMatchObject({ action: 'rotate' })
    await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    const after = await bindings.outputsView((await store.readResource(row.id)) as HubResourceRow)
    expect(after.find((o) => o.key === 'key')).toMatchObject({ set: true, lost: false })
    const sealed = await db('nivaro_hub_resource_outputs')
      .where({ resource_id: row.id, key: 'key' })
      .first('value')
    expect(openSecret(sealed.value)).toBe(KEY2)
    expect((await store.readResource(row.id))?.desired?.rotate_outputs).toBeUndefined()
    expect(await everything()).not.toContain(KEY2)
  })
})

describe('bindings', () => {
  it('binding to stack_secret marks stack needs apply, does not apply', async () => {
    const row = await created()
    await stack.saveStackSettings(devEnv, {
      size: 'small',
      redis: 'bundled',
      publish_port: null,
      settings: {},
      secrets: null
    })
    await bindings.setBindings(
      row,
      [
        {
          output_key: 'dsn',
          environment_id: devEnv,
          target: 'stack_secret',
          target_key: 'DB_PASSWORD'
        }
      ],
      ADMIN
    )
    const [res] = await bindings.pushBindings(row.id)
    expect(res.ok).toBe(true)
    const saved = await stack.readStackSettings(devEnv)
    const map = stack.openSealedMap(saved?.secrets ?? null)
    expect(openSecret(map.DB_PASSWORD)).toBe(DSN)
    // Nothing deployed: no deploy row, and the binding says the stack needs Apply now.
    expect(await db('nivaro_hub_deploys').count({ n: '*' }).first()).toMatchObject({ n: 0 })
    let [view] = await bindings.bindingsView(row)
    expect(view).toMatchObject({
      target: 'stack_secret',
      needs_apply: true,
      stale: false,
      last_error: null
    })
    expect(JSON.stringify(view)).not.toContain('test-secret')
    // A deploy started after the push carries it: no longer needed.
    await db('nivaro_hub_deploys').insert({
      app_id: appId,
      environment_id: devEnv,
      kind: 'promote',
      version: '0.3.217',
      status: 'success',
      started_at: new Date(Date.now() + 1000)
    })
    ;[view] = await bindings.bindingsView(row)
    expect(view.needs_apply).toBe(false)
    // A secret output never binds to a plain setting.
    await expect(
      bindings.setBindings(
        row,
        [
          {
            output_key: 'dsn',
            environment_id: devEnv,
            target: 'stack_setting',
            target_key: 'DB_HOST'
          }
        ],
        ADMIN
      )
    ).rejects.toMatchObject({ code: 'SECRET_TO_PLAIN' })
  })

  it('a secret output lands only in a credential app setting', async () => {
    const { bindingShapeProblem } = await import(
      '../../../services/hub/providers/engine/bindings.js'
    )
    const secret = { key: 'password', label: 'Password', secret: true }
    const plain = { key: 'host', label: 'Host', secret: false }
    const b = (target_key: string) => ({
      output_key: 'password',
      environment_id: devEnv,
      target: 'app_setting' as const,
      target_key
    })
    expect(bindingShapeProblem(secret, b('smtp_pass'))).toBeNull()
    expect(bindingShapeProblem(secret, b('ai_gateway_client_secret'))).toBeNull()
    expect(bindingShapeProblem(secret, b('smtp_host'))).toMatch(/^SECRET_TO_PLAIN/)
    expect(bindingShapeProblem(secret, b('ai_gateway_base_url'))).toMatch(/^SECRET_TO_PLAIN/)
    expect(bindingShapeProblem({ ...plain }, { ...b('smtp_host'), output_key: 'host' })).toBeNull()
  })

  it('app_setting outside allow-list → SETTING_NOT_ALLOWED', async () => {
    const row = await created()
    await expect(
      bindings.setBindings(
        row,
        [
          {
            output_key: 'dsn',
            environment_id: devEnv,
            target: 'app_setting',
            target_key: 'session_policy'
          }
        ],
        ADMIN
      )
    ).rejects.toMatchObject({ code: 'SETTING_NOT_ALLOWED', status: 400 })
    // The app side refuses the whole request on its own, and writes nothing.
    await db('nivaro_settings').insert({ smtp_host: 'old.example', updated_at: new Date() })
    const refused = await applyHubSettings({
      settings: { smtp_host: 'new.example', maintenance_mode: '1' }
    })
    expect(refused).toMatchObject({
      ok: false,
      status: 400,
      code: 'SETTING_NOT_ALLOWED',
      keys: ['maintenance_mode']
    })
    expect((await db('nivaro_settings').first('smtp_host')).smtp_host).toBe('old.example')
    const ok = await applyHubSettings({
      settings: { smtp_pass: 'test-secret-smtp-1', smtp_port: '587' }
    })
    expect(ok).toEqual({ ok: true, applied: ['smtp_pass', 'smtp_port'] })
    expect(await db('nivaro_settings').first('smtp_pass', 'smtp_port')).toEqual({
      smtp_pass: 'test-secret-smtp-1',
      smtp_port: 587
    })
    expect(JSON.stringify(vi.mocked(logActivity).mock.calls)).not.toContain('test-secret-smtp-1')
    expect(
      await applyHubSettings({ settings: { sentry_dsn: 'https://x@sentry.example/1' } })
    ).toMatchObject({
      code: 'SETTING_NOT_ON_THIS_APP'
    })

    // An allow-listed binding goes through the hub link: bearer in its header, value in the body.
    const calls: Array<{ url: string; auth: string; body: string }> = []
    link._setAppSettingsFetchForTests(async (url, init) => {
      const h = init?.headers as Record<string, string>
      calls.push({ url: String(url), auth: h.Authorization, body: String(init?.body) })
      return new Response(JSON.stringify({ applied: ['smtp_pass'] }), { status: 200 })
    })
    await bindings.setBindings(
      row,
      [
        {
          output_key: 'dsn',
          environment_id: devEnv,
          target: 'app_setting',
          target_key: 'smtp_pass'
        }
      ],
      ADMIN
    )
    const [res] = await bindings.pushBindings(row.id)
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://dev.example.com/api/hub-link/settings/apply')
    expect(calls[0].auth).toBe(`Bearer ${HUB_TOKEN}`)
    expect(JSON.parse(calls[0].body)).toEqual({ settings: { smtp_pass: DSN } })
    // The app's refusal lands on the binding, scrubbed.
    link._setAppSettingsFetchForTests(
      async () =>
        new Response(JSON.stringify({ code: 'SETTING_NOT_ALLOWED', message: `no ${DSN}` }), {
          status: 400
        })
    )
    await bindings.pushBindings(row.id)
    const [b] = await bindings.listBindings(row.id)
    expect(b.last_error).toMatch(/^SETTING_NOT_ALLOWED/)
    expect(b.last_error).not.toContain('test-secret')
  })

  it("owner binds only own app's environments", async () => {
    const row = await created()
    const dev = {
      output_key: 'url',
      environment_id: devEnv,
      target: 'stack_setting' as const,
      target_key: 'PUBLIC_URL'
    }
    // Another app's environment: refused for everyone (a resource of an app feeds that app only).
    await expect(
      bindings.setBindings(row, [{ ...dev, environment_id: otherEnv }], OWNER)
    ).rejects.toMatchObject({ code: 'ENV_NOT_OF_APP' })
    await expect(
      bindings.setBindings(row, [{ ...dev, environment_id: otherEnv }], ADMIN)
    ).rejects.toMatchObject({ code: 'ENV_NOT_OF_APP' })
    // Production: the administrators' unless the app lets owners deploy production.
    await expect(
      bindings.setBindings(row, [{ ...dev, environment_id: prodEnv }], OWNER)
    ).rejects.toMatchObject({ code: 'PRODUCTION_ADMIN_ONLY', status: 403 })
    // Someone who does not own the app never learns the resource exists.
    await expect(bindings.setBindings(row, [dev], STRANGER)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    // A shared resource: administrators only.
    const shared = await store.insertResource({
      connection_id: connId,
      provider: 'fakeout',
      type: 'fakeout.shared',
      external_id: 'shared-1',
      name: 'shared',
      scope: 'shared'
    })
    await expect(bindings.setBindings(shared, [dev], OWNER)).rejects.toMatchObject({
      code: 'SHARED_ADMIN_ONLY'
    })
    expect(
      await bindings.setBindings(shared, [{ ...dev, environment_id: otherEnv }], ADMIN)
    ).toHaveLength(1)
    // Their own app's development environment: fine.
    const saved = await bindings.setBindings(row, [dev], OWNER)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ environment_id: devEnv, created_by: OWNER.id })
    // One source per destination: the shared resource already feeds the other env's key, not this one.
    await expect(bindings.setBindings(shared, [dev], ADMIN)).rejects.toMatchObject({
      code: 'BINDING_TAKEN'
    })
  })
})

describe('routes', () => {
  it('answer outputs without values, only to people who may see the resource', async () => {
    const prev = process.env.HUB
    process.env.HUB = 'on'
    const app = Fastify()
    await app.register(hubProviderOutputRoutes, { prefix: '/api/hub' })
    await app.ready()
    try {
      const row = await created()
      const as = (u: HubActor) => ({ 'x-user': u.id, ...(u.isAdmin ? { 'x-admin': '1' } : {}) })
      const url = `/api/hub/resources/${row.id}/bindings`
      expect((await app.inject({ method: 'GET', url, headers: as(STRANGER) })).statusCode).toBe(404)
      const mine = await app.inject({ method: 'GET', url, headers: as(OWNER) })
      expect(mine.statusCode).toBe(200)
      expect(mine.json().data.outputs).toHaveLength(3)
      expect(mine.body).not.toContain('test-secret')
      const put = await app.inject({
        method: 'PUT',
        url,
        headers: as(OWNER),
        payload: {
          bindings: [
            {
              output_key: 'url',
              environment_id: devEnv,
              target: 'stack_setting',
              target_key: 'PUBLIC_URL'
            }
          ]
        }
      })
      expect(put.statusCode).toBe(200)
      expect(put.json().data.bindings).toHaveLength(1)
      const bad = await app.inject({
        method: 'PUT',
        url,
        headers: as(OWNER),
        payload: {
          bindings: [
            {
              output_key: 'dsn',
              environment_id: devEnv,
              target: 'app_setting',
              target_key: 'db_tuning'
            }
          ]
        }
      })
      expect(bad.statusCode).toBe(400)
      expect(bad.json().code).toBe('SETTING_NOT_ALLOWED')
      const routes = await app.inject({
        method: 'GET',
        url: '/api/hub/notify-routes',
        headers: as(OWNER)
      })
      expect(routes.statusCode).toBe(200)
      expect(routes.json().data.events.map((e: { key: string }) => e.key)).toContain(
        'cost.over_budget'
      )
    } finally {
      await app.close()
      if (prev === undefined) delete process.env.HUB
      else process.env.HUB = prev
    }
  })
})
