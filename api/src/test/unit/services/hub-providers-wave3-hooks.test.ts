import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 43: the Wave 3 hooks against real SQLite rows (Hub migrations up to 586) and small fake
// adapters under the real type keys (acme.certificate, jira.version, azure.budget, azure.sql_*):
// certificate renewal through the change engine (origin `renewal`), the hourly health tick,
// a production promote marking the Jira version released (origin `promotion`), Azure SQL as a
// database server, Snyk findings kept per connection + project, and the Create app parts.

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
const snykRead = vi.fn()
vi.mock('../../../services/hub/providers/snyk/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readSnykProjectFindings: (...a: unknown[]) => snykRead(...a)
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const engine = await import('../../../services/hub/providers/engine/contract.js')
const deps = await import('../../../services/hub/providers/engine/deps.js')
const locks = await import('../../../services/hub/providers/engine/locks.js')
const { hubRecordBlockers, assertRenewalOps } = await import(
  '../../../services/hub/providers/engine/gates.js'
)
const renewal = await import('../../../services/hub/providers/hooks/renewal.js')
const health = await import('../../../services/hub/providers/health-tick.js')
const { hourlyExtras } = await import('../../../services/hub/providers/observe.js')
const jira = await import('../../../services/hub/promote-jira.js')
const servers = await import('../../../services/hub/db/servers.js')
const snyk = await import('../../../services/hub/security/snyk.js')
const parts = await import('../../../services/hub/create/provider-parts.js')

import type { HubActor, PlanRequest } from '../../../services/hub/providers/engine/contract.js'
import type {
  DesiredResource,
  FieldSpec,
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
  '574_hub_verify',
  '576_hub_incidents',
  '579_hub_lifecycle',
  '582_hub_providers',
  '583_hub_provider_hooks',
  '584_hub_provider_bindings',
  '585_hub_cost_live',
  '586_hub_provider_costs'
]

const ADMIN_ID = '0a1b2c3d-0000-4000-8000-0000000000a1'
const GONE_ID = '0a1b2c3d-0000-4000-8000-0000000000a2'
const ADMIN: HubActor = { id: ADMIN_ID, isAdmin: true, via: 'session' }
const DAY = 86_400_000

// ── A small fake world under the real type keys ──

interface Thing {
  type: string
  fields: Record<string, unknown>
}

function makeWorld() {
  const things = new Map<string, Thing>()
  const calls: Array<{ kind: string; type: string; action?: string; ext: string | null }> = []
  const healthCalls: Array<{ type: string; ext: string; appId: number | null | undefined }> = []
  let seq = 0
  const spec = (
    key: string,
    scope: 'app' | 'shared',
    fields: string[],
    over: Partial<ResourceTypeSpec> = {}
  ): ResourceTypeSpec => ({
    key,
    label: key,
    scope,
    fields: fields.map((k): FieldSpec => {
      if (k === 'names')
        return { key: k, label: k, kind: 'list', items: { key: 'n', label: 'n', kind: 'string' } }
      if (k === 'release') return { key: k, label: k, kind: 'boolean', trigger: true }
      if (k === 'released' || k === 'not_after')
        return { key: k, label: k, kind: k === 'released' ? 'boolean' : 'string', readOnly: true }
      return { key: k, label: k, kind: 'string' }
    }),
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
    risk: () => [],
    ...over
  })
  const obs = (ext: string): Observed | null => {
    const t = things.get(ext)
    return t
      ? {
          type: t.type,
          externalId: ext,
          name: String(t.fields.name ?? ext),
          fields: { ...t.fields },
          tags: {}
        }
      : null
  }
  function adapter(
    key: string,
    types: ResourceTypeSpec[],
    planOf: (d: DesiredResource, o: Observed) => PlannedOp[]
  ): ProviderAdapter {
    return {
      key,
      label: key,
      connection: { fields: [], hosts: () => [], describe: () => key },
      types,
      testConnection: async () => ({ ok: true, identity: key, permissions: [], missing: [] }),
      observe: async (_c, _t, ext) => obs(ext),
      list: async () => ({ items: [], cursor: null }),
      plan(_c, desired, observed) {
        const base = {
          resourceId: desired?.resourceId ?? null,
          reason: 'fake',
          changes: [],
          preconditions: {},
          risk: []
        }
        if (!desired)
          return observed
            ? [{ ...base, kind: 'delete', type: observed.type, externalId: observed.externalId }]
            : []
        if (!observed)
          return [
            {
              ...base,
              kind: 'create',
              type: desired.type,
              externalId: null,
              changes: Object.keys(desired.fields).map((f) => ({ field: f, to: desired.fields[f] }))
            }
          ]
        return planOf(desired, observed)
      },
      async apply(_c, op, desired) {
        calls.push({ kind: op.kind, type: op.type, action: op.action, ext: op.externalId })
        if (op.kind === 'create') {
          const ext = `${op.type}-${++seq}`
          const fields = { ...(desired?.fields ?? {}) }
          if (op.type === 'acme.certificate')
            fields.not_after = new Date(Date.now() + 80 * DAY).toISOString()
          if (op.type === 'jira.version') fields.released = false
          things.set(ext, { type: op.type, fields })
          return { ok: true, externalId: ext, observed: obs(ext) }
        }
        const ext = String(op.externalId)
        const t = things.get(ext) as Thing
        if (op.action === 'renew')
          t.fields.not_after = new Date(Date.now() + 90 * DAY).toISOString()
        if (op.action === 'release') t.fields.released = true
        if (op.action === 'reissue') t.fields.names = desired?.fields.names
        return { ok: true, externalId: ext, observed: obs(ext) }
      },
      async health(_c, type, ext, resource) {
        healthCalls.push({ type, ext, appId: resource?.appId })
        if (things.get(ext)?.fields.fail) throw new Error('health down')
        return { status: 'ok', checkedAt: new Date().toISOString() }
      }
    }
  }
  const noop = (d: DesiredResource, o: Observed): PlannedOp[] => [
    {
      kind: 'noop',
      type: o.type,
      resourceId: d.resourceId,
      externalId: o.externalId,
      reason: 'up to date',
      changes: [],
      preconditions: {},
      risk: []
    }
  ]
  const acme = adapter(
    'acme',
    [spec('acme.certificate', 'app', ['name', 'names', 'not_after'])],
    (d, o) => {
      const base = {
        type: o.type,
        resourceId: d.resourceId,
        externalId: o.externalId,
        preconditions: { not_after: o.fields.not_after },
        risk: [] as []
      }
      if (JSON.stringify(d.fields.names ?? null) !== JSON.stringify(o.fields.names ?? null))
        return [
          {
            ...base,
            kind: 'update',
            action: 'reissue',
            reason: 'names changed',
            changes: [{ field: 'names', to: d.fields.names }]
          }
        ]
      const left = (Date.parse(String(o.fields.not_after)) - Date.now()) / DAY
      if (left <= 30)
        return [{ ...base, kind: 'update', action: 'renew', reason: 'renew', changes: [] }]
      return noop(d, o)
    }
  )
  const jiraA = adapter(
    'jira',
    [spec('jira.version', 'app', ['name', 'release', 'released'])],
    (d, o) =>
      d.fields.release === true && o.fields.released !== true
        ? [
            {
              kind: 'update',
              type: o.type,
              resourceId: d.resourceId,
              externalId: o.externalId,
              action: 'release',
              reason: 'release',
              changes: [{ field: 'release', to: true }],
              preconditions: {},
              risk: []
            }
          ]
        : noop(d, o)
  )
  const azure = adapter(
    'azure',
    [
      spec('azure.budget', 'app', ['name', 'fail']),
      spec('azure.sql_server', 'shared', ['name', 'fqdn']),
      spec('azure.sql_database', 'shared', ['name', 'server'])
    ],
    noop
  )
  return { things, calls, healthCalls, adapters: [acme, jiraA, azure] }
}

let world = makeWorld()
let appId: number
let staging: number
let production: number
const conn: Record<string, number> = {}

const insertId = async (table: string, row: Record<string, unknown>) => {
  const [id] = await db(table).insert(row)
  return Number(id)
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('status').nullable()
    t.uuid('role').nullable()
  })
  await db.schema.createTable('nivaro_roles', (t) => {
    t.uuid('id').primary()
    t.boolean('admin_access').nullable()
  })
  if (!(await db.schema.hasTable('nivaro_extension_settings')))
    await db.schema.createTable('nivaro_extension_settings', (t) => {
      t.increments('id')
      t.string('extension_id')
      t.string('key')
      t.text('value')
      t.timestamp('updated_at').nullable()
    })
  const role = '0a1b2c3d-0000-4000-8000-0000000000f1'
  await db('nivaro_roles').insert({ id: role, admin_access: true })
  await db('nivaro_users').insert({ id: ADMIN_ID, status: 'active', role })
  appId = await insertId('nivaro_hub_apps', { key: 'shop', name: 'Shop' })
  staging = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'staging',
    position: 0,
    base_url: 'https://staging.example.com'
  })
  production = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'production',
    position: 1,
    base_url: 'https://shop.example.com'
  })
  for (const p of ['acme', 'jira', 'azure', 'snyk'])
    conn[p] = (
      await store.createConnection({
        provider: p,
        name: `${p} account`,
        config: {},
        secrets: { token: `test-secret-${p}-token` }
      })
    ).id
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  world = makeWorld()
  registry.resetProvidersForTest()
  for (const a of world.adapters) registry.registerProvider(a)
  locks.resetMemoryResourceLocksForTest()
  deps.resetResourceEngineForTest()
  deps.configureResourceEngine({
    lock: () => locks.memoryResourceLock(),
    inline: true,
    notify: { notify: vi.fn(async () => null), adminBase: () => '', page: null }
  })
  for (const t of [
    'nivaro_hub_resources',
    'nivaro_hub_resource_changes',
    'nivaro_hub_freezes',
    'nivaro_hub_deploys',
    'nivaro_hub_db_servers',
    'nivaro_hub_databases',
    'nivaro_extension_settings'
  ])
    await db(t).del()
})

