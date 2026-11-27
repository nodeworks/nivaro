import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 39: the Azure adapter (SQL + Cost Management) against recorded, fake-valued
// answers. Nothing here ran against a live Azure subscription.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const notifySpy = vi.fn(async () => [])
vi.mock('../../../services/hub/providers/notify.js', async (orig) => ({
  ...((await orig()) as object),
  notifyHub: (...args: unknown[]) => (notifySpy as any)(...args)
}))

const { makeProviderContext, forgetConnectionTokens } = await import(
  '../../../services/hub/providers/context.js'
)
const { CORE_PROVIDERS, ensureCoreProviders } = await import(
  '../../../services/hub/providers/index.js'
)
const registry = await import('../../../services/hub/providers/registry.js')
const { azureAdapter } = await import('../../../services/hub/providers/azure/index.js')
const { coversEveryone } = await import('../../../services/hub/providers/azure/ip.js')
const { missingEstimates } = await import('../../../services/hub/providers/pricing/index.js')

import type { DesiredResource, Observed, PlannedOp } from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/azure/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TENANT = '00000000-0000-4000-8000-0000000000aa'
const CLIENT = '00000000-0000-4000-8000-0000000000bb'
const SUB = '00000000-0000-4000-8000-000000000001'
const OTHER_SUB = '00000000-0000-4000-8000-000000000002'
const SECRET = 'test-secret-azure-client-0001'
const RG = `/subscriptions/${SUB}/resourceGroups/rg-test-hub`
const SRV = `${RG}/providers/Microsoft.Sql/servers/sql-test-hub`
const DBID = `${SRV}/databases/app-db`
const RULE = `${SRV}/firewallRules/office`
const PE = `${SRV}/privateEndpointConnections/pe-test-1`
const BUD = `/subscriptions/${SUB}/providers/Microsoft.Consumption/budgets/budget-test-app7`

