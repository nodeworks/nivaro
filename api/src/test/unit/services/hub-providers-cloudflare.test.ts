import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 15: the Cloudflare adapter against recorded (fake-valued) answers under
// providers/cloudflare/__fixtures__. Nothing here reaches a real account.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const registry = await import('../../../services/hub/providers/registry.js')
const { CORE_PROVIDERS } = await import('../../../services/hub/providers/index.js')
const { cloudflareProvider, createDnsRecord, requireZone } = await import(
  '../../../services/hub/providers/cloudflare/index.js'
)
const { letsEveryoneIn } = await import('../../../services/hub/providers/cloudflare/access.js')
const { matchesEverything } = await import('../../../services/hub/providers/cloudflare/waf.js')
const { missingEstimates } = await import('../../../services/hub/providers/pricing/index.js')

import type {
  DesiredResource,
  Observed,
  PlannedOp,
  ProviderContext
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/cloudflare/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TOKEN = 'test-secret-cf-token-0001'
const A = 'a0000000000000000000000000000001'
const FZ = 'b0000000000000000000000000000002'
const Z = 'b0000000000000000000000000000001'
const R = 'd0000000000000000000000000000001'
const T = '11111111-1111-4111-8111-111111111111'
const APP = '22222222-2222-4222-8222-222222222222'
const POL = '33333333-3333-4333-8333-333333333333'
const RT = 'e0000000000000000000000000000001'
const RULE = 'f0000000000000000000000000000001'

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: any
  headers: Record<string, string>
}
interface Route {
  method: string
  path: RegExp
  query?: (q: URLSearchParams) => boolean
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function harness(routes: Route[]) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      path: u.pathname.replace(/^\/client\/v4/, ''),
      query: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find(
      (r) => r.method === call.method && r.path.test(call.path) && (!r.query || r.query(call.query))
    )
    if (!hit) return new Response(JSON.stringify(fx('error-not-found')), { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: cloudflareProvider,
    connectionId: 1,
    config: { accountId: A },
    secrets: { apiToken: TOKEN },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  }) as ProviderContext
  const writes = () => calls.filter((c) => c.method !== 'GET')
  return { ctx, calls, writes }
}

const adapter = cloudflareProvider
const spec = (type: string) => adapter.types.find((t) => t.key === type)!

function desired(
  type: string,
  fields: Record<string, unknown>,
  refs: Record<string, string | string[] | null> = {},
  externalId: string | null = null,
  resourceId: number | null = 41
): DesiredResource {
  return {
    resourceId,
    type,
    externalId,
    scope: 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: {}
  }
}

const secret = (changed: boolean, plain?: string) => ({
  fingerprint: 'fp-test',
  changed,
  ...(plain ? { plain } : {})
})

const GET_ZONE = { method: 'GET', path: new RegExp(`^/zones/${Z}$`), body: fx('zone') }

describe('cloudflare adapter: registration', () => {
  it('is a core provider on api.cloudflare.com with a pinned account and a secret token', () => {
    expect(CORE_PROVIDERS.some((p) => p.key === 'cloudflare')).toBe(true)
    expect(adapter.connection.hosts({ accountId: A })).toEqual(['api.cloudflare.com'])
    expect(adapter.connection.fields.find((f) => f.key === 'apiToken')?.secret).toBe(true)
    expect(adapter.connection.fields.find((f) => f.key === 'accountId')?.secret).toBeFalsy()
    expect(adapter.connection.describe({ accountId: A })).not.toContain(TOKEN)
    expect(adapter.connection.validate?.({ accountId: 'nope' }, {})).not.toEqual([])
    expect(adapter.connection.validate?.({ accountId: A }, { apiToken: TOKEN })).toEqual([])
    expect(adapter.types.map((t) => t.key)).toEqual([
      'cloudflare.zone',
      'cloudflare.dns_record',
      'cloudflare.tunnel',
      'cloudflare.tunnel_route',
      'cloudflare.access_application',
      'cloudflare.access_policy',
      'cloudflare.r2_bucket',
      'cloudflare.worker_route',
      'cloudflare.worker_secret',
      'cloudflare.waf_custom_rule'
    ])
    expect(spec('cloudflare.zone').scope).toBe('shared')
    expect(spec('cloudflare.zone').capabilities).toMatchObject({
      create: false,
      update: false,
      delete: false,
      adopt: true
    })
  })

  it('refuses a host other than api.cloudflare.com', async () => {
    const { ctx } = harness([])
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })

  it('every costed type has an estimate (the guard rule)', () => {
    expect(missingEstimates([adapter])).toEqual([])
  })
})