const req = (
  provider: string,
  ops: PlanRequest['ops'],
  env: number | null = staging
): PlanRequest => ({
  connectionId: conn[provider],
  scope: 'app',
  appId,
  ...(env != null ? { environmentId: env } : {}),
  ops
})

async function make(
  provider: string,
  type: string,
  fields: Record<string, unknown>,
  env: number | null = staging
) {
  const p = await engine.planResourceChange(
    req(provider, [{ action: 'create', type, fields }], env),
    ADMIN
  )
  const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
  expect(out.status).toBe('applied')
  const rows = await store.listResources({ type, appId })
  return rows[rows.length - 1]
}

/** Moves a certificate's end date (at the fake provider and in the stored observation). */
async function endsIn(rowId: number, days: number) {
  const row = (await store.readResource(rowId)) as NonNullable<
    Awaited<ReturnType<typeof store.readResource>>
  >
  const at = new Date(Date.now() + days * DAY).toISOString()
  ;(world.things.get(String(row.external_id)) as Thing).fields.not_after = at
  await store.updateResource(rowId, {
    observed: {
      ...(row.observed as Observed),
      fields: { ...(row.observed as Observed).fields, not_after: at }
    }
  })
}

// ── Certificate renewal ──

describe('certificate renewal (origin renewal)', () => {
  it('renews a certificate inside 30 days through the engine, once', async () => {
    const cert = await make('acme', 'acme.certificate', {
      name: 'shop',
      names: ['shop.example.com']
    })
    expect(renewal.renewalDue(cert, Date.now())).toBe(false)
    await endsIn(cert.id, 12)
    const notify = vi.fn()
    const r = await renewal.renewalTick({ notify })
    expect(r).toMatchObject({ due: 1, started: 1, waiting: 0 })
    expect(world.calls.filter((c) => c.action === 'renew')).toHaveLength(1)
    const changes = await store.listChanges({ limit: 10 })
    expect(changes[0].plan?.origin).toEqual({ kind: 'renewal', resourceId: cert.id })
    expect(changes[0].status).toBe('applied')
    expect(notify).not.toHaveBeenCalled()
    // Still inside the window (the stored observation is old): the retry window holds it.
    await endsIn(cert.id, 11)
    expect((await renewal.renewalTick({ notify })).skipped).toBe(1)
    expect(world.calls.filter((c) => c.action === 'renew')).toHaveLength(1)
  })

  it('never reissues under a renewal: other waiting changes stay a person’s', async () => {
    const cert = await make('acme', 'acme.certificate', {
      name: 'shop',
      names: ['shop.example.com']
    })
    await store.updateResource(cert.id, {
      desired: { ...(cert.desired ?? {}), names: ['shop.example.com', 'www.example.com'] }
    })
    await endsIn(cert.id, 5)
    const notify = vi.fn()
    const r = await renewal.renewalTick({
      notify,
      now: () => Date.parse('2026-11-27T13:05:00Z') + 0
    })
    expect(r.waiting + r.failed).toBe(1)
    expect(world.calls.filter((c) => c.action === 'reissue')).toHaveLength(0)
  })

  it('waits and tells when nobody can act for the certificate', async () => {
    const cert = await make('acme', 'acme.certificate', {
      name: 'shop',
      names: ['shop.example.com']
    })
    await db('nivaro_hub_resources').where({ id: cert.id }).update({ created_by: GONE_ID })
    await endsIn(cert.id, 3)
    const notify = vi.fn()
    const at13 = Date.parse('2026-11-27T13:10:00Z')
    const r = await renewal.renewalTick({ notify, now: () => at13 })
    expect(r).toMatchObject({ due: 1, waiting: 1, started: 0 })
    expect(notify).toHaveBeenCalledWith('cert.expiring', expect.objectContaining({ appId }))
    notify.mockClear()
    await renewal.renewalTick({ notify, now: () => at13 + 3_600_000 })
    expect(notify).not.toHaveBeenCalled()
  })

  it('the engine refuses a renewal origin on another type, another resource or other ops', async () => {
    const version = await make('jira', 'jira.version', { name: '1.0.0' })
    await expect(
      engine.planCarriedResourceChange(
        req('jira', [{ action: 'reapply', resourceId: version.id }]),
        ADMIN,
        {
          kind: 'renewal',
          resourceId: version.id
        }
      )
    ).rejects.toMatchObject({ code: 'ORIGIN_INVALID' })
    const cert = await make('acme', 'acme.certificate', { name: 'shop', names: ['a.example.com'] })
    await expect(
      engine.planCarriedResourceChange(
        req('acme', [{ action: 'reapply', resourceId: cert.id }]),
        ADMIN,
        {
          kind: 'renewal',
          resourceId: cert.id + 999
        }
      )
    ).rejects.toMatchObject({ code: 'ORIGIN_INVALID' })
    await expect(
      engine.planCarriedResourceChange(
        req('acme', [
          { action: 'update', resourceId: cert.id, fields: { names: ['b.example.com'] } }
        ]),
        ADMIN,
        { kind: 'renewal', resourceId: cert.id }
      )
    ).rejects.toMatchObject({ code: 'ORIGIN_INVALID' })
    expect(() =>
      assertRenewalOps({ kind: 'renewal', resourceId: 1 }, [{ kind: 'update', action: 'reissue' }])
    ).toThrow(/only renews/)
    expect(() =>
      assertRenewalOps({ kind: 'renewal', resourceId: 1 }, [{ kind: 'update', action: 'renew' }])
    ).not.toThrow()
    expect(() => assertRenewalOps(null, [{ kind: 'delete' }])).not.toThrow()
  })
})

