import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 4: drift, the Unmanaged list and adopt, on real SQLite with a fake adapter.

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
  return { db }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

const { db } = await import('../../../db/index.js')
const migration = await import('../../../db/migrations/582_hub_providers.js')
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const observe = await import('../../../services/hub/providers/observe.js')
const { logActivity } = await import('../../../services/activity.js')

import type { HubActor } from '../../../services/hub/providers/engine/contract.js'
import type {
  Observed,
  ProviderAdapter,
  ResourceTypeSpec
} from '../../../services/hub/providers/types.js'

let prevKey: string | undefined
beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await migration.up(db)
  await db.schema.createTable('nivaro_hub_environments', (t) => {
    t.increments('id')
    t.integer('app_id')
  })
  await db.schema.createTable('nivaro_hub_app_owners', (t) => {
    t.increments('id')
    t.integer('app_id')
    t.string('user_id')
  })
})
afterAll(async () => {
  await db.destroy()
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})

const caps = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: true }
const thing: ResourceTypeSpec = {
  key: 'fake.thing',
  label: 'Thing',
  scope: 'app',
  fields: [
    { key: 'name', label: 'Name', kind: 'string' },
    { key: 'size', label: 'Size', kind: 'number' },
    { key: 'ports', label: 'Ports', kind: 'list', items: { key: 'p', label: 'p', kind: 'number' } },
    { key: 'parent', label: 'Parent', kind: 'ref', refType: 'fake.net' },
    { key: 'token', label: 'Token', kind: 'secret' },
    { key: 'arn', label: 'ARN', kind: 'string', readOnly: true }
  ],
  capabilities: caps,
  reversible: true,
  refs: [{ field: 'parent', type: 'fake.net' }],
  risk: () => []
}
const net: ResourceTypeSpec = {
  key: 'fake.net',
  label: 'Net',
  scope: 'shared',
  fields: [{ key: 'name', label: 'Name', kind: 'string' }],
  capabilities: caps,
  reversible: true,
  refs: [],
  risk: () => []
}

const world = new Map<string, Observed | null>()
const listed: Observed[] = []
const observeCalls: string[] = []
let failFor: string | null = null

function adapter(): ProviderAdapter {
  return {
    key: 'fake',
    label: 'Fake',
    connection: {
      fields: [{ key: 'token', label: 'Token', kind: 'string', secret: true }],
      hosts: () => ['api.fake.example'],
      describe: () => 'Fake'
    },
    types: [thing, net],
    testConnection: async () => ({ ok: true, identity: 'x', permissions: [], missing: [] }),
    observe: async (_c, _t, id) => {
      observeCalls.push(id)
      if (failFor === id) throw new Error('boom test-secret-abcdef')
      return world.get(id) ?? null
    },
    list: async () => ({ items: listed, cursor: null }),
    plan: () => [],
    apply: async () => ({ ok: true, externalId: null, observed: null })
  }
}

const admin: HubActor = { id: 'u-admin', isAdmin: true, via: 'session' }
const owner: HubActor = { id: 'u-owner', isAdmin: false, via: 'session' }

const obs = (
  id: string,
  fields: Record<string, unknown>,
  tags: Record<string, string> = {}
): Observed => ({
  type: 'fake.thing',
  externalId: id,
  name: String(fields.name ?? id),
  fields,
  tags
})

let connId = 0
beforeEach(async () => {
  registry.resetProvidersForTest()
  registry.registerProvider(adapter())
  for (const t of [
    'nivaro_hub_resource_changes',
    'nivaro_hub_resources',
    'nivaro_hub_app_connections',
    'nivaro_hub_connections',
    'nivaro_hub_environments',
    'nivaro_hub_app_owners'
  ])
    await db(t).del()
  world.clear()
  listed.length = 0
  observeCalls.length = 0
  failFor = null
  vi.mocked(logActivity).mockClear()
  const c = await store.createConnection({
    provider: 'fake',
    name: 'c1',
    config: {},
    secrets: { token: 'test-secret-abcdef' }
  })
  connId = c.id
  await db('nivaro_hub_environments').insert({ id: 10, app_id: 1 })
})

async function managed(
  external: string,
  desired: Record<string, unknown> | null,
  extra: Partial<Parameters<typeof store.insertResource>[0]> = {}
) {
  return store.insertResource({
    connection_id: connId,
    provider: 'fake',
    type: 'fake.thing',
    external_id: external,
    scope: 'app',
    app_id: 1,
    environment_id: 10,
    desired,
    ...extra
  })
}

const adoptApp = (externalId: string) => ({
  type: 'fake.thing',
  externalId,
  scope: 'app' as const,
  appId: 1,
  environmentId: 10
})