describe('cloudflare adapter: testConnection', () => {
  const base: Route[] = [
    { method: 'GET', path: new RegExp(`^/accounts/${A}/tokens/verify$`), body: fx('token-verify') },
    {
      method: 'GET',
      path: new RegExp(`^/accounts/${A}/tokens/tok0+1$`),
      body: fx('token-detail')
    },
    { method: 'GET', path: new RegExp(`^/accounts/${A}$`), body: fx('account') },
    { method: 'GET', path: /^\/zones$/, body: fx('zones') },
    { method: 'GET', path: new RegExp(`^/zones/${Z}/dns_records$`), body: fx('dns-records') },
    { method: 'GET', path: new RegExp(`^/accounts/${A}/cfd_tunnel$`), body: fx('tunnels') },
    {
      method: 'GET',
      path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}/configurations$`),
      body: fx('tunnel-config')
    },
    {
      method: 'GET',
      path: new RegExp(`^/accounts/${A}/access/apps$`),
      status: 403,
      body: fx('error-forbidden')
    },
    { method: 'GET', path: new RegExp(`^/accounts/${A}/r2/buckets$`), body: fx('r2-buckets') }
  ]

  it('lists missing permissions: read probes that fail and write groups the token lacks', async () => {
    const { ctx, calls } = harness(base)
    const r = await adapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.identity).toContain('Test Account')
    expect(r.missing).toContain('read Access applications')
    expect(r.missing).toContain('read Access policies')
    expect(r.missing).toContain(
      'edit Access application (permission "Access: Apps and Policies Write")'
    )
    expect(r.missing).not.toContain('read DNS records')
    expect(r.missing).not.toContain('read Cloudflare Tunnels')
    for (const c of calls) expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('answers not ok when the token does not verify', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /tokens\/verify$/, status: 401, body: fx('error-forbidden') }
    ])
    const r = await adapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.identity).toBeNull()
    expect(r.message).toMatch(/did not accept/)
  })
})

describe('cloudflare adapter: observe maps provider fields', () => {
  it('a zone, and a zone of another account is null', async () => {
    const h = harness([
      GET_ZONE,
      { method: 'GET', path: new RegExp(`^/zones/${FZ}$`), body: fx('zone-foreign') }
    ])
    const o = await adapter.observe(h.ctx, 'cloudflare.zone', Z)
    expect(o).toMatchObject({
      externalId: Z,
      name: 'example.test',
      fields: { plan: 'Pro Website', status: 'active', paused: false }
    })
    expect(await adapter.observe(h.ctx, 'cloudflare.zone', FZ)).toBeNull()
  })

  it('a DNS record: marker stripped from the comment, quotes stripped from TXT', async () => {
    const h = harness([
      GET_ZONE,
      { method: 'GET', path: new RegExp(`^/zones/${Z}/dns_records/${R}$`), body: fx('dns-record') }
    ])
    const o = await adapter.observe(h.ctx, 'cloudflare.dns_record', `${Z}:${R}`)
    expect(o).toMatchObject({
      externalId: `${Z}:${R}`,
      fields: {
        zone: Z,
        zone_name: 'example.test',
        type: 'A',
        name: 'app.example.test',
        content: '203.0.113.10',
        proxied: true,
        comment: 'web'
      },
      tags: { 'nivaro-hub:resource': '41' }
    })
    const t = harness([
      GET_ZONE,
      {
        method: 'GET',
        path: new RegExp(`^/zones/${Z}/dns_records/${R}$`),
        body: fx('dns-record-txt')
      }
    ])
    const txt = await adapter.observe(t.ctx, 'cloudflare.dns_record', `${Z}:${R}`)
    expect(txt?.fields.content).toBe('token-value-1')
  })

  it('a DNS record in a zone of another account is null and asks for no record', async () => {
    const h = harness([
      { method: 'GET', path: new RegExp(`^/zones/${FZ}$`), body: fx('zone-foreign') }
    ])
    expect(await adapter.observe(h.ctx, 'cloudflare.dns_record', `${FZ}:${R}`)).toBeNull()
    expect(h.calls.some((c) => c.path.includes('dns_records'))).toBe(false)
  })

  it('a tunnel (deleted one is gone), a public hostname, an Access app and policy', async () => {
    const h = harness([
      { method: 'GET', path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}$`), body: fx('tunnel') },
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}/configurations$`),
        body: fx('tunnel-config')
      },
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/access/apps/${APP}$`),
        body: fx('access-app')
      },
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/access/apps/${APP}/policies/${POL}$`),
        body: fx('access-policy')
      }
    ])
    expect((await adapter.observe(h.ctx, 'cloudflare.tunnel', T))?.fields).toMatchObject({
      name: 'staging-edge',
      config_src: 'cloudflare'
    })
    expect(
      (await adapter.observe(h.ctx, 'cloudflare.tunnel_route', `${T}:app.example.test`))?.fields
    ).toEqual({ tunnel: T, hostname: 'app.example.test', service: 'http://app:3055' })
    expect(
      await adapter.observe(h.ctx, 'cloudflare.tunnel_route', `${T}:nope.example.test`)
    ).toBeNull()
    expect(
      (await adapter.observe(h.ctx, 'cloudflare.access_application', APP))?.fields
    ).toMatchObject({
      domain: 'admin.example.test',
      session_duration: '24h'
    })
    expect(
      (await adapter.observe(h.ctx, 'cloudflare.access_policy', `${APP}:${POL}`))?.fields.include
    ).toEqual([{ kind: 'email_domain', value: 'example.test' }])
    const gone = harness([
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}$`),
        body: fx('tunnel-deleted')
      }
    ])
    expect(await adapter.observe(gone.ctx, 'cloudflare.tunnel', T)).toBeNull()
  })

  it('a bucket, a Worker route, a Worker secret and a WAF rule', async () => {
    const h = harness([
      GET_ZONE,
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/r2/buckets/cm-staging-uploads$`),
        body: fx('r2-bucket')
      },
      {
        method: 'GET',
        path: new RegExp(`^/zones/${Z}/workers/routes/${RT}$`),
        body: fx('worker-route')
      },
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/workers/scripts/edge-proxy/secrets/SIGNING_KEY$`),
        body: fx('worker-secret')
      },
      {
        method: 'GET',
        path: new RegExp(`^/zones/${Z}/rulesets/phases/http_request_firewall_custom/entrypoint$`),
        body: fx('waf-ruleset')
      }
    ])
    expect(
      (await adapter.observe(h.ctx, 'cloudflare.r2_bucket', 'cm-staging-uploads'))?.fields
    ).toEqual({
      name: 'cm-staging-uploads',
      location: 'enam'
    })
    expect((await adapter.observe(h.ctx, 'cloudflare.worker_route', `${Z}:${RT}`))?.fields).toEqual(
      {
        zone: Z,
        pattern: 'app.example.test/*',
        script: 'edge-proxy'
      }
    )
    expect(
      (await adapter.observe(h.ctx, 'cloudflare.worker_secret', 'edge-proxy:SIGNING_KEY'))?.fields
    ).toEqual({ script: 'edge-proxy', name: 'SIGNING_KEY' })
    expect(
      (await adapter.observe(h.ctx, 'cloudflare.waf_custom_rule', `${Z}:${RULE}`))?.fields
    ).toMatchObject({
      description: 'Block office scanner',
      action: 'block',
      enabled: true
    })
  })

  it('list drops zones that belong to another account', async () => {
    const h = harness([{ method: 'GET', path: /^\/zones$/, body: fx('zones-mixed') }])
    const page = await adapter.list(h.ctx, 'cloudflare.zone')
    expect(page.items.map((i) => i.externalId)).toEqual([Z])
    expect(page.cursor).toBeNull()
    expect(h.calls[0].query.get('account.id')).toBe(A)
  })
})