const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test-sig`

interface Call {
  method: string
  host: string
  path: string
  query: URLSearchParams
  body: any
}
interface Route {
  method: string
  path: RegExp
  host?: string
  status?: number
  body?: unknown | ((n: number, call: Call) => unknown)
  headers?: Record<string, string>
  /** Per call number: replaces the status. */
  statuses?: number[]
}

function harness(routes: Route[], config: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const hits = new Map<Route, number>()
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const raw = init?.body ? String(init.body) : ''
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      host: u.hostname,
      path: u.pathname,
      query: u.searchParams,
      body: raw && raw.startsWith('{') ? JSON.parse(raw) : raw || undefined
    }
    calls.push(call)
    if (u.hostname === 'login.microsoftonline.com') {
      const t = routes.find((r) => r.host === 'login.microsoftonline.com')
      if (t) return new Response(JSON.stringify(t.body), { status: t.status ?? 200 })
      return new Response(
        JSON.stringify({
          access_token: jwt({ tid: TENANT, appid: CLIENT }),
          expires_in: 3600
        }),
        { status: 200 }
      )
    }
    const hit = routes.find(
      (r) =>
        r.host !== 'login.microsoftonline.com' &&
        r.method === call.method &&
        r.path.test(call.path) &&
        (!r.host || r.host === u.hostname)
    )
    if (!hit)
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 })
    const n = hits.get(hit) ?? 0
    hits.set(hit, n + 1)
    const status = hit.statuses?.[Math.min(n, hit.statuses.length - 1)] ?? hit.status ?? 200
    const body = typeof hit.body === 'function' ? hit.body(n, call) : hit.body
    return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: azureAdapter,
    connectionId: 39,
    config: { tenant_id: TENANT, client_id: CLIENT, subscription_ids: [SUB], ...config },
    secrets: { client_secret: SECRET },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 60_000 }
  })
  return { ctx, calls }
}

const GET = (path: RegExp, body: unknown, status = 200, extra: Partial<Route> = {}): Route => ({
  method: 'GET',
  path,
  body,
  status,
  ...extra
})
const noCalls = () => harness([])
const writes = (calls: Call[]) =>
  calls.filter((c) => c.host === 'management.azure.com' && c.method !== 'GET')

function desired(
  type: string,
  fields: Record<string, unknown>,
  refs: Record<string, string | string[] | null> = {},
  externalId: string | null = null,
  tags: Record<string, string> = {}
): DesiredResource {
  return {
    resourceId: 9,
    type,
    externalId,
    scope: 'shared',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags
  }
}
const typeOf = (key: string) => azureAdapter.types.find((t) => t.key === key)!
const op = (over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'create',
  type: 'azure.sql_server',
  resourceId: 9,
  externalId: null,
  reason: 'x',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

beforeEach(() => {
  forgetConnectionTokens(39)
  registry.resetProvidersForTest()
  ensureCoreProviders()
  notifySpy.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('azure adapter: registration', () => {
  it('is a core provider on the ARM, login and price hosts with a sealed client secret', () => {
    expect(registry.getProvider('azure')).toBe(azureAdapter)
    expect(CORE_PROVIDERS).toContain(azureAdapter)
    expect(azureAdapter.connection.hosts({})).toEqual([
      'management.azure.com',
      'login.microsoftonline.com',
      'prices.azure.com'
    ])
    expect(azureAdapter.connection.fields.find((f) => f.key === 'client_secret')?.secret).toBe(true)
    expect(azureAdapter.types.map((t) => t.key)).toEqual([
      'azure.resource_group',
      'azure.sql_server',
      'azure.sql_firewall_rule',
      'azure.sql_database',
      'azure.sql_private_endpoint',
      'azure.budget'
    ])
    const cfg = { tenant_id: TENANT, client_id: CLIENT, subscription_ids: [SUB] }
    expect(azureAdapter.connection.validate?.(cfg, { client_secret: SECRET })).toEqual([])
    expect(azureAdapter.connection.validate?.({ ...cfg, subscription_ids: [] }, {})).not.toEqual([])
    expect(
      azureAdapter.connection.validate?.({ ...cfg, subscription_ids: ['nope'] }, {})
    ).not.toEqual([])
    expect(azureAdapter.connection.describe(cfg)).not.toContain(SECRET)
  })

  it('every costed type has an estimate', () => {
    expect(missingEstimates([azureAdapter])).toEqual([])
    expect(typeOf('azure.sql_database').costClass?.(desired('azure.sql_database', {}))).toBe(
      'monthly'
    )
  })

  it('refuses a host other than Azure’s', async () => {
    const { ctx } = noCalls()
    await expect(ctx.fetch('https://evil.example.com/x')).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED'
    })
  })
})

describe('azure adapter: testConnection', () => {
  it('lists the missing permissions when a subscription cannot be read', async () => {
    const { ctx } = harness([
      GET(/^\/subscriptions\/[^/]+$/, fx('error-forbidden'), 403),
      { method: 'POST', path: /CostManagement\/query$/, body: fx('error-forbidden'), status: 403 }
    ])
    const t = await azureAdapter.testConnection(ctx)
    expect(t.ok).toBe(false)
    expect(t.missing.length).toBeGreaterThan(0)
    expect(t.missing.some((m) => m.includes('Cost Management Reader'))).toBe(true)
  })

  it('answers the app and subscription, and says writes are assumed', async () => {
    const { ctx } = harness([
      GET(/^\/subscriptions\/[^/]+$/, fx('subscription')),
      { method: 'POST', path: /CostManagement\/query$/, body: fx('cost-query') }
    ])
    const t = await azureAdapter.testConnection(ctx)
    expect(t.ok).toBe(true)
    expect(t.identity).toContain(CLIENT)
    expect(t.identity).toContain('Test Subscription')
    expect(t.missing).toEqual([])
    expect(t.message).toContain('assumed')
  })

  it('reports a refused sign-in without the secret', async () => {
    const { ctx } = harness([
      {
        method: 'POST',
        path: /./,
        host: 'login.microsoftonline.com',
        status: 401,
        body: { error: 'invalid_client', error_description: `bad secret ${SECRET}` }
      }
    ])
    const t = await azureAdapter.testConnection(ctx)
    expect(t.ok).toBe(false)
    expect(JSON.stringify(t)).not.toContain(SECRET)
  })

  it('refuses a token that belongs to another tenant', async () => {
    const { ctx } = harness([
      {
        method: 'POST',
        path: /./,
        host: 'login.microsoftonline.com',
        body: {
          access_token: jwt({ tid: '00000000-0000-4000-8000-0000000000ff' }),
          expires_in: 3600
        }
      }
    ])
    const t = await azureAdapter.testConnection(ctx)
    expect(t.ok).toBe(false)
    expect(t.message).toContain('different tenant')
  })
})

describe('azure adapter: observe and pinning', () => {
  it('maps every type through ARM ids', async () => {
    const { ctx } = harness([
      GET(/\/resourceGroups\/rg-test-hub$/, fx('group')),
      GET(/\/servers\/sql-test-hub$/, fx('server')),
      GET(/\/databases\/app-db$/, fx('database')),
      GET(/backupShortTermRetentionPolicies\/default$/, fx('retention')),
      GET(/\/firewallRules\/office$/, fx('firewall')),
      GET(/\/privateEndpointConnections\/pe-test-1$/, fx('private-endpoint')),
      GET(/\/budgets\/budget-test-app7$/, fx('budget'))
    ])
    const rg = await azureAdapter.observe(ctx, 'azure.resource_group', RG)
    expect(rg?.fields).toMatchObject({
      subscription_id: SUB,
      name: 'rg-test-hub',
      location: 'eastus'
    })
    expect(rg?.tags).toEqual({ 'nivaro-hub:app': '7' })
    const srv = await azureAdapter.observe(ctx, 'azure.sql_server', SRV)
    expect(srv?.fields).toMatchObject({
      resource_group: RG,
      public_network_access: false,
      minimal_tls_version: '1.2',
      entra_only_auth: false,
      sql_admin_login: 'nivarohub',
      fqdn: 'sql-test-hub.database.windows.net'
    })
    const db = await azureAdapter.observe(ctx, 'azure.sql_database', DBID)
    expect(db?.fields).toMatchObject({
      server: SRV,
      sku_name: 'S0',
      capacity: null,
      max_size_gb: 250,
      backup_retention_days: 7,
      location: 'eastus'
    })
    const rule = await azureAdapter.observe(ctx, 'azure.sql_firewall_rule', RULE)
    expect(rule?.fields).toMatchObject({
      start_ip_address: '203.0.113.10',
      end_ip_address: '203.0.113.20'
    })
    const pe = await azureAdapter.observe(ctx, 'azure.sql_private_endpoint', PE)
    expect(pe?.fields).toMatchObject({ status: 'Approved', server: SRV })
    const bud = await azureAdapter.observe(ctx, 'azure.budget', BUD)
    expect(bud?.fields).toMatchObject({
      amount: 200,
      app_tag: '7',
      thresholds: [80, 100],
      contact_emails: ['ops@example.test']
    })
  })

  it('answers null for a resource that is gone and for the master database', async () => {
    const { ctx } = harness([
      GET(/\/databases\/master$/, fx('database-master')),
      GET(/backupShortTermRetentionPolicies\/default$/, fx('retention'))
    ])
    expect(await azureAdapter.observe(ctx, 'azure.resource_group', RG)).toBeNull()
    expect(
      await azureAdapter.observe(ctx, 'azure.sql_database', `${SRV}/databases/master`)
    ).toBeNull()
  })

  it('refuses another subscription on every read, children through their parent, before any call', async () => {
    const { ctx, calls } = noCalls()
    const foreign = `/subscriptions/${OTHER_SUB}/resourceGroups/rg-test-hub`
    for (const [type, id] of [
      ['azure.resource_group', foreign],
      ['azure.sql_server', `${foreign}/providers/Microsoft.Sql/servers/sql-test-hub`],
      [
        'azure.sql_database',
        `${foreign}/providers/Microsoft.Sql/servers/sql-test-hub/databases/app-db`
      ],
      ['azure.budget', `/subscriptions/${OTHER_SUB}/providers/Microsoft.Consumption/budgets/b`]
    ] as const)
      await expect(azureAdapter.observe(ctx, type, id)).rejects.toMatchObject({
        code: 'AZURE_OUT_OF_ACCOUNT'
      })
    expect(calls).toHaveLength(0)
  })

  it('refuses an id with a path trick or of another type before any call', async () => {
    const { ctx, calls } = noCalls()
    for (const id of [
      `${RG}/../x`,
      `/subscriptions/${SUB}/resourceGroups/..`,
      `${RG}/providers/Microsoft.Compute/virtualMachines/vm1`,
      '',
      'rg-test-hub'
    ])
      await expect(azureAdapter.observe(ctx, 'azure.resource_group', id)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    await expect(azureAdapter.observe(ctx, 'azure.sql_server', RG)).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    expect(calls).toHaveLength(0)
  })
})

describe('azure adapter: list', () => {
  it('lists groups, servers and children of the allowed subscriptions only, without master', async () => {
    const { ctx, calls } = harness(
      [
        GET(/\/resourcegroups$/, { value: [fx('group')] }),
        GET(/\/providers\/Microsoft\.Sql\/servers$/, { value: [fx('server')] }),
        GET(/\/databases$/, { value: [fx('database'), fx('database-master')] }),
        GET(/\/firewallRules$/, { value: [fx('firewall')] }),
        GET(/\/privateEndpointConnections$/, { value: [fx('private-endpoint')] }),
        GET(/\/budgets$/, { value: [fx('budget')] })
      ],
      { subscription_ids: [SUB] }
    )
    expect(
      (await azureAdapter.list(ctx, 'azure.resource_group')).items.map((i) => i.externalId)
    ).toEqual([RG])
    expect((await azureAdapter.list(ctx, 'azure.sql_server')).items).toHaveLength(1)
    expect((await azureAdapter.list(ctx, 'azure.sql_database')).items.map((i) => i.name)).toEqual([
      'app-db'
    ])
    expect((await azureAdapter.list(ctx, 'azure.sql_firewall_rule')).items).toHaveLength(1)
    expect((await azureAdapter.list(ctx, 'azure.sql_private_endpoint')).items).toHaveLength(1)
    expect((await azureAdapter.list(ctx, 'azure.budget')).items).toHaveLength(1)
    expect(calls.every((c) => c.path.includes(SUB) || c.host !== 'management.azure.com')).toBe(true)
  })
})

describe('azure adapter: plan', () => {
  const { ctx } = noCalls()
  const server = (over: Record<string, unknown> = {}): Observed => ({
    type: 'azure.sql_server',
    externalId: SRV,
    name: 'sql-test-hub',
    fields: {
      minimal_tls_version: '1.2',
      public_network_access: false,
      entra_only_auth: false,
      entra_admin_login: 'dba-test-group',
      entra_admin_object_id: '00000000-0000-4000-8000-0000000000cc',
      ...over
    },
    tags: {}
  })

  it('diff per type: create, change, nothing, delete', () => {
    const create = azureAdapter.plan(
      ctx,
      desired('azure.resource_group', { subscription_id: SUB, name: 'rg-new', location: 'eastus' }),
      null
    )
    expect(create[0]).toMatchObject({ kind: 'create' })
    expect(create[0].reason).toContain('Azure resource group rg-new')

    const none = azureAdapter.plan(
      ctx,
      desired(
        'azure.sql_server',
        { minimal_tls_version: '1.2', public_network_access: false },
        {},
        SRV
      ),
      server()
    )
    expect(none[0]).toMatchObject({ kind: 'noop' })

    const change = azureAdapter.plan(
      ctx,
      desired('azure.sql_server', { minimal_tls_version: '1.3' }, {}, SRV),
      server()
    )
    expect(change[0]).toMatchObject({ kind: 'update' })
    expect(change[0].changes).toEqual([{ field: 'minimal_tls_version', from: '1.2', to: '1.3' }])

    const del = azureAdapter.plan(ctx, null, server())
    expect(del[0]).toMatchObject({ kind: 'delete' })
  })

  it('a rotate trigger plans the rotate op, never a create', () => {
    const rotate = azureAdapter.plan(
      ctx,
      desired('azure.sql_server', { rotate_outputs: true }, {}, SRV),
      server()
    )
    expect(rotate[0]).toMatchObject({ kind: 'update', action: 'rotate_outputs' })
  })

  it('a private endpoint connection can be adopted and read, never made or removed', () => {
    const made = azureAdapter.plan(ctx, desired('azure.sql_private_endpoint', { name: 'x' }), null)
    expect((made[0].data as any).$blocker.code).toBe('READ_ONLY_TYPE')
    const seen: Observed = {
      type: 'azure.sql_private_endpoint',
      externalId: PE,
      name: 'pe-test-1',
      fields: { name: 'pe-test-1' },
      tags: {}
    }
    expect((azureAdapter.plan(ctx, null, seen)[0].data as any).$blocker.code).toBe('READ_ONLY_TYPE')
    expect(
      azureAdapter.plan(
        ctx,
        desired('azure.sql_private_endpoint', { name: 'pe-test-1' }, {}, PE),
        seen
      )[0].kind
    ).toBe('noop')
  })

  it('a database size change names the fields; list rows without a retention are not diffed on it', () => {
    const seen: Observed = {
      type: 'azure.sql_database',
      externalId: DBID,
      name: 'app-db',
      fields: { sku_name: 'S0', capacity: null, max_size_gb: 250 },
      tags: {}
    }
    const p = azureAdapter.plan(
      ctx,
      desired(
        'azure.sql_database',
        { sku_name: 'S1', max_size_gb: 250, backup_retention_days: 14 },
        {},
        DBID
      ),
      seen
    )
    expect(p[0].changes.map((c) => c.field)).toEqual(['sku_name'])
  })
})

describe('azure adapter: risk flags per type', () => {
  const plan = (type: string, d: DesiredResource | null, o: Observed | null) =>
    azureAdapter.plan(noCalls().ctx, d, o)[0]
  const flags = (type: string, p: PlannedOp, d: DesiredResource | null) => typeOf(type).risk(p, d)

  it('server: public access on is public_exposure; off or unchanged is not; rotate is downtime; delete is data loss', () => {
    const on = desired('azure.sql_server', { public_network_access: true })
    expect(flags('azure.sql_server', plan('', on, null), on)).toContain('public_exposure')
    const off = desired('azure.sql_server', { public_network_access: false })
    expect(flags('azure.sql_server', plan('', off, null), off)).toEqual([])
    const turnOn = op({
      kind: 'update',
      changes: [{ field: 'public_network_access', from: false, to: true }]
    })
    expect(flags('azure.sql_server', turnOn, on)).toContain('public_exposure')
    const unrelated = op({ kind: 'update', changes: [{ field: 'minimal_tls_version', to: '1.3' }] })
    expect(flags('azure.sql_server', unrelated, on)).toEqual([])
    expect(
      flags('azure.sql_server', op({ kind: 'update', action: 'rotate_outputs' }), off)
    ).toContain('downtime')
    expect(flags('azure.sql_server', op({ kind: 'delete' }), null)).toEqual([
      'destructive',
      'data_loss'
    ])
  })

  it('firewall rule: a range covering the internet or 0.0.0.0 is public_exposure, a narrow one is not', () => {
    const risk = (a: string, b: string) => {
      const d = desired('azure.sql_firewall_rule', { start_ip_address: a, end_ip_address: b })
      return flags('azure.sql_firewall_rule', op({ type: 'azure.sql_firewall_rule' }), d)
    }
    expect(risk('0.0.0.0', '255.255.255.255')).toEqual(['public_exposure'])
    expect(risk('0.0.0.0', '0.0.0.0')).toEqual(['public_exposure'])
    expect(risk('1.0.0.0', '200.0.0.0')).toEqual(['public_exposure'])
    expect(risk('not an ip', '1.2.3.4')).toEqual(['public_exposure'])
    expect(risk('203.0.113.10', '203.0.113.20')).toEqual([])
    expect(risk('10.0.0.0', '10.255.255.255')).toEqual([])
    expect(
      flags(
        'azure.sql_firewall_rule',
        op({ kind: 'delete', type: 'azure.sql_firewall_rule' }),
        null
      )
    ).toEqual([])
    expect(coversEveryone('0.0.0.0', '255.255.255.255')).toBe(true)
  })

  it('database: a size change is downtime, a retention change is not, delete is destructive + data_loss', () => {
    const t = 'azure.sql_database'
    expect(
      flags(
        t,
        op({ kind: 'update', type: t, changes: [{ field: 'sku_name', from: 'S0', to: 'S1' }] }),
        null
      )
    ).toEqual(['downtime'])
    expect(
      flags(
        t,
        op({ kind: 'update', type: t, changes: [{ field: 'backup_retention_days', to: 14 }] }),
        null
      )
    ).toEqual([])
    expect(flags(t, op({ kind: 'delete', type: t }), null)).toEqual(['destructive', 'data_loss'])
  })

  it('resource group and budget deletes are destructive; the group is never deletable while full', () => {
    expect(flags('azure.resource_group', op({ kind: 'delete' }), null)).toEqual(['destructive'])
    expect(flags('azure.budget', op({ kind: 'delete' }), null)).toEqual(['destructive'])
    expect(typeOf('azure.sql_server').scope).toBe('shared')
    expect(typeOf('azure.resource_group').scope).toBe('shared')
  })
})

describe('azure adapter: apply is idempotent (read-before-write)', () => {
  const groupFields = { subscription_id: SUB, name: 'rg-test-hub', location: 'eastus' }
  const createOp = (type: string) => op({ kind: 'create', type })

  it('group create: a same-named group is refused; a resumed run reuses it; a missing one is PUT', async () => {
    const exists = harness([GET(/\/resourceGroups\/rg-test-hub$/, fx('group'))])
    await expect(
      azureAdapter.apply(
        exists.ctx,
        createOp('azure.resource_group'),
        desired('azure.resource_group', groupFields)
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(writes(exists.calls)).toHaveLength(0)

    const resumed = harness([GET(/\/resourceGroups\/rg-test-hub$/, fx('group'))])
    const r = await azureAdapter.apply(
      resumed.ctx,
      createOp('azure.resource_group'),
      desired('azure.resource_group', groupFields, {}, RG)
    )
    expect(r.ok).toBe(true)
    expect(writes(resumed.calls)).toHaveLength(0)

    const fresh = harness([
      GET(/\/resourceGroups\/rg-test-hub$/, fx('group'), 200, { statuses: [404, 200] }),
      { method: 'PUT', path: /\/resourceGroups\/rg-test-hub$/, status: 201, body: fx('group') }
    ])
    const made = await azureAdapter.apply(
      fresh.ctx,
      createOp('azure.resource_group'),
      desired('azure.resource_group', groupFields, {}, null, { 'nivaro-hub:app': '7' })
    )
    expect(made.externalId).toBe(RG)
    const put = writes(fresh.calls)[0]
    expect(put.method).toBe('PUT')
    expect(put.body).toEqual({ location: 'eastus', tags: { 'nivaro-hub-app': '7' } })
    expect(put.query.get('api-version')).toBe('2022-09-01')
  })

  it('group create outside the connection’s subscriptions is refused with nothing sent', async () => {
    const { ctx, calls } = noCalls()
    await expect(
      azureAdapter.apply(
        ctx,
        createOp('azure.resource_group'),
        desired('azure.resource_group', { ...groupFields, subscription_id: OTHER_SUB })
      )
    ).rejects.toMatchObject({ code: 'AZURE_OUT_OF_ACCOUNT' })
    expect(calls).toHaveLength(0)
  })

  it('group delete: refused while it holds anything; an empty one is deleted; a gone one sends no DELETE', async () => {
    const full = harness([
      GET(/\/resourceGroups\/rg-test-hub$/, fx('group')),
      GET(/\/resources$/, { value: [{ id: `${RG}/providers/x/y/z` }] })
    ])
    await expect(
      azureAdapter.apply(
        full.ctx,
        op({ kind: 'delete', type: 'azure.resource_group', externalId: RG }),
        null
      )
    ).rejects.toMatchObject({ code: 'GROUP_NOT_EMPTY' })
    expect(writes(full.calls)).toHaveLength(0)

    const empty = harness([
      GET(/\/resourceGroups\/rg-test-hub$/, fx('group')),
      GET(/\/resources$/, { value: [] }),
      { method: 'DELETE', path: /\/resourceGroups\/rg-test-hub$/, status: 200 }
    ])
    await azureAdapter.apply(
      empty.ctx,
      op({ kind: 'delete', type: 'azure.resource_group', externalId: RG }),
      null
    )
    expect(writes(empty.calls).map((c) => c.method)).toEqual(['DELETE'])

    const gone = harness([])
    const r = await azureAdapter.apply(
      gone.ctx,
      op({ kind: 'delete', type: 'azure.resource_group', externalId: RG }),
      null
    )
    expect(r.ok).toBe(true)
    expect(writes(gone.calls)).toHaveLength(0)
  })

  it('server create: public access off and TLS 1.2 by default; a same-named server is refused', async () => {
    const d = desired(
      'azure.sql_server',
      {
        name: 'sql-test-hub',
        location: 'eastus',
        entra_only_auth: true,
        entra_admin_login: 'dba-test-group',
        entra_admin_object_id: '00000000-0000-4000-8000-0000000000cc',
        entra_admin_type: 'Group'
      },
      { resource_group: RG }
    )
    const exists = harness([GET(/\/servers\/sql-test-hub$/, fx('server'))])
    await expect(
      azureAdapter.apply(exists.ctx, createOp('azure.sql_server'), d)
    ).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })
    expect(writes(exists.calls)).toHaveLength(0)

    const fresh = harness([
      GET(/\/servers\/sql-test-hub$/, fx('server-entra-only'), 200, { statuses: [404, 200] }),
      {
        method: 'PUT',
        path: /\/servers\/sql-test-hub$/,
        status: 201,
        body: fx('server-entra-only')
      }
    ])
    const r = await azureAdapter.apply(fresh.ctx, createOp('azure.sql_server'), d)
    const put = writes(fresh.calls)[0]
    expect(put.body.properties).toMatchObject({
      minimalTlsVersion: '1.2',
      publicNetworkAccess: 'Disabled',
      administrators: { azureADOnlyAuthentication: true, login: 'dba-test-group', tenantId: TENANT }
    })
    expect(put.body.properties.administratorLoginPassword).toBeUndefined()
    // Entra only: no SQL password exists, so there is no connection string, only the address.
    expect(r.outputs).toEqual({ server_fqdn: 'sql-test-hub.database.windows.net' })
  })

  it('an Entra-only server without an Entra admin is refused with nothing sent', async () => {
    const { ctx, calls } = harness([GET(/\/servers\/sql-test-hub$/, {}, 404)])
    await expect(
      azureAdapter.apply(
        ctx,
        createOp('azure.sql_server'),
        desired(
          'azure.sql_server',
          { name: 'sql-test-hub', location: 'eastus' },
          { resource_group: RG }
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID' })
    expect(writes(calls)).toHaveLength(0)
  })

  it('server update sends only what differs; a delete is refused while a database remains', async () => {
    const upd = harness([
      GET(/\/servers\/sql-test-hub$/, fx('server')),
      { method: 'PATCH', path: /\/servers\/sql-test-hub$/, status: 200, body: fx('server') }
    ])
    await azureAdapter.apply(
      upd.ctx,
      op({
        kind: 'update',
        externalId: SRV,
        changes: [{ field: 'minimal_tls_version', to: '1.3' }]
      }),
      desired(
        'azure.sql_server',
        { minimal_tls_version: '1.3', public_network_access: false },
        { resource_group: RG },
        SRV
      )
    )
    expect(writes(upd.calls)[0].body).toEqual({ properties: { minimalTlsVersion: '1.3' } })

    const nothing = harness([GET(/\/servers\/sql-test-hub$/, fx('server'))])
    await azureAdapter.apply(
      nothing.ctx,
      op({ kind: 'update', externalId: SRV }),
      desired('azure.sql_server', { minimal_tls_version: '1.2' }, {}, SRV)
    )
    expect(writes(nothing.calls)).toHaveLength(0)

    const full = harness([
      GET(/\/servers\/sql-test-hub$/, fx('server')),
      GET(/\/databases$/, { value: [fx('database'), fx('database-master')] })
    ])
    await expect(
      azureAdapter.apply(full.ctx, op({ kind: 'delete', externalId: SRV }), null)
    ).rejects.toMatchObject({ code: 'SERVER_NOT_EMPTY' })
    expect(writes(full.calls)).toHaveLength(0)
  })

  it('turning public access on is a plain PATCH (the risk flag is what gates it)', async () => {
    const h = harness([
      GET(/\/servers\/sql-test-hub$/, fx('server')),
      { method: 'PATCH', path: /\/servers\/sql-test-hub$/, status: 200, body: fx('server') }
    ])
    await azureAdapter.apply(
      h.ctx,
      op({
        kind: 'update',
        externalId: SRV,
        changes: [{ field: 'public_network_access', to: true }]
      }),
      desired('azure.sql_server', { public_network_access: true }, {}, SRV)
    )
    expect(writes(h.calls)[0].body).toEqual({ properties: { publicNetworkAccess: 'Enabled' } })
  })

  it('firewall rule: bad range refused; same-named refused; create PUTs the range; delete of a gone rule sends nothing', async () => {
    const t = 'azure.sql_firewall_rule'
    const base = {
      name: 'office',
      start_ip_address: '203.0.113.10',
      end_ip_address: '203.0.113.20'
    }
    const badRange = harness([])
    await expect(
      azureAdapter.apply(
        badRange.ctx,
        createOp(t),
        desired(t, { ...base, start_ip_address: '203.0.113.30' }, { server: SRV })
      )
    ).rejects.toMatchObject({ code: 'BAD_RANGE' })
    expect(badRange.calls).toHaveLength(0)

    const exists = harness([GET(/\/firewallRules\/office$/, fx('firewall'))])
    await expect(
      azureAdapter.apply(exists.ctx, createOp(t), desired(t, base, { server: SRV }))
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })

    const fresh = harness([
      GET(/\/firewallRules\/office$/, fx('firewall'), 200, { statuses: [404, 200] }),
      { method: 'PUT', path: /\/firewallRules\/office$/, status: 201, body: fx('firewall') }
    ])
    const r = await azureAdapter.apply(fresh.ctx, createOp(t), desired(t, base, { server: SRV }))
    expect(r.externalId).toBe(RULE)
    expect(writes(fresh.calls)[0].body).toEqual({
      properties: { startIpAddress: '203.0.113.10', endIpAddress: '203.0.113.20' }
    })

    const del = harness([{ method: 'DELETE', path: /\/firewallRules\/office$/, status: 204 }])
    await azureAdapter.apply(del.ctx, op({ kind: 'delete', type: t, externalId: RULE }), null)
    expect(writes(del.calls).map((c) => c.method)).toEqual(['DELETE'])
  })

  it('a child written under a server other than the one the change names is refused PARENT_MISMATCH', async () => {
    const { ctx, calls } = noCalls()
    const other = `${RG}/providers/Microsoft.Sql/servers/sql-other`
    await expect(
      azureAdapter.apply(
        ctx,
        op({ kind: 'update', type: 'azure.sql_firewall_rule', externalId: RULE }),
        desired(
          'azure.sql_firewall_rule',
          { start_ip_address: '203.0.113.10', end_ip_address: '203.0.113.20' },
          { server: other },
          RULE
        )
      )
    ).rejects.toMatchObject({ code: 'PARENT_MISMATCH' })
    expect(calls).toHaveLength(0)
  })

  it('database create reads the server for its region, sets sku, size and retention; master is refused', async () => {
    const t = 'azure.sql_database'
    const d = desired(
      t,
      { name: 'app-db', sku_name: 'S0', max_size_gb: 250, backup_retention_days: 7 },
      { server: SRV }
    )
    const exists = harness([GET(/\/databases\/app-db$/, fx('database'))])
    await expect(azureAdapter.apply(exists.ctx, createOp(t), d)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })
    const master = noCalls()
    await expect(
      azureAdapter.apply(
        master.ctx,
        createOp(t),
        desired(t, { name: 'master', sku_name: 'S0' }, { server: SRV })
      )
    ).rejects.toMatchObject({ code: 'SYSTEM_DATABASE' })

    const fresh = harness([
      GET(/\/databases\/app-db$/, fx('database'), 200, { statuses: [404, 200] }),
      GET(/\/servers\/sql-test-hub$/, fx('server')),
      GET(/backupShortTermRetentionPolicies\/default$/, fx('retention')),
      { method: 'PUT', path: /\/databases\/app-db$/, status: 201, body: fx('database') },
      {
        method: 'PUT',
        path: /backupShortTermRetentionPolicies\/default$/,
        status: 200,
        body: fx('retention')
      }
    ])
    const r = await azureAdapter.apply(fresh.ctx, createOp(t), d)
    expect(r.externalId).toBe(DBID)
    const [putDb, putRet] = writes(fresh.calls)
    expect(putDb.body).toMatchObject({
      location: 'eastus',
      sku: { name: 'S0', tier: 'Standard' },
      properties: { maxSizeBytes: 250 * 1024 ** 3 }
    })
    expect(putRet.body).toEqual({ properties: { retentionDays: 7 } })
  })

  it('a vCore database needs its vCores; the sku carries family and capacity', async () => {
    const t = 'azure.sql_database'
    const missing = harness([
      GET(/\/databases\/big-db$/, {}, 404),
      GET(/\/servers\/sql-test-hub$/, fx('server'))
    ])
    await expect(
      azureAdapter.apply(
        missing.ctx,
        createOp(t),
        desired(t, { name: 'big-db', sku_name: 'GP_Gen5' }, { server: SRV })
      )
    ).rejects.toMatchObject({ code: 'INVALID' })
    expect(writes(missing.calls)).toHaveLength(0)
  })

  it('database size update PATCHes the merged sku; retention-only sends only the policy; delete of a gone one sends nothing', async () => {
    const t = 'azure.sql_database'
    const resize = harness([
      GET(/\/databases\/app-db$/, fx('database')),
      GET(/backupShortTermRetentionPolicies\/default$/, fx('retention')),
      { method: 'PATCH', path: /\/databases\/app-db$/, status: 200, body: fx('database') }
    ])
    await azureAdapter.apply(
      resize.ctx,
      op({ kind: 'update', type: t, externalId: DBID }),
      desired(
        t,
        { sku_name: 'S2', max_size_gb: 250, backup_retention_days: 7 },
        { server: SRV },
        DBID
      )
    )
    expect(writes(resize.calls)).toHaveLength(1)
    expect(writes(resize.calls)[0].body.sku).toEqual({ name: 'S2', tier: 'Standard' })

    const ret = harness([
      GET(/\/databases\/app-db$/, fx('database')),
      GET(/backupShortTermRetentionPolicies\/default$/, fx('retention')),
      { method: 'PUT', path: /backupShortTermRetentionPolicies\/default$/, status: 200, body: {} }
    ])
    await azureAdapter.apply(
      ret.ctx,
      op({ kind: 'update', type: t, externalId: DBID }),
      desired(
        t,
        { sku_name: 'S0', max_size_gb: 250, backup_retention_days: 14 },
        { server: SRV },
        DBID
      )
    )
    expect(writes(ret.calls).map((c) => c.method)).toEqual(['PUT'])
    expect(writes(ret.calls)[0].body).toEqual({ properties: { retentionDays: 14 } })

    const gone = harness([])
    await azureAdapter.apply(gone.ctx, op({ kind: 'delete', type: t, externalId: DBID }), null)
    expect(writes(gone.calls)).toHaveLength(0)
  })

  it('budget create filters on the nivaro-hub-app tag with 80 and 100 percent alerts; a same-named budget is refused', async () => {
    const t = 'azure.budget'
    const d = desired(
      t,
      {
        subscription_id: SUB,
        name: 'budget-test-app7',
        amount: 200,
        contact_emails: ['ops@example.test']
      },
      {},
      null,
      { 'nivaro-hub:app': '7' }
    )
    const exists = harness([GET(/\/budgets\/budget-test-app7$/, fx('budget'))])
    await expect(azureAdapter.apply(exists.ctx, createOp(t), d)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })
    const fresh = harness([
      GET(/\/budgets\/budget-test-app7$/, fx('budget'), 200, { statuses: [404, 200] }),
      { method: 'PUT', path: /\/budgets\/budget-test-app7$/, status: 201, body: fx('budget') }
    ])
    await azureAdapter.apply(fresh.ctx, createOp(t), d)
    const body = writes(fresh.calls)[0].body.properties
    expect(body).toMatchObject({
      amount: 200,
      timeGrain: 'Monthly',
      timePeriod: { startDate: '2026-11-01T00:00:00Z' },
      filter: { tags: { name: 'nivaro-hub-app', operator: 'In', values: ['7'] } }
    })
    expect(Object.keys(body.notifications)).toEqual([
      'Actual_GreaterThan_80_Percent',
      'Actual_GreaterThan_100_Percent'
    ])
    const noEmail = harness([GET(/\/budgets\/budget-test-app7$/, {}, 404)])
    await expect(
      azureAdapter.apply(noEmail.ctx, createOp(t), {
        ...d,
        fields: { ...d.fields, contact_emails: [] }
      })
    ).rejects.toMatchObject({ code: 'INVALID' })
  })

  it('a private endpoint connection is never changed', async () => {
    const { ctx } = noCalls()
    await expect(
      azureAdapter.apply(
        ctx,
        op({ kind: 'delete', type: 'azure.sql_private_endpoint', externalId: PE }),
        null
      )
    ).rejects.toMatchObject({ code: 'READ_ONLY_TYPE' })
  })

  it('findExisting reads the id a create would make and answers nothing for a resumed run', async () => {
    const h = harness([GET(/\/servers\/sql-test-hub$/, fx('server'))])
    const d = desired('azure.sql_server', { name: 'sql-test-hub' }, { resource_group: RG })
    expect((await azureAdapter.findExisting?.(h.ctx, 'azure.sql_server', d))?.externalId).toBe(SRV)
    expect(
      await azureAdapter.findExisting?.(h.ctx, 'azure.sql_server', { ...d, externalId: SRV })
    ).toBeNull()
  })
})

describe('azure adapter: long-running operations', () => {
  const opUrl =
    'https://management.azure.com/subscriptions/x/providers/Microsoft.Sql/locations/eastus/operationResults/op-test-1?api-version=2023-08-01'
  const d = () =>
    desired(
      'azure.sql_firewall_rule',
      { name: 'office', start_ip_address: '203.0.113.10', end_ip_address: '203.0.113.20' },
      { server: SRV }
    )

  it('follows Azure-AsyncOperation until it succeeds', async () => {
    vi.useFakeTimers()
    const { ctx, calls } = harness([
      GET(/\/firewallRules\/office$/, fx('firewall'), 200, { statuses: [404, 200] }),
      {
        method: 'PUT',
        path: /\/firewallRules\/office$/,
        status: 202,
        body: {},
        headers: { 'azure-asyncoperation': opUrl }
      },
      GET(/operationResults\/op-test-1$/, undefined, 200, {
        body: (n: number) => ({ status: n < 2 ? 'InProgress' : 'Succeeded' })
      })
    ])
    const p = azureAdapter.apply(ctx, op({ type: 'azure.sql_firewall_rule' }), d())
    await vi.advanceTimersByTimeAsync(30_000)
    const r = await p
    expect(r.ok).toBe(true)
    expect(calls.filter((c) => c.path.endsWith('op-test-1')).length).toBe(3)
  })

  it('a failed operation is not retryable and carries Azure’s text', async () => {
    vi.useFakeTimers()
    const { ctx } = harness([
      GET(/\/firewallRules\/office$/, {}, 404),
      {
        method: 'PUT',
        path: /\/firewallRules\/office$/,
        status: 202,
        body: {},
        headers: { 'azure-asyncoperation': opUrl }
      },
      GET(/operationResults\/op-test-1$/, {
        status: 'Failed',
        error: { code: 'X', message: 'Quota exceeded for the region.' }
      })
    ])
    const p = azureAdapter.apply(ctx, op({ type: 'azure.sql_firewall_rule' }), d()).catch((e) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    const err = await p
    expect(err).toMatchObject({ code: 'OPERATION_FAILED', retryable: false })
    expect(err.message).toContain('Quota exceeded')
  })

  it('gives up retryably when the operation never finishes; a poll URL on another host is ignored', async () => {
    vi.useFakeTimers()
    const slow = harness([
      GET(/\/firewallRules\/office$/, {}, 404),
      {
        method: 'PUT',
        path: /\/firewallRules\/office$/,
        status: 202,
        body: {},
        headers: { 'azure-asyncoperation': opUrl }
      },
      GET(/operationResults\/op-test-1$/, { status: 'InProgress' })
    ])
    const p = azureAdapter
      .apply(slow.ctx, op({ type: 'azure.sql_firewall_rule' }), d())
      .catch((e) => e)
    await vi.advanceTimersByTimeAsync(200_000)
    expect(await p).toMatchObject({ code: 'OPERATION_PENDING', retryable: true })

    const evil = harness([
      GET(/\/firewallRules\/office$/, fx('firewall'), 200, { statuses: [404, 200] }),
      {
        method: 'PUT',
        path: /\/firewallRules\/office$/,
        status: 202,
        body: {},
        headers: { 'azure-asyncoperation': 'https://evil.example.com/op' }
      }
    ])
    const r = await azureAdapter.apply(evil.ctx, op({ type: 'azure.sql_firewall_rule' }), d())
    expect(r.ok).toBe(true)
    expect(evil.calls.some((c) => c.host === 'evil.example.com')).toBe(false)
  })
})

describe('azure adapter: failures', () => {
  it('maps 429 to retryable, a 403 to FORBIDDEN, a 5xx to retryable', async () => {
    const h429 = harness([GET(/\/resourceGroups\/rg-test-hub$/, {}, 429)])
    await expect(azureAdapter.observe(h429.ctx, 'azure.resource_group', RG)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
    const h403 = harness([GET(/\/resourceGroups\/rg-test-hub$/, fx('error-forbidden'), 403)])
    await expect(azureAdapter.observe(h403.ctx, 'azure.resource_group', RG)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      retryable: false
    })
    const h503 = harness([
      GET(/\/resourceGroups\/rg-test-hub$/, { error: { message: 'busy' } }, 503)
    ])
    await expect(azureAdapter.observe(h503.ctx, 'azure.resource_group', RG)).rejects.toMatchObject({
      retryable: true
    })
  })

  it('a 401 mints one new token and retries once', async () => {
    const { ctx, calls } = harness([
      GET(/\/resourceGroups\/rg-test-hub$/, fx('group'), 200, { statuses: [401, 200] })
    ])
    expect((await azureAdapter.observe(ctx, 'azure.resource_group', RG))?.name).toBe('rg-test-hub')
    expect(calls.filter((c) => c.host === 'login.microsoftonline.com')).toHaveLength(2)
  })

  it('secrets never appear in errors: the client secret and a SQL password Azure echoes back', async () => {
    const pw = 'test-secret-sql-pass-1234'
    const { ctx } = harness([
      GET(/\/servers\/sql-test-hub$/, {}, 404),
      {
        method: 'PUT',
        path: /\/servers\/sql-test-hub$/,
        status: 400,
        body: {
          error: {
            code: 'InvalidParameterValue',
            message: `The password ${pw} is too weak; ${SECRET}`
          }
        }
      }
    ])
    const err: any = await azureAdapter
      .apply(
        ctx,
        op({ kind: 'create' }),
        desired(
          'azure.sql_server',
          {
            name: 'sql-test-hub',
            location: 'eastus',
            entra_only_auth: false,
            admin_password: { fingerprint: 'fp', changed: true, plain: pw }
          },
          { resource_group: RG }
        )
      )
      .catch((e) => e)
    expect(err.code).toBe('INVALID')
    expect(err.message).not.toContain(pw)
    expect(err.message).not.toContain(SECRET)
  })

  it('a network failure is retryable and scrubbed', async () => {
    const { ctx } = harness([])
    const bad = makeProviderContext({
      adapter: azureAdapter,
      connectionId: 39,
      config: { tenant_id: TENANT, client_id: CLIENT, subscription_ids: [SUB] },
      secrets: { client_secret: SECRET },
      fetch: {
        fetchImpl: (async () => {
          throw new Error(`connect failed with ${SECRET}`)
        }) as any
      }
    })
    void ctx
    const err: any = await azureAdapter.observe(bad, 'azure.resource_group', RG).catch((e) => e)
    expect(err.retryable).toBe(true)
    expect(err.message).not.toContain(SECRET)
  })
})

describe('azure adapter: declares outputs and none leak into observed/desired', () => {
  it('declares a once-only secret connection string and a plain address on the server only', () => {
    expect(typeOf('azure.sql_server').outputs).toEqual([
      { key: 'connection_string', label: expect.any(String), secret: true, onceOnly: true },
      { key: 'server_fqdn', label: expect.any(String), secret: false }
    ])
    for (const t of azureAdapter.types.filter((t) => t.key !== 'azure.sql_server'))
      expect(t.outputs).toBeUndefined()
    const server = typeOf('azure.sql_server')
    const rotate = server.fields.find((f) => f.key === 'rotate_outputs')
    expect(rotate).toMatchObject({ kind: 'boolean', trigger: true })
    expect(server.fields.find((f) => f.key === 'admin_password')?.kind).toBe('secret')
  })

  it('a SQL-auth server create hands the connection string only in outputs, with the password it set', async () => {
    const { ctx, calls } = harness([
      GET(/\/servers\/sql-test-hub$/, fx('server'), 200, { statuses: [404, 200] }),
      { method: 'PUT', path: /\/servers\/sql-test-hub$/, status: 201, body: fx('server') }
    ])
    const r = await azureAdapter.apply(
      ctx,
      op({ kind: 'create' }),
      desired(
        'azure.sql_server',
        {
          name: 'sql-test-hub',
          location: 'eastus',
          entra_only_auth: false,
          sql_admin_login: 'nivarohub',
          app_database: 'app-db'
        },
        { resource_group: RG }
      )
    )
    const sent = writes(calls)[0].body.properties
    const pw = sent.administratorLoginPassword as string
    expect(pw.length).toBeGreaterThanOrEqual(20)
    expect(sent.administratorLogin).toBe('nivarohub')
    expect(r.outputs?.connection_string).toContain(
      'Server=tcp:sql-test-hub.database.windows.net,1433'
    )
    expect(r.outputs?.connection_string).toContain('Initial Catalog=app-db')
    expect(r.outputs?.connection_string).toContain(`Password=${pw}`)
    expect(r.outputs?.server_fqdn).toBe('sql-test-hub.database.windows.net')
    const rest = JSON.stringify({ observed: r.observed, answer: r.answer })
    expect(rest).not.toContain(pw)
    expect(rest).not.toContain('Password=')
  })

  it('a supplied password is used and quoted into the connection string when it needs it', async () => {
    const pw = 'test-secret;pass=with"chars-5566'
    const { ctx } = harness([
      GET(/\/servers\/sql-test-hub$/, fx('server'), 200, { statuses: [404, 200] }),
      { method: 'PUT', path: /\/servers\/sql-test-hub$/, status: 201, body: fx('server') }
    ])
    const r = await azureAdapter.apply(
      ctx,
      op({ kind: 'create' }),
      desired(
        'azure.sql_server',
        {
          name: 'sql-test-hub',
          location: 'eastus',
          entra_only_auth: false,
          admin_password: { fingerprint: 'f', changed: true, plain: pw }
        },
        { resource_group: RG }
      )
    )
    expect(r.outputs?.connection_string).toContain(`Password={test-secret;pass=with"chars-5566}`)
  })

  it('a resumed create that finds the server makes no write and has no connection string (rotate gets a new one)', async () => {
    const { ctx, calls } = harness([GET(/\/servers\/sql-test-hub$/, fx('server'))])
    const r = await azureAdapter.apply(
      ctx,
      op({ kind: 'create', externalId: SRV }),
      desired(
        'azure.sql_server',
        { name: 'sql-test-hub', location: 'eastus', entra_only_auth: false },
        { resource_group: RG },
        SRV
      )
    )
    expect(writes(calls)).toHaveLength(0)
    expect(r.outputs).toEqual({ server_fqdn: 'sql-test-hub.database.windows.net' })
  })

  it('rotate sets a new admin password and answers a new connection string; an Entra-only server cannot rotate', async () => {
    const { ctx, calls } = harness([
      GET(/\/servers\/sql-test-hub$/, fx('server')),
      { method: 'PATCH', path: /\/servers\/sql-test-hub$/, status: 200, body: fx('server') }
    ])
    const r = await azureAdapter.apply(
      ctx,
      op({ kind: 'update', action: 'rotate_outputs', externalId: SRV }),
      desired('azure.sql_server', { rotate_outputs: true, app_database: 'app-db' }, {}, SRV)
    )
    const pw = writes(calls)[0].body.properties.administratorLoginPassword as string
    expect(r.outputs?.connection_string).toContain(`User ID=nivarohub;Password=${pw}`)
    expect(JSON.stringify(r.observed)).not.toContain(pw)

    const entra = harness([GET(/\/servers\/sql-test-hub$/, fx('server-entra-only'))])
    await expect(
      azureAdapter.apply(
        entra.ctx,
        op({ kind: 'update', action: 'rotate_outputs', externalId: SRV }),
        desired('azure.sql_server', { rotate_outputs: true }, {}, SRV)
      )
    ).rejects.toMatchObject({ code: 'ENTRA_ONLY' })
    expect(writes(entra.calls)).toHaveLength(0)
  })

  it('a rotate aimed at another server than the resource is refused TARGET_MISMATCH', async () => {
    const { ctx, calls } = noCalls()
    await expect(
      azureAdapter.apply(
        ctx,
        op({
          kind: 'update',
          action: 'rotate_outputs',
          externalId: `${RG}/providers/Microsoft.Sql/servers/sql-other`
        }),
        desired('azure.sql_server', { rotate_outputs: true }, {}, SRV)
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(calls).toHaveLength(0)
  })

  it('readOutputs re-reads only the address', async () => {
    const { ctx } = harness([GET(/\/servers\/sql-test-hub$/, fx('server'))])
    expect(await azureAdapter.readOutputs?.(ctx, 'azure.sql_server', SRV)).toEqual({
      server_fqdn: 'sql-test-hub.database.windows.net'
    })
    expect(await azureAdapter.readOutputs?.(ctx, 'azure.resource_group', RG)).toEqual({})
  })
})