describe('drift', () => {
  it('flags drift when observed differs on declared fields, and not otherwise', async () => {
    const a = await managed('a', { name: 'a', size: 5, ports: [80, 443] })
    const b = await managed('b', { name: 'b', size: 5 })
    world.set('a', obs('a', { name: 'a', size: '5', ports: [443, 80], arn: 'arn:x' }))
    world.set('b', obs('b', { name: 'b', size: 9 }))
    const sum = await observe.observeAll()
    expect(sum).toEqual({ checked: 2, drifted: 1, gone: 0, failed: 0 })
    expect((await store.readResource(a.id))?.drift).toBe(false)
    const rb = await store.readResource(b.id)
    expect(rb?.drift).toBe(true)
    expect(rb?.observed?.fields.size).toBe(9)
    expect(await observe.driftFieldsOf(rb as never)).toEqual(['size'])
  })

  it('a resource the provider no longer has gets observed null and drift', async () => {
    const a = await managed('gone', { name: 'g' })
    const sum = await observe.observeAll()
    expect(sum.gone).toBe(1)
    const row = await store.readResource(a.id)
    expect(row?.observed).toBeNull()
    expect(row?.drift).toBe(true)
  })

  it('compares secrets by fingerprint only and never stores a plain secret', async () => {
    const r = await managed('s', { name: 's', token: { $sealed: 'x', fingerprint: 'fp1' } })
    world.set('s', obs('s', { name: 's', token: 'test-secret-plain' }))
    await observe.observeAll()
    let row = await store.readResource(r.id)
    expect(row?.drift).toBe(false)
    expect(JSON.stringify(row?.observed)).not.toContain('test-secret-plain')
    world.set('s', obs('s', { name: 's', token: { fingerprint: 'fp2' } }))
    await observe.observeAll()
    row = await store.readResource(r.id)
    expect(row?.drift).toBe(true)
    expect(await observe.driftFieldsOf(row as never)).toEqual(['token'])
  })

  it('compares refs through the referenced resource external id', async () => {
    const n = await store.insertResource({
      connection_id: connId,
      provider: 'fake',
      type: 'fake.net',
      external_id: 'net-1',
      scope: 'shared'
    })
    const r = await managed(
      'r',
      { name: 'r', parent: { resourceId: n.id } },
      { refs: [{ field: 'parent', resourceId: n.id }] }
    )
    world.set('net-1', { ...obs('net-1', { name: 'n' }), type: 'fake.net' })
    world.set('r', obs('r', { name: 'r', parent: 'net-1' }))
    await observe.observeAll()
    expect((await store.readResource(r.id))?.drift).toBe(false)
    world.set('r', obs('r', { name: 'r', parent: 'net-2' }))
    await observe.observeAll()
    expect((await store.readResource(r.id))?.drift).toBe(true)
  })

  it('a failing provider call counts failed, keeps the old state, and never blocks others', async () => {
    const a = await managed('bad', { name: 'x' })
    const b = await managed('ok', { name: 'ok' })
    world.set('ok', obs('ok', { name: 'ok' }))
    failFor = 'bad'
    const sum = await observe.observeAll()
    expect(sum).toMatchObject({ checked: 1, failed: 1 })
    expect((await store.readResource(a.id))?.observed_at).toBeNull()
    expect((await store.readResource(b.id))?.observed_at).not.toBeNull()
    const one = await observe.observeOne(a.id)
    expect(one.outcome).toBe('failed')
    expect(one.error).not.toContain('test-secret-abcdef')
  })

  it('skips a resource while a change is applying on it, and never re-applies', async () => {
    const a = await managed('a', { name: 'a' })
    world.set('a', obs('a', { name: 'zzz' }))
    await store.insertChange({
      connection_id: connId,
      scope: 'app',
      status: 'applying',
      plan_hash: 'h',
      plan: {
        request: { connectionId: connId, scope: 'app', ops: [] },
        ops: [],
        gates: [],
        needsConfirm: null,
        needsApproval: false,
        blockers: [],
        preconditionFingerprint: 'f',
        resourceIds: [a.id]
      }
    })
    const sum = await observe.observeAll()
    expect(sum.checked).toBe(0)
    expect(observeCalls).toEqual([])
    expect(await db('nivaro_hub_resource_changes').count({ n: '*' }).first()).toMatchObject({
      n: 1
    })
  })

  it('a connection over its budget stops; another connection still runs', async () => {
    const c2 = await store.createConnection({
      provider: 'fake',
      name: 'c2',
      config: {},
      secrets: {}
    })
    await managed('slow', { name: 's' })
    await store.insertResource({
      connection_id: c2.id,
      provider: 'fake',
      type: 'fake.thing',
      external_id: 'fast',
      scope: 'app',
      app_id: 1,
      environment_id: 10,
      desired: { name: 'f' }
    })
    world.set('slow', obs('slow', { name: 's' }))
    world.set('fast', obs('fast', { name: 'f' }))
    let t = 0
    // The clock is past the budget at every reading: nothing starts.
    const none = await observe.observeAll({ budgetMs: 1000, now: () => (t += 2000) })
    expect(none.checked).toBe(0)
    const all = await observe.observeAll()
    expect(all.checked).toBe(2)
  })
})