// ── Health tick ──

describe('health tick', () => {
  it('runs once an hour and asks budget health with the row’s own app, failure-isolated', async () => {
    expect(health.healthTickDue(new Date('2026-11-27T10:05:00Z'))).toBe(true)
    expect(health.healthTickDue(new Date('2026-11-27T10:20:00Z'))).toBe(false)
    const a = await make('azure', 'azure.budget', { name: 'shop budget' })
    const b = await make('azure', 'azure.budget', { name: 'broken', fail: 'yes' })
    await make('acme', 'acme.certificate', { name: 'x', names: ['x.example.com'] })
    const r = await health.healthTick()
    expect(r).toMatchObject({ asked: 1, failed: 1 })
    expect(world.healthCalls.map((c) => c.ext).sort()).toEqual(
      [a.external_id, b.external_id].sort()
    )
    expect(world.healthCalls.every((c) => c.appId === appId)).toBe(true)
    expect(world.healthCalls.some((c) => c.type === 'acme.certificate')).toBe(false)
  })

  it('the observe job does the hourly extras only in the first quarter hour', async () => {
    await make('azure', 'azure.budget', { name: 'shop budget' })
    await hourlyExtras(() => undefined, new Date('2026-11-27T10:40:00Z'))
    expect(world.healthCalls).toHaveLength(0)
    await hourlyExtras(() => undefined, new Date('2026-11-27T11:01:00Z'))
    expect(world.healthCalls).toHaveLength(1)
  })
})