describe('azure adapter: snapshot and health', () => {
  it('records a point-in-time restore point inside the retention window', async () => {
    const { ctx } = harness([
      GET(/\/databases\/app-db$/, fx('database')),
      GET(/backupShortTermRetentionPolicies\/default$/, fx('retention'))
    ])
    const snap = await azureAdapter.snapshot?.(ctx, 'azure.sql_database', DBID)
    expect(snap).toMatchObject({ kind: 'restore_point', createdAt: '2026-11-26T12:00:00.000Z' })
    expect(snap?.id).toBe(`${DBID}@2026-11-26T12:00:00.000Z`)
    expect(snap?.label).toContain('7 days')
    expect(typeOf('azure.sql_database').capabilities.snapshot).toBe(true)
  })

  it('refuses a restore point when backups are not kept', async () => {
    const { ctx } = harness([
      GET(/\/databases\/app-db$/, fx('database')),
      GET(/backupShortTermRetentionPolicies\/default$/, { properties: { retentionDays: 0 } })
    ])
    await expect(azureAdapter.snapshot?.(ctx, 'azure.sql_database', DBID)).rejects.toMatchObject({
      code: 'NO_RESTORE_POINT'
    })
  })

  it('health reads provisioning state', async () => {
    const { ctx } = harness([GET(/\/servers\/sql-test-hub$/, fx('server'))])
    expect((await azureAdapter.health?.(ctx, 'azure.sql_server', SRV))?.status).toBe('ok')
    const gone = harness([])
    expect((await azureAdapter.health?.(gone.ctx, 'azure.sql_server', SRV))?.status).toBe('down')
  })

  it('a budget past a threshold sends cost.over_budget through the Hub’s routes, with a stable dedup key', async () => {
    const { ctx } = harness([GET(/\/budgets\/budget-test-app7$/, fx('budget'))])
    const h = await azureAdapter.health?.(ctx, 'azure.budget', BUD, { appId: 7 })
    expect(h?.status).toBe('warn')
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1))
    const [event, payload] = notifySpy.mock.calls[0] as unknown as [string, any]
    expect(event).toBe('cost.over_budget')
    expect(payload).toMatchObject({
      appId: 7,
      severity: 'warning',
      dedupKey: `azure-budget:${BUD.toLowerCase()}:2026-11:80`
    })
    expect(payload.title).toContain('85%')
  })

  it('a budget under its thresholds sends nothing; at 100% it is critical', async () => {
    const under = fx('budget')
    under.properties.currentSpend.amount = 20
    const a = harness([GET(/\/budgets\/budget-test-app7$/, under)])
    expect((await azureAdapter.health?.(a.ctx, 'azure.budget', BUD))?.status).toBe('ok')
    expect(notifySpy).not.toHaveBeenCalled()
    const over = fx('budget')
    over.properties.currentSpend.amount = 230
    const b = harness([GET(/\/budgets\/budget-test-app7$/, over)])
    expect((await azureAdapter.health?.(b.ctx, 'azure.budget', BUD))?.status).toBe('down')
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1))
    expect((notifySpy.mock.calls[0] as unknown as [string, any])[1].severity).toBe('critical')
  })
})