describe('cloudflare adapter: plan diff per type', () => {
  const observedDns = async (): Promise<Observed> => {
    const h = harness([
      GET_ZONE,
      { method: 'GET', path: new RegExp(`^/zones/${Z}/dns_records/${R}$`), body: fx('dns-record') }
    ])
    return (await adapter.observe(h.ctx, 'cloudflare.dns_record', `${Z}:${R}`))!
  }
  const dnsWant = (over: Record<string, unknown> = {}) =>
    desired(
      'cloudflare.dns_record',
      {
        type: 'A',
        name: 'app',
        content: '203.0.113.10',
        ttl: 1,
        proxied: true,
        comment: 'web',
        ...over
      },
      { zone: Z },
      `${Z}:${R}`
    )

  it('dns: create, noop (relative name equals the FQDN), update with downtime, delete', async () => {
    const { ctx } = harness([])
    const created = adapter.plan(ctx, dnsWant(), null)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ kind: 'create', type: 'cloudflare.dns_record' })
    const o = await observedDns()
    expect(adapter.plan(ctx, dnsWant(), o)[0].kind).toBe('noop')
    const moved = adapter.plan(ctx, dnsWant({ content: '203.0.113.99' }), o)[0]
    expect(moved.kind).toBe('update')
    expect(moved.changes.map((c) => c.field)).toEqual(['content'])
    expect(moved.preconditions).toMatchObject({ content: '203.0.113.10' })
    expect(spec('cloudflare.dns_record').risk(moved, dnsWant({ content: '203.0.113.99' }))).toEqual(
      ['downtime']
    )
    const del = adapter.plan(ctx, null, o)[0]
    expect(del.kind).toBe('delete')
    expect(spec('cloudflare.dns_record').risk(del, null)).toEqual(['destructive'])
  })

  it('dns: a record in another zone is a replace', async () => {
    const { ctx } = harness([])
    const o = await observedDns()
    const op = adapter.plan(
      ctx,
      desired(
        'cloudflare.dns_record',
        { type: 'A', name: 'app', content: '203.0.113.10' },
        { zone: FZ },
        `${Z}:${R}`
      ),
      o
    )[0]
    expect(op.kind).toBe('replace')
  })

  it('dns: priority only matters on MX; ttl 1 and proxied agree', async () => {
    const { ctx } = harness([])
    const o = await observedDns()
    expect(adapter.plan(ctx, dnsWant({ priority: 5, ttl: 300 }), o)[0].kind).toBe('noop')
  })

  it('tunnel rename is an update; route service change is an update; rules compare order-free', async () => {
    const { ctx } = harness([])
    const t: Observed = {
      type: 'cloudflare.tunnel',
      externalId: T,
      name: 'staging-edge',
      fields: { name: 'staging-edge', status: 'inactive', config_src: 'cloudflare' },
      tags: {}
    }
    expect(
      adapter.plan(ctx, desired('cloudflare.tunnel', { name: 'staging-edge' }, {}, T), t)[0].kind
    ).toBe('noop')
    expect(
      adapter.plan(ctx, desired('cloudflare.tunnel', { name: 'edge-2' }, {}, T), t)[0].kind
    ).toBe('update')
    const r: Observed = {
      type: 'cloudflare.tunnel_route',
      externalId: `${T}:app.example.test`,
      name: 'app.example.test',
      fields: { tunnel: T, hostname: 'app.example.test', service: 'http://app:3055' },
      tags: {}
    }
    const want = (service: string, hostname = 'app.example.test') =>
      desired('cloudflare.tunnel_route', { hostname, service }, { tunnel: T }, r.externalId)
    expect(adapter.plan(ctx, want('http://app:3055'), r)[0].kind).toBe('noop')
    expect(adapter.plan(ctx, want('http://app:4000'), r)[0].kind).toBe('update')
    expect(adapter.plan(ctx, want('http://app:3055', 'other.example.test'), r)[0].kind).toBe(
      'replace'
    )
  })

  it('access policy: the same rules in another shape are a noop; widening is an update', async () => {
    const { ctx } = harness([])
    const o: Observed = {
      type: 'cloudflare.access_policy',
      externalId: `${APP}:${POL}`,
      name: 'Staff',
      fields: {
        application: APP,
        name: 'Staff',
        decision: 'allow',
        include: [{ kind: 'email_domain', value: 'example.test' }],
        exclude: [],
        require: [],
        precedence: 1
      },
      tags: {}
    }
    const want = (include: unknown[]) =>
      desired(
        'cloudflare.access_policy',
        { name: 'Staff', decision: 'allow', include, exclude: [], require: [] },
        { application: APP },
        o.externalId
      )
    expect(
      adapter.plan(ctx, want([{ kind: 'email_domain', value: 'example.test' }]), o)[0].kind
    ).toBe('noop')
    expect(
      adapter.plan(ctx, want([{ kind: 'email_domain', value: 'example.test', extra: '' }]), o)[0]
        .kind
    ).toBe('noop')
    const widened = adapter.plan(ctx, want([{ kind: 'everyone' }]), o)[0]
    expect(widened.kind).toBe('update')
    expect(widened.changes[0].field).toBe('include')
  })

  it('bucket: nothing to change unless new S3 keys were pasted', async () => {
    const { ctx } = harness([])
    const o: Observed = {
      type: 'cloudflare.r2_bucket',
      externalId: 'cm-staging-uploads',
      name: 'cm-staging-uploads',
      fields: { name: 'cm-staging-uploads', location: 'enam' },
      tags: {}
    }
    const base = { name: 'cm-staging-uploads', location: 'enam' }
    expect(
      adapter.plan(ctx, desired('cloudflare.r2_bucket', base, {}, o.externalId), o)[0].kind
    ).toBe('noop')
    expect(
      adapter.plan(
        ctx,
        desired(
          'cloudflare.r2_bucket',
          { ...base, s3_access_key_id: 'AKIDTEST', s3_secret_access_key: secret(false) },
          {},
          o.externalId
        ),
        o
      )[0].kind
    ).toBe('noop')
    const keys = adapter.plan(
      ctx,
      desired(
        'cloudflare.r2_bucket',
        { ...base, s3_access_key_id: 'AKIDTEST', s3_secret_access_key: secret(true) },
        {},
        o.externalId
      ),
      o
    )[0]
    expect(keys.kind).toBe('update')
    expect(keys.changes).toEqual([
      { field: 's3_access_key_id', to: 'AKIDTEST' },
      { field: 's3_secret_access_key', secret: true }
    ])
    const del = adapter.plan(ctx, null, o)[0]
    expect(del.reason).toMatch(/empty it first/i)
    expect(spec('cloudflare.r2_bucket').risk(del, null)).toEqual(['destructive', 'data_loss'])
  })

  it('worker secret: only a new pasted value is a change; waf expression whitespace is not', async () => {
    const { ctx } = harness([])
    const s: Observed = {
      type: 'cloudflare.worker_secret',
      externalId: 'edge-proxy:SIGNING_KEY',
      name: 'edge-proxy · SIGNING_KEY',
      fields: { script: 'edge-proxy', name: 'SIGNING_KEY' },
      tags: {}
    }
    const f = (v: ReturnType<typeof secret>) =>
      desired(
        'cloudflare.worker_secret',
        { script: 'edge-proxy', name: 'SIGNING_KEY', value: v },
        {},
        s.externalId
      )
    expect(adapter.plan(ctx, f(secret(false)), s)[0].kind).toBe('noop')
    const up = adapter.plan(ctx, f(secret(true)), s)[0]
    expect(up.kind).toBe('update')
    expect(up.changes).toEqual([{ field: 'value', secret: true }])
    const rule: Observed = {
      type: 'cloudflare.waf_custom_rule',
      externalId: `${Z}:${RULE}`,
      name: 'Block office scanner',
      fields: {
        zone: Z,
        description: 'Block office scanner',
        expression: '(ip.src in {203.0.113.0/24})',
        action: 'block',
        enabled: true
      },
      tags: {}
    }
    const w = (expression: string, action = 'block') =>
      desired(
        'cloudflare.waf_custom_rule',
        { description: 'Block office scanner', expression, action, enabled: true },
        { zone: Z },
        rule.externalId
      )
    expect(adapter.plan(ctx, w('(ip.src   in\n {203.0.113.0/24})'), rule)[0].kind).toBe('noop')
    expect(
      adapter.plan(ctx, w('(ip.src in {203.0.113.0/24})', 'managed_challenge'), rule)[0].kind
    ).toBe('update')
  })
})