// ── Jira on production promote ──

describe('Jira release on a production promote', () => {
  const deploy = (env: number, kind = 'promote', status = 'running') =>
    insertId('nivaro_hub_deploys', {
      app_id: appId,
      environment_id: env,
      kind,
      version: '2.4.0',
      status,
      started_by: ADMIN_ID
    })
  const log = () => {
    const lines: string[] = []
    return { lines, fn: (l: string) => lines.push(l) }
  }

  it('marks the matching version released, carried by the promotion', async () => {
    const v = await make('jira', 'jira.version', { name: 'v2.4.0' }, null)
    await make('jira', 'jira.version', { name: '2.3.0' }, null)
    const deployId = await deploy(production)
    const l = log()
    const r = await jira.releaseJiraOnPromote(
      { deployId, version: '2.4.0', kind: 'promote', envId: production },
      { signal: new AbortController().signal, log: l.fn }
    )
    expect(l.lines).toEqual([expect.stringContaining('marked released')])
    expect(r).toEqual({ released: 1, failed: 0 })
    expect(world.calls.filter((c) => c.action === 'release').map((c) => c.ext)).toEqual([
      v.external_id
    ])
    expect(l.lines[0]).toContain('marked released')
    const changes = await store.listChanges({ limit: 5 })
    expect(changes[0].plan?.origin).toEqual({ kind: 'promotion', deployId })
  })

  it('does nothing on staging, on a rollback, or when nothing matches', async () => {
    await make('jira', 'jira.version', { name: '2.4.0' }, null)
    const sig = new AbortController().signal
    const l = log()
    const stagingDeploy = await deploy(staging)
    expect(
      await jira.releaseJiraOnPromote(
        { deployId: stagingDeploy, version: '2.4.0', kind: 'promote', envId: staging },
        { signal: sig, log: l.fn }
      )
    ).toEqual({ released: 0, failed: 0 })
    const rb = await deploy(production, 'rollback')
    expect(
      await jira.releaseJiraOnPromote(
        { deployId: rb, version: '2.4.0', kind: 'rollback', envId: production },
        { signal: sig, log: l.fn }
      )
    ).toEqual({ released: 0, failed: 0 })
    const other = await deploy(production)
    expect(
      await jira.releaseJiraOnPromote(
        { deployId: other, version: '9.9.9', kind: 'promote', envId: production },
        { signal: sig, log: l.fn }
      )
    ).toEqual({ released: 0, failed: 0 })
    expect(world.calls.filter((c) => c.action === 'release')).toHaveLength(0)
    expect(l.lines).toEqual([])
  })

  it('a finished promotion carries nothing: the release only warns', async () => {
    await make('jira', 'jira.version', { name: '2.4.0' }, null)
    const done = await deploy(production, 'promote', 'success')
    const l = log()
    const r = await jira.releaseJiraOnPromote(
      { deployId: done, version: '2.4.0', kind: 'promote', envId: production },
      { signal: new AbortController().signal, log: l.fn }
    )
    expect(r).toEqual({ released: 0, failed: 1 })
    expect(l.lines[0]).toContain('was not marked released')
  })

  it('names: 1.2.3 and v1.2.3 match, other versions do not', () => {
    expect(jira.releasedNames('v1.2.3')).toEqual(['1.2.3', 'v1.2.3'])
    const row = (name: string, released = false) => ({
      type: 'jira.version',
      deleted_at: null,
      external_id: 'x',
      desired: { name },
      observed: {
        type: 'jira.version',
        externalId: 'x',
        name,
        fields: { name, released },
        tags: {}
      },
      name,
      environment_id: null
    })
    expect(jira.versionMatches(row('V1.2.3'), '1.2.3', 1)).toBe(true)
    expect(jira.versionMatches(row('1.2.3', true), '1.2.3', 1)).toBe(false)
    expect(jira.versionMatches(row('1.2.30'), '1.2.3', 1)).toBe(false)
  })
})