describe('azure adapter: costs()', () => {
  const costRoutes = (): Route[] => [
    {
      method: 'POST',
      path: /CostManagement\/query$/,
      body: (_n: number, call: Call) =>
        JSON.stringify(call.body).includes('TagKey') ? fx('cost-tags') : fx('cost-query')
    }
  ]

  it('answers rows by resource id and the nivaro-hub-app tag, with record types from the charge type', async () => {
    const { ctx, calls } = harness(costRoutes())
    const rows = await azureAdapter.costs(ctx, { from: '2026-11-05', to: '2026-11-06' })
    expect(rows).toEqual([
      {
        date: '2026-11-05',
        amountCents: 1235,
        currency: 'USD',
        externalId: DBID.toLowerCase(),
        appTag: '7',
        recordType: 'usage'
      },
      {
        date: '2026-11-05',
        amountCents: -150,
        currency: 'USD',
        externalId: SRV.toLowerCase(),
        recordType: 'credit'
      },
      {
        date: '2026-11-06',
        amountCents: 90,
        currency: 'USD',
        externalId: SRV.toLowerCase(),
        recordType: 'tax'
      },
      { date: '2026-11-06', amountCents: -25, currency: 'USD', recordType: 'refund' }
    ])
    // Two queries per subscription (the API takes two groupings at most).
    const queries = calls.filter((c) => c.path.endsWith('/query'))
    expect(queries).toHaveLength(2)
    expect(queries[0].body.dataset.grouping).toEqual([
      { type: 'Dimension', name: 'ResourceId' },
      { type: 'Dimension', name: 'ChargeType' }
    ])
    expect(queries[0].body.dataset.granularity).toBe('Daily')
    expect(queries[1].body.dataset.grouping).toEqual([
      { type: 'Dimension', name: 'ResourceId' },
      { type: 'TagKey', name: 'nivaro-hub-app' }
    ])
    expect(queries[0].body.timePeriod).toEqual({
      from: '2026-11-05T00:00:00Z',
      to: '2026-11-06T23:59:59Z'
    })
  })

  it('a subscription whose costs cannot be read has no rows; a bad range is refused', async () => {
    const { ctx } = harness([
      { method: 'POST', path: /CostManagement\/query$/, status: 403, body: fx('error-forbidden') }
    ])
    expect(await azureAdapter.costs(ctx, { from: '2026-11-05', to: '2026-11-06' })).toEqual([])
    await expect(
      azureAdapter.costs(ctx, { from: '2026-11-07', to: '2026-11-06' })
    ).rejects.toMatchObject({
      code: 'INVALID'
    })
  })

  it('a throttled Cost Management is retryable', async () => {
    const { ctx } = harness([
      { method: 'POST', path: /CostManagement\/query$/, status: 429, body: {} }
    ])
    await expect(
      azureAdapter.costs(ctx, { from: '2026-11-05', to: '2026-11-06' })
    ).rejects.toMatchObject({
      retryable: true
    })
  })
})