describe('cloudflare adapter: apply is idempotent (read-before-write)', () => {
  const dnsRoutes = (records: unknown): Route[] => [
    GET_ZONE,
    { method: 'GET', path: new RegExp(`^/zones/${Z}/dns_records$`), body: records },
    {
      method: 'POST',
      path: new RegExp(`^/zones/${Z}/dns_records$`),
      body: fx('dns-record')
    },
    { method: 'GET', path: new RegExp(`^/zones/${Z}/dns_records/${R}$`), body: fx('dns-record') },
    { method: 'PATCH', path: new RegExp(`^/zones/${Z}/dns_records/${R}$`), body: fx('dns-record') }
  ]
  const want = (over: Record<string, unknown> = {}, externalId: string | null = null) =>
    desired(
      'cloudflare.dns_record',
      {
        type: 'A',
        name: 'app',
        content: '203.0.113.10',
        ttl: 1,
        proxied: true,
        comment: 'web',
        ...over
      },
      { zone: Z },
      externalId
    )
  const op = (kind: PlannedOp['kind'], externalId: string | null = null): PlannedOp => ({
    kind,
    type: 'cloudflare.dns_record',
    resourceId: 41,
    externalId,
    reason: '',
    changes: [],
    preconditions: {},
    risk: []
  })

  it('creates a record with the Hub marker in its comment, FQDN name and automatic TTL', async () => {
    const h = harness(dnsRoutes(fx('dns-records-none')))
    const r = await adapter.apply(h.ctx, op('create'), want())
    expect(r.ok).toBe(true)
    expect(r.externalId).toBe(`${Z}:${R}`)
    expect(h.writes()).toHaveLength(1)
    expect(h.writes()[0].body).toMatchObject({
      type: 'A',
      name: 'app.example.test',
      content: '203.0.113.10',
      ttl: 1,
      proxied: true,
      comment: 'web nivaro-hub:resource=41'
    })
  })

  it('a create that finds a record the Hub did not make refuses ALREADY_EXISTS and writes nothing', async () => {
    const h = harness(dnsRoutes(fx('dns-records-handmade')))
    await expect(adapter.apply(h.ctx, op('create'), want())).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      retryable: false
    })
    expect(h.writes()).toEqual([])
  })

  it('a resumed create that finds its own marked record writes nothing', async () => {
    const h = harness(dnsRoutes(fx('dns-records')))
    const r = await adapter.apply(h.ctx, op('create'), want())
    expect(r.externalId).toBe(`${Z}:${R}`)
    expect(h.writes()).toEqual([])
  })

  it('an update to values the record already has sends no PATCH', async () => {
    const h = harness(dnsRoutes(fx('dns-records')))
    const r = await adapter.apply(h.ctx, op('update', `${Z}:${R}`), want({}, `${Z}:${R}`))
    expect(r.ok).toBe(true)
    expect(h.writes()).toEqual([])
    const h2 = harness(dnsRoutes(fx('dns-records')))
    await adapter.apply(
      h2.ctx,
      op('update', `${Z}:${R}`),
      want({ content: '203.0.113.50' }, `${Z}:${R}`)
    )
    expect(h2.writes()).toHaveLength(1)
    expect(h2.writes()[0].body).toEqual({ content: '203.0.113.50' })
  })

  it('delete of a record that is already gone succeeds', async () => {
    const h = harness([
      GET_ZONE,
      {
        method: 'DELETE',
        path: new RegExp(`^/zones/${Z}/dns_records/${R}$`),
        status: 404,
        body: fx('error-not-found')
      }
    ])
    expect((await adapter.apply(h.ctx, op('delete', `${Z}:${R}`), null)).ok).toBe(true)
  })

  it('a record in a zone outside the account is refused CLOUDFLARE_OUT_OF_ACCOUNT before any write', async () => {
    const h = harness([
      { method: 'GET', path: new RegExp(`^/zones/${FZ}$`), body: fx('zone-foreign') },
      { method: 'POST', path: /dns_records$/, body: fx('dns-record') }
    ])
    await expect(
      adapter.apply(
        h.ctx,
        op('create'),
        desired(
          'cloudflare.dns_record',
          { type: 'A', name: 'x', content: '203.0.113.1' },
          { zone: FZ }
        )
      )
    ).rejects.toMatchObject({ code: 'CLOUDFLARE_OUT_OF_ACCOUNT' })
    await expect(requireZone(h.ctx, FZ)).rejects.toMatchObject({
      code: 'CLOUDFLARE_OUT_OF_ACCOUNT'
    })
    expect(h.writes()).toEqual([])
  })

  it('createDnsRecord is reusable for an ACME TXT: made once, never over a foreign one', async () => {
    const h = harness([
      GET_ZONE,
      {
        method: 'GET',
        path: new RegExp(`^/zones/${Z}/dns_records$`),
        body: fx('dns-records-none')
      },
      { method: 'POST', path: new RegExp(`^/zones/${Z}/dns_records$`), body: fx('dns-record-txt') }
    ])
    const made = await createDnsRecord(h.ctx, Z, {
      type: 'TXT',
      name: '_acme-challenge',
      content: 'token-value-1',
      ttl: 60
    })
    expect(made.created).toBe(true)
    expect(h.writes()[0].body).toMatchObject({
      type: 'TXT',
      name: '_acme-challenge.example.test',
      ttl: 60
    })
    const taken = harness([
      GET_ZONE,
      {
        method: 'GET',
        path: new RegExp(`^/zones/${Z}/dns_records$`),
        body: {
          ...fx('dns-records-handmade'),
          result: [{ ...fx('dns-record-txt').result, comment: null }]
        }
      }
    ])
    await expect(
      createDnsRecord(taken.ctx, Z, {
        type: 'TXT',
        name: '_acme-challenge',
        content: 'token-value-1'
      })
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })

  it('tunnel: create answers the token as an output only; a same-name tunnel is refused', async () => {
    const routes: Route[] = [
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/cfd_tunnel$`),
        body: { ...fx('tunnels'), result: [] }
      },
      { method: 'POST', path: new RegExp(`^/accounts/${A}/cfd_tunnel$`), body: fx('tunnel') }
    ]
    const h = harness(routes)
    const r = await adapter.apply(
      h.ctx,
      { ...op('create'), type: 'cloudflare.tunnel' },
      desired('cloudflare.tunnel', { name: 'staging-edge' })
    )
    expect(h.writes()[0].body).toEqual({ name: 'staging-edge', config_src: 'cloudflare' })
    expect(r.outputs).toEqual({
      tunnel_token: 'test-secret-tunnel-token-aaaa',
      tunnel_id: T,
      cname_target: `${T}.cfargotunnel.com`
    })
    expect(JSON.stringify({ ...r, outputs: undefined })).not.toContain('test-secret-tunnel-token')
    const clash = harness([
      { method: 'GET', path: new RegExp(`^/accounts/${A}/cfd_tunnel$`), body: fx('tunnels') },
      ...routes.slice(1)
    ])
    await expect(
      adapter.apply(
        clash.ctx,
        { ...op('create'), type: 'cloudflare.tunnel' },
        desired('cloudflare.tunnel', { name: 'staging-edge' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(clash.writes()).toEqual([])
  })

  it('tunnel: a connected tunnel is not deleted; readOutputs re-reads the token', async () => {
    const h = harness([
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}$`),
        body: fx('tunnel-healthy')
      },
      { method: 'DELETE', path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}$`), body: {} },
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}/token$`),
        body: fx('tunnel-token')
      }
    ])
    await expect(
      adapter.apply(h.ctx, { ...op('delete', T), type: 'cloudflare.tunnel' }, null)
    ).rejects.toMatchObject({ code: 'TUNNEL_IN_USE' })
    expect(h.writes()).toEqual([])
    expect((await adapter.readOutputs?.(h.ctx, 'cloudflare.tunnel', T))?.tunnel_token).toBe(
      'test-secret-tunnel-token-aaaa'
    )
  })

  it('tunnel route: new rule goes before the catch-all, other settings kept; a taken hostname is refused', async () => {
    const routes: Route[] = [
      { method: 'GET', path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}$`), body: fx('tunnel') },
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}/configurations$`),
        body: fx('tunnel-config')
      },
      {
        method: 'PUT',
        path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}/configurations$`),
        body: {}
      }
    ]
    const h = harness(routes)
    const r = await adapter.apply(
      h.ctx,
      { ...op('create'), type: 'cloudflare.tunnel_route' },
      desired(
        'cloudflare.tunnel_route',
        { hostname: 'admin.example.test', service: 'http://admin:3056' },
        { tunnel: T }
      )
    )
    expect(r.externalId).toBe(`${T}:admin.example.test`)
    expect(h.writes()[0].body.config).toEqual({
      ingress: [
        { hostname: 'app.example.test', service: 'http://app:3055' },
        { hostname: 'admin.example.test', service: 'http://admin:3056' },
        { service: 'http_status:404' }
      ],
      'warp-routing': { enabled: false }
    })
    const taken = harness(routes)
    await expect(
      adapter.apply(
        taken.ctx,
        { ...op('create'), type: 'cloudflare.tunnel_route' },
        desired(
          'cloudflare.tunnel_route',
          { hostname: 'app.example.test', service: 'http://app:9' },
          { tunnel: T }
        )
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(taken.writes()).toEqual([])
    const del = harness(routes)
    await adapter.apply(
      del.ctx,
      { ...op('delete', `${T}:app.example.test`), type: 'cloudflare.tunnel_route' },
      null
    )
    expect(del.writes()[0].body.config.ingress).toEqual([{ service: 'http_status:404' }])
  })

  it('tunnel route on a locally managed tunnel is refused TUNNEL_LOCAL', async () => {
    const h = harness([
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}$`),
        body: fx('tunnel-local')
      }
    ])
    await expect(
      adapter.apply(
        h.ctx,
        { ...op('create'), type: 'cloudflare.tunnel_route' },
        desired(
          'cloudflare.tunnel_route',
          { hostname: 'x.example.test', service: 'http://x:1' },
          { tunnel: T }
        )
      )
    ).rejects.toMatchObject({ code: 'TUNNEL_LOCAL' })
  })

  it('access application: a taken hostname is refused; a create answers the audience tag as an output', async () => {
    const h = harness([
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/access/apps$`),
        body: { ...fx('access-apps'), result: [] }
      },
      { method: 'POST', path: new RegExp(`^/accounts/${A}/access/apps$`), body: fx('access-app') }
    ])
    const r = await adapter.apply(
      h.ctx,
      { ...op('create'), type: 'cloudflare.access_application' },
      desired('cloudflare.access_application', {
        name: 'Staging dashboard',
        domain: 'admin.example.test'
      })
    )
    expect(h.writes()[0].body).toMatchObject({
      type: 'self_hosted',
      domain: 'admin.example.test',
      session_duration: '24h'
    })
    expect(r.outputs?.aud).toMatch(/^aud-test-/)
    const clash = harness([
      { method: 'GET', path: new RegExp(`^/accounts/${A}/access/apps$`), body: fx('access-apps') },
      { method: 'POST', path: new RegExp(`^/accounts/${A}/access/apps$`), body: fx('access-app') }
    ])
    await expect(
      adapter.apply(
        clash.ctx,
        { ...op('create'), type: 'cloudflare.access_application' },
        desired('cloudflare.access_application', { name: 'Other', domain: 'admin.example.test' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(clash.writes()).toEqual([])
  })

  it('access policy: rules are sent in Cloudflare’s shapes; a same-name policy is refused', async () => {
    const h = harness([
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/access/apps/${APP}/policies$`),
        body: { result: [], success: true }
      },
      {
        method: 'POST',
        path: new RegExp(`^/accounts/${A}/access/apps/${APP}/policies$`),
        body: fx('access-policy')
      }
    ])
    await adapter.apply(
      h.ctx,
      { ...op('create'), type: 'cloudflare.access_policy' },
      desired(
        'cloudflare.access_policy',
        {
          name: 'Staff',
          decision: 'allow',
          include: [
            { kind: 'email_domain', value: 'example.test' },
            { kind: 'email', value: 'a@example.test' }
          ]
        },
        { application: APP }
      )
    )
    expect(h.writes()[0].body).toMatchObject({
      decision: 'allow',
      include: [
        { email_domain: { domain: 'example.test' } },
        { email: { email: 'a@example.test' } }
      ],
      exclude: [],
      require: []
    })
    const clash = harness([
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/access/apps/${APP}/policies$`),
        body: fx('access-policies')
      },
      { method: 'POST', path: /policies$/, body: fx('access-policy') }
    ])
    await expect(
      adapter.apply(
        clash.ctx,
        { ...op('create'), type: 'cloudflare.access_policy' },
        desired(
          'cloudflare.access_policy',
          { name: 'Staff', decision: 'allow', include: [{ kind: 'everyone' }] },
          { application: APP }
        )
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(clash.writes()).toEqual([])
  })

  it('bucket: create passes pasted S3 keys on as once-only outputs; non-empty delete is BUCKET_NOT_EMPTY', async () => {
    const getBucket = (status: number, body: unknown): Route => ({
      method: 'GET',
      path: new RegExp(`^/accounts/${A}/r2/buckets/cm-staging-uploads$`),
      status,
      body
    })
    const h = harness([
      getBucket(404, fx('error-not-found')),
      { method: 'POST', path: new RegExp(`^/accounts/${A}/r2/buckets$`), body: fx('r2-bucket') }
    ])
    const r = await adapter.apply(
      h.ctx,
      { ...op('create'), type: 'cloudflare.r2_bucket' },
      desired('cloudflare.r2_bucket', {
        name: 'cm-staging-uploads',
        location: 'enam',
        s3_access_key_id: 'AKIDTEST0001',
        s3_secret_access_key: secret(true, 'test-secret-r2-key-0001')
      })
    )
    expect(h.writes()[0].body).toEqual({ name: 'cm-staging-uploads', locationHint: 'enam' })
    expect(r.outputs).toEqual({
      endpoint: `https://${A}.r2.cloudflarestorage.com`,
      bucket: 'cm-staging-uploads',
      access_key_id: 'AKIDTEST0001',
      secret_access_key: 'test-secret-r2-key-0001'
    })
    expect(JSON.stringify({ ...r, outputs: undefined })).not.toContain('test-secret-r2-key-0001')
    const del = harness([
      {
        method: 'DELETE',
        path: new RegExp(`^/accounts/${A}/r2/buckets/cm-staging-uploads$`),
        status: 409,
        body: fx('error-r2-not-empty')
      }
    ])
    await expect(
      adapter.apply(
        del.ctx,
        { ...op('delete', 'cm-staging-uploads'), type: 'cloudflare.r2_bucket' },
        null
      )
    ).rejects.toMatchObject({ code: 'BUCKET_NOT_EMPTY', retryable: false })
    const exists = harness([
      getBucket(200, fx('r2-bucket')),
      { method: 'POST', path: /buckets$/, body: {} }
    ])
    await expect(
      adapter.apply(
        exists.ctx,
        { ...op('create'), type: 'cloudflare.r2_bucket' },
        desired('cloudflare.r2_bucket', { name: 'cm-staging-uploads' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(exists.writes()).toEqual([])
  })

  it('worker route: a taken pattern is refused; a create is one POST', async () => {
    const h = harness([
      GET_ZONE,
      {
        method: 'GET',
        path: new RegExp(`^/zones/${Z}/workers/routes$`),
        body: { success: true, result: [] }
      },
      { method: 'POST', path: new RegExp(`^/zones/${Z}/workers/routes$`), body: fx('worker-route') }
    ])
    const r = await adapter.apply(
      h.ctx,
      { ...op('create'), type: 'cloudflare.worker_route' },
      desired(
        'cloudflare.worker_route',
        { pattern: 'app.example.test/*', script: 'edge-proxy' },
        { zone: Z }
      )
    )
    expect(r.externalId).toBe(`${Z}:${RT}`)
    expect(h.writes()[0].body).toEqual({ pattern: 'app.example.test/*', script: 'edge-proxy' })
    const clash = harness([
      GET_ZONE,
      {
        method: 'GET',
        path: new RegExp(`^/zones/${Z}/workers/routes$`),
        body: fx('worker-routes')
      },
      { method: 'POST', path: /routes$/, body: fx('worker-route') }
    ])
    await expect(
      adapter.apply(
        clash.ctx,
        { ...op('create'), type: 'cloudflare.worker_route' },
        desired(
          'cloudflare.worker_route',
          { pattern: 'app.example.test/*', script: 'x' },
          { zone: Z }
        )
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(clash.writes()).toEqual([])
  })

  it('worker secret: PUT once with the value; an existing secret the Hub did not make is refused', async () => {
    const VALUE = 'test-secret-worker-value-77'
    const secretPath = new RegExp(`^/accounts/${A}/workers/scripts/edge-proxy/secrets$`)
    const get = (status: number): Route => ({
      method: 'GET',
      path: new RegExp(`^/accounts/${A}/workers/scripts/edge-proxy/secrets/SIGNING_KEY$`),
      status,
      body: status === 200 ? fx('worker-secret') : fx('error-not-found')
    })
    const h = harness([get(404), { method: 'PUT', path: secretPath, body: fx('worker-secret') }])
    const r = await adapter.apply(
      h.ctx,
      { ...op('create'), type: 'cloudflare.worker_secret' },
      desired('cloudflare.worker_secret', {
        script: 'edge-proxy',
        name: 'SIGNING_KEY',
        value: secret(true, VALUE)
      })
    )
    expect(h.writes()[0].body).toEqual({ name: 'SIGNING_KEY', text: VALUE, type: 'secret_text' })
    expect(JSON.stringify(r)).not.toContain(VALUE)
    const taken = harness([get(200), { method: 'PUT', path: secretPath, body: {} }])
    await expect(
      adapter.apply(
        taken.ctx,
        { ...op('create'), type: 'cloudflare.worker_secret' },
        desired('cloudflare.worker_secret', {
          script: 'edge-proxy',
          name: 'SIGNING_KEY',
          value: secret(true, VALUE)
        })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(taken.writes()).toEqual([])
  })

  it('waf rule: creates the ruleset when there is none, else appends; a same-name rule is refused', async () => {
    const ep = new RegExp(`^/zones/${Z}/rulesets/phases/http_request_firewall_custom/entrypoint$`)
    const rs = new RegExp(`^/zones/${Z}/rulesets/90000000000000000000000000000001/rules$`)
    const want = (description: string) =>
      desired(
        'cloudflare.waf_custom_rule',
        {
          description,
          expression: '(http.host eq "x.example.test")',
          action: 'managed_challenge',
          enabled: true
        },
        { zone: Z }
      )
    const none = harness([
      GET_ZONE,
      { method: 'GET', path: ep, status: 404, body: fx('error-not-found') },
      { method: 'PUT', path: ep, body: fx('waf-ruleset-after-create') }
    ])
    const r1 = await adapter.apply(
      none.ctx,
      { ...op('create'), type: 'cloudflare.waf_custom_rule' },
      want('New rule')
    )
    expect(r1.externalId).toBe(`${Z}:f0000000000000000000000000000002`)
    expect(none.writes()[0].body.rules).toHaveLength(1)
    const some = harness([
      GET_ZONE,
      { method: 'GET', path: ep, body: fx('waf-ruleset') },
      { method: 'POST', path: rs, body: fx('waf-ruleset-after-create') }
    ])
    const r2 = await adapter.apply(
      some.ctx,
      { ...op('create'), type: 'cloudflare.waf_custom_rule' },
      want('New rule')
    )
    expect(r2.externalId).toBe(`${Z}:f0000000000000000000000000000002`)
    const clash = harness([
      GET_ZONE,
      { method: 'GET', path: ep, body: fx('waf-ruleset') },
      { method: 'POST', path: rs, body: fx('waf-ruleset-after-create') }
    ])
    await expect(
      adapter.apply(
        clash.ctx,
        { ...op('create'), type: 'cloudflare.waf_custom_rule' },
        want('Block office scanner')
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(clash.writes()).toEqual([])
  })

  it('every id put into a URL path is checked: a dotted or slashed id never reaches the network', async () => {
    const h = harness([])
    await expect(adapter.observe(h.ctx, 'cloudflare.r2_bucket', '..')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(adapter.observe(h.ctx, 'cloudflare.tunnel', '../x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(
      adapter.observe(h.ctx, 'cloudflare.dns_record', `${Z}:../../x`)
    ).rejects.toMatchObject({ code: 'BAD_ID' })
    await expect(
      adapter.observe(h.ctx, 'cloudflare.worker_secret', 'edge-proxy:a/b')
    ).rejects.toMatchObject({ code: 'BAD_ID' })
    expect(h.calls).toEqual([])
  })
})

describe('cloudflare adapter: errors', () => {
  it('maps 429 to retryable and names the wait', async () => {
    const h = harness([
      {
        method: 'GET',
        path: new RegExp(`^/zones/${Z}$`),
        status: 429,
        headers: { 'retry-after': '30' },
        body: fx('error-rate-limited')
      }
    ])
    const err = await adapter.observe(h.ctx, 'cloudflare.zone', Z).catch((e) => e)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 30 s')
  })

  it('a 5xx is retryable, a 403 is not', async () => {
    const h = harness([
      { method: 'GET', path: /cfd_tunnel/, status: 503, body: {} },
      { method: 'GET', path: /access\/apps/, status: 403, body: fx('error-forbidden') }
    ])
    await expect(adapter.list(h.ctx, 'cloudflare.tunnel')).rejects.toMatchObject({
      retryable: true
    })
    await expect(adapter.list(h.ctx, 'cloudflare.access_application')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      retryable: false
    })
  })

  it('secrets never appear in errors: the token Cloudflare echoes and a Worker secret value are masked', async () => {
    const VALUE = 'test-secret-worker-value-88'
    const h = harness([
      {
        method: 'GET',
        path: /secrets\/SIGNING_KEY$/,
        status: 404,
        body: fx('error-not-found')
      },
      {
        method: 'PUT',
        path: /secrets$/,
        status: 400,
        body: {
          success: false,
          errors: [{ code: 10021, message: `bad value ${VALUE}` }],
          result: null
        }
      }
    ])
    const err = await adapter
      .apply(
        h.ctx,
        {
          kind: 'create',
          type: 'cloudflare.worker_secret',
          resourceId: 1,
          externalId: null,
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        desired('cloudflare.worker_secret', {
          script: 'edge-proxy',
          name: 'SIGNING_KEY',
          value: secret(true, VALUE)
        })
      )
      .catch((e) => e)
    expect(err.message).toContain('Cloudflare answered 400')
    expect(err.message).not.toContain(VALUE)
    const echo = harness([
      { method: 'GET', path: /zones/, status: 400, body: fx('error-echo-token') }
    ])
    const e2 = await adapter.observe(echo.ctx, 'cloudflare.zone', Z).catch((e) => e)
    expect(e2.message).not.toContain(TOKEN)
  })
})

describe('cloudflare adapter: risk flags per type', () => {
  const op = (
    kind: PlannedOp['kind'],
    changes: PlannedOp['changes'] = [],
    preconditions = {}
  ): PlannedOp => ({
    kind,
    type: '',
    resourceId: 1,
    externalId: 'x',
    reason: '',
    changes,
    preconditions,
    risk: []
  })

  it('dns: un-proxying exposes the origin; TXT changes are not downtime', () => {
    const s = spec('cloudflare.dns_record')
    const un = op('update', [{ field: 'proxied', from: true, to: false }])
    expect(s.risk(un, desired('cloudflare.dns_record', { type: 'A' }))).toEqual(['public_exposure'])
    const txt = op('update', [{ field: 'content', from: 'a', to: 'b' }])
    expect(s.risk(txt, desired('cloudflare.dns_record', { type: 'TXT' }))).toEqual([])
    expect(s.risk(op('noop'), null)).toEqual([])
  })

  it('tunnel and routes: deleting a tunnel is destructive + downtime; a raw TCP hostname is public exposure', () => {
    expect(spec('cloudflare.tunnel').risk(op('delete'), null)).toEqual(['destructive', 'downtime'])
    const r = spec('cloudflare.tunnel_route')
    expect(
      r.risk(op('update'), desired('cloudflare.tunnel_route', { service: 'http://a:1' }))
    ).toEqual(['downtime'])
    expect(
      r.risk(op('create'), desired('cloudflare.tunnel_route', { service: 'ssh://host:22' }))
    ).toEqual(['public_exposure'])
    expect(
      r.risk(op('create'), desired('cloudflare.tunnel_route', { service: 'http://a:1' }))
    ).toEqual([])
  })

  it('access: a policy that lets everyone in is public exposure; require narrows it', () => {
    const s = spec('cloudflare.access_policy')
    const everyone = desired('cloudflare.access_policy', {
      decision: 'allow',
      include: [{ kind: 'everyone' }]
    })
    expect(s.risk(op('create'), everyone)).toEqual(['public_exposure'])
    expect(s.risk(op('update'), everyone)).toEqual(['public_exposure'])
    expect(
      s.risk(
        op('create'),
        desired('cloudflare.access_policy', { decision: 'bypass', include: [{ kind: 'everyone' }] })
      )
    ).toEqual(['public_exposure'])
    expect(
      s.risk(
        op('create'),
        desired('cloudflare.access_policy', {
          decision: 'allow',
          include: [{ kind: 'everyone' }],
          require: [{ kind: 'email_domain', value: 'example.test' }]
        })
      )
    ).toEqual([])
    expect(
      s.risk(
        op('create'),
        desired('cloudflare.access_policy', { decision: 'deny', include: [{ kind: 'everyone' }] })
      )
    ).toEqual([])
    expect(s.risk(op('noop'), everyone)).toEqual([])
    expect(
      letsEveryoneIn({ decision: 'allow', include: [{ kind: 'email', value: 'a@b.test' }] })
    ).toBe(false)
    const app = spec('cloudflare.access_application')
    expect(app.risk(op('delete'), null)).toEqual(['destructive', 'public_exposure'])
    expect(app.risk(op('update', [{ field: 'domain', from: 'a', to: 'b' }]), null)).toEqual([
      'public_exposure'
    ])
    expect(app.risk(op('update', [{ field: 'name', from: 'a', to: 'b' }]), null)).toEqual([])
  })

  it('bucket delete is destructive + data_loss; worker routes move traffic; secret delete is destructive', () => {
    expect(spec('cloudflare.r2_bucket').risk(op('delete'), null)).toEqual([
      'destructive',
      'data_loss'
    ])
    const w = spec('cloudflare.worker_route')
    expect(w.risk(op('delete'), null)).toEqual(['downtime', 'destructive'])
    expect(w.risk(op('create'), desired('cloudflare.worker_route', { pattern: '*/*' }))).toEqual([
      'downtime'
    ])
    expect(
      w.risk(op('create'), desired('cloudflare.worker_route', { pattern: 'a.example.test/*' }))
    ).toEqual([])
    expect(spec('cloudflare.worker_secret').risk(op('delete'), null)).toEqual(['destructive'])
  })

  it('waf: a rule that blocks everything is downtime; a log rule or a narrow one is not', () => {
    const s = spec('cloudflare.waf_custom_rule')
    const rule = (action: string, expression: string, enabled = true) =>
      desired('cloudflare.waf_custom_rule', { action, expression, enabled, description: 'r' })
    expect(s.risk(op('create'), rule('block', 'true'))).toEqual(['downtime'])
    expect(
      s.risk(op('update'), rule('managed_challenge', '(http.request.uri.path ne "")'))
    ).toEqual(['downtime'])
    expect(s.risk(op('create'), rule('block', '(ip.src in {203.0.113.0/24})'))).toEqual([])
    expect(s.risk(op('create'), rule('log', 'true'))).toEqual([])
    expect(s.risk(op('create'), rule('block', 'true', false))).toEqual([])
    expect(matchesEverything('( true )')).toBe(true)
    expect(matchesEverything('(starts_with(http.request.uri.path, "/"))')).toBe(true)
    expect(matchesEverything('http.host eq "a.example.test"')).toBe(false)
  })
})

describe('cloudflare adapter: outputs', () => {
  it('declares outputs and none leak into observed or desired', async () => {
    const declared = Object.fromEntries(
      adapter.types.filter((t) => t.outputs).map((t) => [t.key, t.outputs!.map((o) => o.key)])
    )
    expect(declared).toEqual({
      'cloudflare.tunnel': ['tunnel_token', 'tunnel_id', 'cname_target'],
      'cloudflare.access_application': ['aud'],
      'cloudflare.r2_bucket': ['endpoint', 'bucket', 'access_key_id', 'secret_access_key']
    })
    const tunnel = spec('cloudflare.tunnel')
    expect(tunnel.outputs?.find((o) => o.key === 'tunnel_token')).toMatchObject({ secret: true })
    expect(tunnel.outputs?.some((o) => o.onceOnly)).toBe(false)
    expect(
      spec('cloudflare.r2_bucket')
        .outputs?.filter((o) => o.onceOnly)
        .map((o) => o.key)
    ).toEqual(['access_key_id', 'secret_access_key'])
    // No output key is also a field, so none can reach a plan or an observed state by that route.
    for (const t of adapter.types)
      for (const o of t.outputs ?? []) expect(t.fields.some((f) => f.key === o.key)).toBe(false)
    // An observed tunnel carries no token even though the API's create answer did.
    const h = harness([
      { method: 'GET', path: new RegExp(`^/accounts/${A}/cfd_tunnel/${T}$`), body: fx('tunnel') }
    ])
    const o = await adapter.observe(h.ctx, 'cloudflare.tunnel', T)
    expect(JSON.stringify(o)).not.toContain('test-secret-tunnel-token')
    expect(adapter.notify).toBeUndefined()
  })
})

describe('cloudflare adapter: estimates', () => {
  beforeEach(() => {
    registry.resetProvidersForTest()
    registry.registerProvider(cloudflareProvider)
  })

  const est = (
    type: string,
    observed: Observed | null = null,
    traffic?: ProviderContext['traffic']
  ) => {
    const { ctx } = harness([])
    if (traffic) ctx.traffic = traffic
    return spec(type).estimate!(ctx, null, observed)
  }
  const zone = (plan: string): Observed => ({
    type: 'cloudflare.zone',
    externalId: Z,
    name: 'example.test',
    fields: { plan },
    tags: {}
  })

  it('estimate from recorded price answer: a zone costs its plan, Free is a known zero, Enterprise is unknown', async () => {
    const pro = await est('cloudflare.zone', zone('Pro Website'))
    expect(pro).toMatchObject({
      basis: 'plan_price',
      confidence: 'list_price',
      monthlyCents: 2500,
      priceAsOf: '2026-11-26'
    })
    expect(pro.lines[0]).toMatchObject({
      unit: 'month',
      unitCents: 2500,
      kind: 'base',
      source: 'plan_price'
    })
    expect(await est('cloudflare.zone', zone('Free Website'))).toMatchObject({
      confidence: 'exact',
      monthlyCents: 0
    })
    expect(await est('cloudflare.zone', zone('Business Website'))).toMatchObject({
      monthlyCents: 25000
    })
    expect(await est('cloudflare.zone', zone('Enterprise Website'))).toMatchObject({
      confidence: 'unknown'
    })
    expect(await est('cloudflare.zone', null)).toMatchObject({ confidence: 'unknown' })
  })

  it('estimate from recorded price answer: R2 is usage-priced with a base line and a "plus usage" note; egress is free', async () => {
    const e = await est('cloudflare.r2_bucket', null, { egressGbMonth: 5000, source: 'form' })
    expect(e).toMatchObject({ basis: 'usage', confidence: 'usage_varies', monthlyCents: 0 })
    expect(e.lines[0]).toMatchObject({ unit: 'GB-month', unitCents: 1.5, qty: 0 })
    expect(e.note).toMatch(/plus usage/)
    expect(e.note).toMatch(/egress\) is free/)
    expect(e.lines.some((l) => l.kind === 'transfer')).toBe(false)
  })

  it('estimate from recorded price answer: included types are a known zero; Zero Trust and Workers name their plan price', async () => {
    for (const t of [
      'cloudflare.dns_record',
      'cloudflare.tunnel',
      'cloudflare.tunnel_route',
      'cloudflare.waf_custom_rule',
      'cloudflare.worker_secret'
    ])
      expect(await est(t)).toMatchObject({ basis: 'free', confidence: 'exact', monthlyCents: 0 })
    const zt = await est('cloudflare.access_application')
    expect(zt).toMatchObject({ basis: 'plan_price', confidence: 'list_price', monthlyCents: 0 })
    expect(zt.note).toContain('free up to 50 users')
    expect(zt.note).toContain('$7 per user')
    expect((await est('cloudflare.access_policy')).note).toContain('$7 per user')
    expect((await est('cloudflare.worker_route')).note).toContain('$5 a month')
  })
})