// ── Azure SQL as a database server ──

describe('Azure SQL as a database server', () => {
  const base = {
    name: 'azure sql',
    engine: 'mssql' as const,
    host: '',
    port: null,
    provision_mode: 'manual' as const,
    ssl_mode: null,
    trust_server_cert: false,
    collation: null,
    user_host: null,
    notes: null,
    admin_secret: null
  }
  async function shared(type: string, externalId: string, fields: Record<string, unknown>) {
    const [id] = await db('nivaro_hub_resources').insert({
      connection_id: conn.azure,
      provider: 'azure',
      type,
      external_id: externalId,
      name: externalId,
      scope: 'shared',
      observed: JSON.stringify({ type, externalId, name: externalId, fields, tags: {} }),
      tags: '{}',
      refs: '[]',
      drift: false,
      adopted: true
    })
    return Number(id)
  }
  const SERVER =
    '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Sql/servers/shop-sql'

  it('fills host and port from a server, or from a database’s server', async () => {
    const srv = await shared('azure.sql_server', SERVER, { fqdn: 'shop-sql.database.windows.net' })
    expect(await servers.resolveServerResource({ ...base, resource_id: srv })).toMatchObject({
      host: 'shop-sql.database.windows.net',
      port: 1433
    })
    const dbId = await shared('azure.sql_database', `${SERVER}/databases/app`, { server: SERVER })
    expect(await servers.resolveServerResource({ ...base, resource_id: dbId })).toMatchObject({
      host: 'shop-sql.database.windows.net'
    })
    await db('nivaro_hub_resources').where({ id: srv }).update({ deleted_at: new Date() })
    // No managed server row: the public-cloud name from the ARM id.
    expect(await servers.resolveServerResource({ ...base, resource_id: dbId })).toMatchObject({
      host: 'shop-sql.database.windows.net'
    })
    await expect(
      servers.resolveServerResource({ ...base, engine: 'pg', resource_id: dbId })
    ).rejects.toMatchObject({ code: 'ENGINE_MISMATCH' })
  })

  it('deleting a linked Azure SQL server is refused while another app’s database is on it', async () => {
    const srv = await shared('azure.sql_server', SERVER, { fqdn: 'shop-sql.database.windows.net' })
    const serverId = await insertId('nivaro_hub_db_servers', {
      name: 'azure',
      engine: 'mssql',
      host: 'shop-sql.database.windows.net',
      provision_mode: 'manual',
      resource_id: srv
    })
    await insertId('nivaro_hub_databases', {
      server_id: serverId,
      engine: 'mssql',
      host: 'h',
      database_name: 'loose',
      status: 'ready'
    })
    const row = (await store.readResource(srv)) as NonNullable<
      Awaited<ReturnType<typeof store.readResource>>
    >
    const out = await hubRecordBlockers([row], appId)
    expect(out[0]?.code).toBe('SHARED_IN_USE')
  })
})