describe('unmanaged and adopt', () => {
  it('unmanaged leaves out Hub-tagged and already-managed external ids', async () => {
    await managed('m1', { name: 'm1' })
    listed.push(
      obs('m1', { name: 'm1' }),
      obs('t1', { name: 't1' }, { 'nivaro-hub:resource': '99' }),
      obs('free', { name: 'free' })
    )
    const page = await observe.listUnmanaged(connId, 'fake.thing', undefined, admin)
    expect(page.items.map((i) => i.externalId)).toEqual(['free'])
  })

  it('a resource managed through one connection is refused and hidden on another of the same provider', async () => {
    const c2 = await store.createConnection({
      provider: 'fake',
      name: 'c2',
      config: {},
      secrets: {}
    })
    world.set('shared-id', obs('shared-id', { name: 'x' }))
    await observe.adoptResource(connId, adoptApp('shared-id'), admin)
    await expect(observe.adoptResource(c2.id, adoptApp('shared-id'), admin)).rejects.toMatchObject({
      code: 'RESOURCE_ALREADY_MANAGED'
    })
    listed.push(obs('shared-id', { name: 'x' }), obs('other', { name: 'o' }))
    const page = await observe.listUnmanaged(c2.id, 'fake.thing', undefined, admin)
    expect(page.items.map((i) => i.externalId)).toEqual(['other'])
  })

  it('a nivaro-hub:resource tag alone does not block adopting', async () => {
    world.set('tagged', obs('tagged', { name: 't' }, { 'nivaro-hub:resource': String(connId) }))
    await expect(observe.adoptResource(connId, adoptApp('tagged'), admin)).resolves.toMatchObject({
      adopted: true
    })
  })

  it('an owner lists only through a connection allowed for an app they own', async () => {
    await expect(
      observe.listUnmanaged(connId, 'fake.thing', undefined, owner)
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_ALLOWED' })
    await db('nivaro_hub_app_owners').insert({ app_id: 1, user_id: 'u-owner' })
    await store.setAppAllowedConnections(1, [connId])
    await expect(
      observe.listUnmanaged(connId, 'fake.thing', undefined, owner)
    ).resolves.toBeTruthy()
  })

  it('adopt writes a row with no provider write, binds desired to observed, and audits', async () => {
    world.set('free', obs('free', { name: 'free', size: 3 }, { env: 'x' }))
    const row = await observe.adoptResource(connId, adoptApp('free'), admin)
    expect(row).toMatchObject({ adopted: true, drift: false, external_id: 'free', app_id: 1 })
    expect(row.desired).toMatchObject({ name: 'free', size: 3 })
    expect(row.created_by).toBe('u-admin')
    expect(await db('nivaro_hub_resource_changes').count({ n: '*' }).first()).toMatchObject({
      n: 0
    })
    expect(vi.mocked(logActivity).mock.calls[0][0]).toMatchObject({
      action: 'hub-resource-adopt',
      item: String(row.id)
    })
    await expect(observe.adoptResource(connId, adoptApp('free'), admin)).rejects.toMatchObject({
      code: 'RESOURCE_ALREADY_MANAGED'
    })
    // A later change at the provider now shows as drift.
    world.set('free', obs('free', { name: 'free', size: 4 }))
    await observe.observeAll()
    expect((await store.readResource(row.id))?.drift).toBe(true)
  })

  it('adopt gates: shared is admin only; an owner needs own app + allowed connection; agents never', async () => {
    world.set('n1', { ...obs('n1', { name: 'n1' }), type: 'fake.net' })
    world.set('t', obs('t', { name: 't' }))
    await expect(
      observe.adoptResource(connId, { type: 'fake.net', externalId: 'n1', scope: 'shared' }, owner)
    ).rejects.toMatchObject({ code: 'SHARED_ADMIN_ONLY' })
    await expect(observe.adoptResource(connId, adoptApp('t'), owner)).rejects.toMatchObject({
      code: 'ADMIN_ONLY'
    })
    await db('nivaro_hub_app_owners').insert({ app_id: 1, user_id: 'u-owner' })
    await expect(observe.adoptResource(connId, adoptApp('t'), owner)).rejects.toMatchObject({
      code: 'CONNECTION_NOT_ALLOWED'
    })
    await store.setAppAllowedConnections(1, [connId])
    await expect(observe.adoptResource(connId, adoptApp('t'), owner)).resolves.toMatchObject({
      adopted: true
    })
    await expect(
      observe.adoptResource(
        connId,
        { type: 'fake.net', externalId: 'n1', scope: 'shared' },
        { ...admin, via: 'mcp' }
      )
    ).rejects.toMatchObject({ code: 'HUB_WRITE_NOT_FOR_AGENTS' })
    await expect(
      observe.adoptResource(
        connId,
        { type: 'fake.thing', externalId: 't2', scope: 'shared' },
        admin
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    await expect(observe.adoptResource(connId, adoptApp('missing'), admin)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })
})