describe('azure adapter: estimates', () => {
  const retail = (): Route => ({
    method: 'GET',
    host: 'prices.azure.com',
    path: /\/api\/retail\/prices$/,
    body: (_n: number, call: Call) => {
      const f = call.query.get('$filter') ?? ''
      if (f.includes("skuName eq 'S0'")) return fx('retail-dtu')
      if (f.includes("meterName eq 'vCore'")) return fx('retail-vcore')
      if (f.includes('Data Stored')) return fx('retail-storage')
      return fx('retail-empty')
    }
  })
  const db = typeOf('azure.sql_database')
  const withServer = [GET(/\/servers\/sql-test-hub$/, fx('server'))]

  it('estimate from recorded price answer: a DTU tier is a monthly list price from the Retail Prices API', async () => {
    const { ctx, calls } = harness([...withServer, retail()])
    const e = await db.estimate!(
      ctx,
      desired('azure.sql_database', { sku_name: 'S0', max_size_gb: 250 }, { server: SRV }),
      null
    )
    expect(e.confidence).toBe('list_price')
    expect(e.basis).toBe('price_list')
    expect(e.monthlyCents).toBe(Math.round(0.4912 * 100 * (365 / 12)))
    expect(e.priceAsOf).toBe('2026-10-01')
    expect(e.lines[0]).toMatchObject({ unit: 'month', source: 'price_list', kind: 'base' })
    const q = calls.find((c) => c.host === 'prices.azure.com')
    expect(q?.query.get('$filter')).toContain("armRegionName eq 'eastus'")
  })

  it('estimate from recorded price answer: a vCore database is vCores x hours plus allocated storage', async () => {
    const { ctx } = harness([...withServer, retail()])
    const e = await db.estimate!(
      ctx,
      desired(
        'azure.sql_database',
        { sku_name: 'GP_Gen5', capacity: 4, max_size_gb: 100 },
        { server: SRV }
      ),
      null
    )
    expect(e.lines.map((l) => l.unit).sort()).toEqual(['GB-month', 'vCore-hour'])
    expect(e.monthlyCents).toBe(Math.round(4 * 730 * 25.25) + Math.round(100 * 11.5))
    expect(e.confidence).toBe('list_price')
    expect(e.note).toContain('no reserved capacity')
  })

  it('serverless is usage: only storage is a figure and the note says what always-on would cost', async () => {
    const { ctx } = harness([...withServer, retail()])
    const e = await db.estimate!(
      ctx,
      desired(
        'azure.sql_database',
        { sku_name: 'GP_S_Gen5', capacity: 2, max_size_gb: 100 },
        { server: SRV }
      ),
      null
    )
    expect(e.basis).toBe('usage')
    expect(e.confidence).toBe('usage_varies')
    expect(e.monthlyCents).toBe(1150)
    expect(e.note).toContain('always on at 2 vCores')
  })

  it('falls back to the dated table for a DTU tier when the price API is down, and says so', async () => {
    const { ctx } = harness([
      ...withServer,
      { method: 'GET', host: 'prices.azure.com', path: /./, status: 500, body: {} }
    ])
    const e = await db.estimate!(
      ctx,
      desired('azure.sql_database', { sku_name: 'S0' }, { server: SRV }),
      null
    )
    expect(e.monthlyCents).toBe(1473)
    expect(e.priceAsOf).toBe('2026-11-26')
    expect(e.note).toContain('dated table')
  })

  it('answers a delete from what is observed and never throws: an unknown price is No estimate', async () => {
    const observed: Observed = {
      type: 'azure.sql_database',
      externalId: DBID,
      name: 'app-db',
      fields: { sku_name: 'GP_Gen5', capacity: 2, max_size_gb: 50, location: 'eastus' },
      tags: {}
    }
    const { ctx } = harness([
      { method: 'GET', host: 'prices.azure.com', path: /./, body: fx('retail-empty') }
    ])
    const e = await db.estimate!(ctx, null, observed)
    expect(e.confidence).toBe('unknown')
    const none = await db.estimate!(
      harness([]).ctx,
      desired('azure.sql_database', { sku_name: 'nonsense' }, { server: SRV }),
      null
    )
    expect(none.confidence).toBe('unknown')
    const noRegion = await db.estimate!(
      harness([]).ctx,
      desired('azure.sql_database', { sku_name: 'S0' }),
      null
    )
    expect(noRegion.confidence).toBe('unknown')
  })

  it('refuses a region or sku that could change the price query', async () => {
    const { ctx, calls } = harness([retail()])
    expect(await azureAdapter.priceApi?.(ctx, "sql:dtu:S0' or 1 eq 1", 'eastus')).toBeNull()
    expect(await azureAdapter.priceApi?.(ctx, 'sql:dtu:S0', "eastus' or 1 eq 1")).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('azure adapter: cross-app budgets and connection-string injection', () => {
  const budget = (over: Record<string, unknown> = {}, tags = { 'nivaro-hub:app': '7' }) => {
    const d = desired(
      'azure.budget',
      {
        subscription_id: SUB,
        name: 'budget-test-app7',
        amount: 200,
        contact_emails: ['ops@example.test'],
        ...over
      },
      {},
      null,
      tags
    )
    return { ...d, scope: 'app' as const }
  }

  it('a foreign app_tag is INVALID_FIELDS at plan time and at apply, with nothing sent', async () => {
    const d = budget({ app_tag: '99' })
    const planned = azureAdapter.plan(noCalls().ctx, d, null)
    expect((planned[0].data as any).$blocker.code).toBe('INVALID_FIELDS')
    const { ctx, calls } = noCalls()
    await expect(azureAdapter.apply(ctx, op({ type: 'azure.budget' }), d)).rejects.toMatchObject({
      code: 'INVALID_FIELDS'
    })
    expect(calls).toHaveLength(0)
  })

  it('the budget filter always uses the owning app, from the tag or the row appId; an equal app_tag is fine', async () => {
    const h = harness([
      GET(/\/budgets\/budget-test-app7$/, {}, 404),
      { method: 'PUT', path: /\/budgets\/budget-test-app7$/, status: 201, body: fx('budget') }
    ])
    await azureAdapter.apply(h.ctx, op({ type: 'azure.budget' }), budget({ app_tag: '7' }))
    expect(writes(h.calls)[0].body.properties.filter.tags.values).toEqual(['7'])
    const noTag = budget({}, {} as any)
    const h2 = harness([
      GET(/\/budgets\/budget-test-app7$/, {}, 404),
      { method: 'PUT', path: /\/budgets\/budget-test-app7$/, status: 201, body: fx('budget') }
    ])
    await azureAdapter.apply(h2.ctx, op({ type: 'azure.budget' }), noTag)
    expect(writes(h2.calls)[0].body.properties.filter.tags.values).toEqual(['1'])
  })

  it('an existing budget whose Azure filter names another app plans a change back to the owner’s', () => {
    const seen: Observed = {
      type: 'azure.budget',
      externalId: BUD,
      name: 'budget-test-app7',
      fields: {
        amount: 200,
        app_tag: '99',
        thresholds: [80, 100],
        contact_emails: ['ops@example.test']
      },
      tags: {}
    }
    const p = azureAdapter.plan(noCalls().ctx, budget({}), seen)
    expect(p[0].changes).toEqual([{ field: 'app_tag', from: '99', to: '7' }])
  })

  it('the over-budget alert goes to the row’s own app, never to the app named by Azure’s tag', async () => {
    const foreign = fx('budget')
    foreign.properties.filter.tags.values = ['99']
    const { ctx } = harness([GET(/\/budgets\/budget-test-app7$/, foreign)])
    await azureAdapter.health?.(ctx, 'azure.budget', BUD, { appId: 4 })
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1))
    expect((notifySpy.mock.calls[0] as unknown as [string, any])[1].appId).toBe(4)
    notifySpy.mockClear()
    await azureAdapter.health?.(ctx, 'azure.budget', BUD)
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1))
    expect('appId' in (notifySpy.mock.calls[0] as unknown as [string, any])[1]).toBe(false)
  })

  const sqlServer = (fields: Record<string, unknown>) =>
    desired(
      'azure.sql_server',
      { name: 'sql-test-hub', location: 'eastus', entra_only_auth: false, ...fields },
      { resource_group: RG }
    )

  it('a database name with ; = quote or space in the connection string is refused with nothing sent', async () => {
    for (const bad of ['app;Server=evil', 'a=b', 'a"b', "a'b", 'a b']) {
      const d = sqlServer({ app_database: bad })
      expect((azureAdapter.plan(noCalls().ctx, d, null)[0].data as any).$blocker.code).toBe(
        'INVALID_FIELDS'
      )
      const { ctx, calls } = noCalls()
      await expect(azureAdapter.apply(ctx, op({}), d)).rejects.toMatchObject({
        code: 'INVALID_FIELDS'
      })
      expect(calls).toHaveLength(0)
    }
  })

  it('a SQL admin login must follow Azure’s rule and not be a reserved name', async () => {
    for (const bad of ['admin', 'SA', 'root', '1abc', 'a;b', 'a b', 'a"b', 'x'.repeat(129)]) {
      const { ctx, calls } = noCalls()
      await expect(
        azureAdapter.apply(ctx, op({}), sqlServer({ sql_admin_login: bad }))
      ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
      expect(calls).toHaveLength(0)
    }
  })

  it('a rotate on a server whose login cannot go in a string is refused before the password changes', async () => {
    const weird = fx('server')
    weird.properties.administratorLogin = 'a;b'
    const { ctx, calls } = harness([GET(/\/servers\/sql-test-hub$/, weird)])
    await expect(
      azureAdapter.apply(
        ctx,
        op({ kind: 'update', action: 'rotate_outputs', externalId: SRV }),
        desired('azure.sql_server', { rotate_outputs: true }, {}, SRV)
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    expect(writes(calls)).toHaveLength(0)
  })

  it('a password with ; and } is wrapped in braces with } doubled', async () => {
    const pw = 'test-secret;a}b{c-9988'
    const { ctx } = harness([
      GET(/\/servers\/sql-test-hub$/, fx('server'), 200, { statuses: [404, 200] }),
      { method: 'PUT', path: /\/servers\/sql-test-hub$/, status: 201, body: fx('server') }
    ])
    const r = await azureAdapter.apply(
      ctx,
      op({}),
      sqlServer({ admin_password: { fingerprint: 'f', changed: true, plain: pw } })
    )
    expect(r.outputs?.connection_string).toContain('Password={test-secret;a}}b{c-9988};')
  })
})