// ── Snyk findings ──

describe('Snyk findings (source snyk)', () => {
  it('keeps the last answer per connection + project; a failure keeps the old counts, scrubbed', async () => {
    snykRead.mockResolvedValueOnce({
      totals: {
        source: 'snyk',
        critical: 1,
        high: 2,
        medium: 0,
        low: 3,
        fixable: 1,
        projects: 2,
        unmonitored: 0
      },
      projects: [
        {
          id: 'p-low',
          name: 'web:package.json',
          project_type: 'npm',
          monitored: true,
          critical: 0,
          high: 0,
          medium: 0,
          low: 3,
          fixable: 0
        },
        {
          id: 'p-hot',
          name: 'api:package.json',
          project_type: 'npm',
          monitored: true,
          critical: 1,
          high: 2,
          medium: 0,
          low: 0,
          fixable: 1
        }
      ]
    })
    expect(await snyk.snykFindingsTick()).toEqual({ connections: 1, failed: 0 })
    let list = await snyk.listSnykFindings()
    expect(list).toHaveLength(1)
    expect(list[0].projects.map((p) => p.id)).toEqual(['p-hot', 'p-low'])
    expect(list[0].totals?.critical).toBe(1)
    snykRead.mockRejectedValueOnce(new Error('Snyk said no to test-secret-snyk-token'))
    expect((await snyk.snykFindingsTick()).failed).toBe(1)
    list = await snyk.listSnykFindings()
    expect(list[0].ok).toBe(false)
    expect(list[0].error).not.toContain('test-secret-snyk-token')
    expect(list[0].projects).toHaveLength(2)
  })
})

// ── Create app parts ──

describe('Create app parts (Wave 3)', () => {
  it('offers LiveKit and ACME parts with their defaults', () => {
    const ok = parts.providerPartsOf([
      { connection_id: 1, type: 'livekit.api_key', fields: { api_key: 'APIkey1' } },
      { connection_id: 2, type: 'acme.certificate', fields: { zone: 'z1' } }
    ])
    expect(ok.ok).toBe(true)
    const acme = parts.partFields(
      { connection_id: 2, type: 'acme.certificate' },
      'https://shop.example.com'
    )
    expect(acme).toMatchObject({ names: ['shop.example.com'], name: 'shop.example.com' })
    expect(parts.partBindings('livekit.api_key').map((b) => b.target_key)).toEqual([
      'huddle_livekit_url',
      'huddle_livekit_key',
      'huddle_livekit_secret'
    ])
    expect(parts.partBindings('acme.certificate')).toEqual([])
    expect(
      parts.partName({
        connection_id: 1,
        type: 'livekit.api_key',
        fields: { api_key: 'APIkey1', api_secret: 'test-secret-x' }
      })
    ).toBe('APIkey1')
    expect(
      parts.partLine('production', {
        connection_id: 1,
        type: 'livekit.api_key',
        fields: { api_key: 'APIkey1', api_secret: 'test-secret-x' }
      })
    ).not.toContain('test-secret')
  })
})
