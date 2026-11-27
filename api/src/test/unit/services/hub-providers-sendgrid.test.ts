import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 25: the SendGrid adapter against recorded (fake-valued) answers.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { ensureCoreProviders, CORE_PROVIDERS } = await import(
  '../../../services/hub/providers/index.js'
)
const registry = await import('../../../services/hub/providers/registry.js')
const { sendgridAdapter } = await import('../../../services/hub/providers/sendgrid/index.js')
const { ownKeyId } = await import('../../../services/hub/providers/sendgrid/client.js')

import type { HubResourceRow } from '../../../services/hub/providers/store.js'
import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ROTATE_OUTPUTS_FIELD
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/sendgrid/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const OWN_ID = 'FakeKeyIdConnection00002'
const KEY = `SG.${OWN_ID}.test-secret-sendgrid-key-0001`
const NEW_KEY = 'SG.FakeKeyIdDemoApp0000001.test-secret-sendgrid-new-key-0001'
const T_KEY = 'sendgrid.api_key'
const T_SENDER = 'sendgrid.sender'
const T_DOMAIN = 'sendgrid.domain_authentication'
const T_IP = 'sendgrid.ip_access'
const KID = 'FakeKeyIdDemoApp0000001'

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
      path: u.pathname,
      query: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response('{"errors":[{"message":"not found"}]}', { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 || status === 202 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: sendgridAdapter,
    connectionId: 1,
    config: {},
    secrets: { apiKey: KEY },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

function desired(
  type: string,
  fields: Record<string, unknown>,
  externalId: string | null = null,
  refs: DesiredResource['refs'] = {}
): DesiredResource {
  return {
    resourceId: 7,
    type,
    externalId,
    scope: type === T_KEY || type === T_SENDER ? 'app' : 'shared',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: {}
  }
}

const op = (type: string, over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'update',
  type,
  resourceId: 7,
  externalId: null,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

const typeSpec = (key: string) => sendgridAdapter.types.find((t) => t.key === key)!

const keyObs = (over: Record<string, unknown> = {}): Observed => ({
  type: T_KEY,
  externalId: KID,
  name: 'demo-app-mail',
  fields: { name: 'demo-app-mail', scopes: ['mail.send'], ...over },
  tags: {}
})

const senderObs = (over: Record<string, unknown> = {}): Observed => ({
  type: T_SENDER,
  externalId: '1001',
  name: 'Demo alerts',
  fields: {
    nickname: 'Demo alerts',
    from_email: 'alerts@example.com',
    from_name: 'Demo Hub',
    reply_to: 'alerts@example.com',
    reply_to_name: null,
    address: '1 Example Street',
    address2: null,
    city: 'Exampleville',
    state: 'EX',
    zip: '00000',
    country: 'US',
    verified: true,
    locked: false,
    ...over
  },
  tags: {}
})

const senderFields = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  nickname: 'Demo alerts',
  from_email: 'alerts@example.com',
  from_name: 'Demo Hub',
  reply_to: '',
  address: '1 Example Street',
  city: 'Exampleville',
  state: 'EX',
  zip: '00000',
  country: 'US',
  ...over
})

const domainObs = (over: Record<string, unknown> = {}): Observed => ({
  type: T_DOMAIN,
  externalId: '2001',
  name: 'example.com',
  fields: {
    domain: 'example.com',
    subdomain: 'em',
    automatic_security: true,
    default: false,
    valid: false,
    ...over
  },
  tags: {}
})

beforeEach(() => {
  registry.resetProvidersForTest()
})

describe('sendgrid adapter: registration', () => {
  it('is a core provider on api.sendgrid.com with a secret API key', () => {
    ensureCoreProviders()
    expect(registry.getProvider('sendgrid')).toBe(sendgridAdapter)
    expect(CORE_PROVIDERS).toContain(sendgridAdapter)
    expect(sendgridAdapter.connection.hosts({})).toEqual(['api.sendgrid.com'])
    expect(sendgridAdapter.connection.fields.find((f) => f.key === 'apiKey')?.secret).toBe(true)
    expect(sendgridAdapter.connection.describe({})).not.toContain(KEY)
    expect(sendgridAdapter.connection.validate?.({}, { apiKey: 'nope' })).not.toEqual([])
    expect(sendgridAdapter.connection.validate?.({}, { apiKey: KEY })).toEqual([])
    expect(sendgridAdapter.types.map((t) => t.key)).toEqual([T_KEY, T_SENDER, T_DOMAIN, T_IP])
  })

  it('only the verified sender sends; no type is costed', () => {
    expect(sendgridAdapter.types.filter((t) => t.sends).map((t) => t.key)).toEqual([T_SENDER])
    for (const t of sendgridAdapter.types) expect(t.costClass).toBeUndefined()
  })

  it('refuses a host other than api.sendgrid.com and sends the key as a bearer', async () => {
    const { ctx, calls } = harness([{ method: 'GET', path: /scopes$/, body: fx('scopes') }])
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
    await sendgridAdapter.testConnection(ctx)
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('reads the id of the connection’s own key from its shape', () => {
    expect(ownKeyId(KEY)).toBe(OWN_ID)
    expect(ownKeyId('nope')).toBeNull()
  })
})

describe('sendgrid adapter: testConnection', () => {
  it('lists missing permissions when the key is refused', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /scopes$/, status: 401, body: fx('error-unauthorized') }
    ])
    const r = await sendgridAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.missing).toHaveLength(5)
    expect(r.message).not.toContain(KEY)
  })

  it('lists what a mail-send-only key lacks', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /scopes$/, body: { scopes: ['mail.send'] } },
      { method: 'GET', path: /whitelabel\/domains$/, status: 403, body: fx('error-unauthorized') },
      { method: 'GET', path: /verified_senders$/, status: 403, body: fx('error-unauthorized') },
      { method: 'GET', path: /whitelist$/, status: 403, body: fx('error-unauthorized') }
    ])
    const r = await sendgridAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.permissions.find((p) => p.need.includes('send mail'))?.has).toBe(true)
    expect(r.missing).toEqual([
      'make and delete API keys (api_keys.create, api_keys.read, api_keys.delete)',
      'manage domain authentication (whitelabel.create, whitelabel.read, whitelabel.delete)',
      'read and make verified senders',
      'read the IP access list (access_settings.whitelist.read)'
    ])
  })

  it('has nothing missing for a full-access key and names the account', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /scopes$/, body: fx('scopes') },
      { method: 'GET', path: /whitelabel\/domains$/, body: fx('whitelabel-domains') },
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') },
      { method: 'GET', path: /whitelist$/, body: fx('whitelist') },
      { method: 'GET', path: /user\/username$/, body: { username: 'demo-account' } }
    ])
    const r = await sendgridAdapter.testConnection(ctx)
    expect(r).toMatchObject({ ok: true, missing: [], identity: 'SendGrid account demo-account' })
  })
})

describe('sendgrid adapter: observe and list', () => {
  it('maps an API key (scopes, no value)', async () => {
    const { ctx } = harness([{ method: 'GET', path: /api_keys\/[^/]+$/, body: fx('api-key') }])
    const seen = await sendgridAdapter.observe(ctx, T_KEY, KID)
    expect(seen).toMatchObject({
      type: T_KEY,
      externalId: KID,
      name: 'demo-app-mail',
      fields: { name: 'demo-app-mail', scopes: ['mail.send'] }
    })
    expect(JSON.stringify(seen)).not.toContain('SG.')
  })

  it('maps a verified sender and a domain authentication', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') },
      { method: 'GET', path: /whitelabel\/domains\/2001$/, body: fx('whitelabel-domain') }
    ])
    const sender = await sendgridAdapter.observe(ctx, T_SENDER, '1002')
    expect(sender).toMatchObject({
      name: 'Pending sender',
      status: 'pending',
      fields: { from_email: 'pending@example.com', verified: false, state: null }
    })
    const domain = await sendgridAdapter.observe(ctx, T_DOMAIN, '2001')
    expect(domain).toMatchObject({
      name: 'example.com',
      status: 'pending',
      fields: { domain: 'example.com', subdomain: 'em', automatic_security: true, valid: false }
    })
    // The DNS records are an output, never part of the observed state.
    expect(JSON.stringify(domain)).not.toContain('sendgrid.net')
  })

  it('maps an IP access rule; a missing resource observes as gone', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /whitelist\/3001$/, body: fx('whitelist').result[0] }
    ])
    expect(await sendgridAdapter.observe(ctx, T_IP, '3001')).toMatchObject({
      name: '203.0.113.7',
      fields: { ip: '203.0.113.7' }
    })
    const { ctx: c2 } = harness([])
    expect(await sendgridAdapter.observe(c2, T_KEY, KID)).toBeNull()
    expect(await sendgridAdapter.observe(c2, T_DOMAIN, '2001')).toBeNull()
    expect(await sendgridAdapter.observe(c2, T_IP, '3001')).toBeNull()
  })

  it('lists each type; sender pages continue with lastSeenID', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: 5000 + i, nickname: `n${i}` }))
    const { ctx, calls } = harness([
      { method: 'GET', path: /api_keys$/, body: fx('api-keys') },
      { method: 'GET', path: /verified_senders$/, body: { results: full } },
      { method: 'GET', path: /whitelabel\/domains$/, body: fx('whitelabel-domains') },
      { method: 'GET', path: /whitelist$/, body: fx('whitelist') }
    ])
    expect((await sendgridAdapter.list(ctx, T_KEY)).items.map((i) => i.name)).toEqual([
      'demo-app-mail',
      'hub-connection'
    ])
    const page = await sendgridAdapter.list(ctx, T_SENDER)
    expect(page.items).toHaveLength(100)
    expect(page.cursor).toBe('5099')
    await sendgridAdapter.list(ctx, T_SENDER, page.cursor)
    expect(calls.at(-1)?.query.get('lastSeenID')).toBe('5099')
    const domains = await sendgridAdapter.list(ctx, T_DOMAIN)
    expect(domains.cursor).toBeNull()
    expect(domains.items.map((d) => d.name)).toEqual(['example.com', 'example.org'])
    expect((await sendgridAdapter.list(ctx, T_IP)).items).toHaveLength(1)
  })

  it('refuses ids that are not safe path segments', async () => {
    const { ctx, calls } = harness([])
    await expect(sendgridAdapter.observe(ctx, T_KEY, '../x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(sendgridAdapter.observe(ctx, T_KEY, 'a/b')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(sendgridAdapter.observe(ctx, T_DOMAIN, '12/../3')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(sendgridAdapter.observe(ctx, T_IP, 'x')).rejects.toMatchObject({ code: 'BAD_ID' })
    await expect(sendgridAdapter.observe(ctx, T_SENDER, '..')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    expect(calls).toEqual([])
  })
})

describe('sendgrid adapter: plan', () => {
  const { ctx } = harness([])

  it('api key: create says mail.send only and names the SMTP bindings', () => {
    const [p] = sendgridAdapter.plan(ctx, desired(T_KEY, { name: 'demo-app-mail' }), null)
    expect(p.kind).toBe('create')
    expect(p.reason).toContain('SendGrid API key demo-app-mail')
    expect(p.reason).toContain('smtp_pass')
    expect(p.changes).toEqual([
      { field: 'name', to: 'demo-app-mail' },
      { field: 'scopes', to: ['mail.send'] }
    ])
  })

  it('api key: rename is an update; rotate is a named op; delete says anything sending stops', () => {
    const [u] = sendgridAdapter.plan(ctx, desired(T_KEY, { name: 'renamed' }, KID), keyObs())
    expect(u).toMatchObject({
      kind: 'update',
      changes: [{ field: 'name', from: 'demo-app-mail', to: 'renamed' }]
    })
    const [r] = sendgridAdapter.plan(
      ctx,
      desired(T_KEY, { name: 'demo-app-mail', [ROTATE_OUTPUTS_FIELD]: true }, KID),
      keyObs()
    )
    expect(r).toMatchObject({ kind: 'update', action: 'rotate' })
    expect(r.reason).toContain('old key stays valid')
    const [d] = sendgridAdapter.plan(ctx, null, keyObs())
    expect(d.kind).toBe('delete')
    expect(d.reason).toContain('refused straight away')
    expect(
      sendgridAdapter.plan(ctx, desired(T_KEY, { name: 'demo-app-mail' }, KID), keyObs())
    ).toEqual([])
  })

  it('api key: the connection’s own key is never planned for deletion', () => {
    expect(() => sendgridAdapter.plan(ctx, null, { ...keyObs(), externalId: OWN_ID })).toThrow(
      /key the connection itself uses/
    )
  })

  it('sender: create names the verification email; update lists labels; a blank reply-to means the From address', () => {
    const [c] = sendgridAdapter.plan(ctx, desired(T_SENDER, senderFields()), null)
    expect(c.kind).toBe('create')
    expect(c.reason).toContain('Verified sender Demo alerts')
    expect(c.reason).toContain('alerts@example.com')
    expect(
      sendgridAdapter.plan(ctx, desired(T_SENDER, senderFields(), '1001'), senderObs())
    ).toEqual([])
    const [u] = sendgridAdapter.plan(
      ctx,
      desired(T_SENDER, senderFields({ nickname: 'Hub alerts' }), '1001'),
      senderObs()
    )
    expect(u).toMatchObject({
      kind: 'update',
      changes: [{ field: 'nickname', from: 'Demo alerts', to: 'Hub alerts' }]
    })
    expect(u.reason).toContain('Nickname')
  })

  it('sender: a new From address is a replace, delete is a delete, resend is a named op only while unverified', () => {
    const [r] = sendgridAdapter.plan(
      ctx,
      desired(T_SENDER, senderFields({ from_email: 'new@example.com' }), '1001'),
      senderObs()
    )
    expect(r.kind).toBe('replace')
    expect(r.reason).toContain('verify')
    const [d] = sendgridAdapter.plan(ctx, null, senderObs())
    expect(d.kind).toBe('delete')
    const want = desired(T_SENDER, senderFields({ resend_verification: true }), '1001')
    expect(sendgridAdapter.plan(ctx, want, senderObs())).toEqual([])
    const [x] = sendgridAdapter.plan(ctx, want, senderObs({ verified: false }))
    expect(x).toMatchObject({ action: 'resend_verification', kind: 'update' })
  })

  it('sender: a recipient that is not an email is refused while planning', () => {
    expect(() =>
      sendgridAdapter.plan(ctx, desired(T_SENDER, senderFields({ recipients: ['nope'] })), null)
    ).toThrow(/not an email address/)
    expect(() =>
      sendgridAdapter.plan(
        ctx,
        desired(
          T_SENDER,
          senderFields({ recipients: Array.from({ length: 51 }, (_, i) => `a${i}@example.com`) })
        ),
        null
      )
    ).toThrow(/At most 50/)
  })

  it('domain: create, default is an update, identity change is a replace, validate is a named op', () => {
    const f = { domain: 'example.com', subdomain: 'em', automatic_security: true, default: false }
    const [c] = sendgridAdapter.plan(ctx, desired(T_DOMAIN, f), null)
    expect(c.kind).toBe('create')
    expect(c.reason).toContain('dns_records')
    const [u] = sendgridAdapter.plan(
      ctx,
      desired(T_DOMAIN, { ...f, default: true }, '2001'),
      domainObs()
    )
    expect(u).toMatchObject({
      kind: 'update',
      changes: [{ field: 'default', from: false, to: true }]
    })
    const [r] = sendgridAdapter.plan(
      ctx,
      desired(T_DOMAIN, { ...f, subdomain: 'mail' }, '2001'),
      domainObs()
    )
    expect(r.kind).toBe('replace')
    expect(r.reason).toContain('new DNS records')
    const [v] = sendgridAdapter.plan(
      ctx,
      desired(T_DOMAIN, { ...f, validate: true }, '2001', {
        cloudflare_records: ['r1', 'r2', 'r3']
      }),
      domainObs()
    )
    expect(v).toMatchObject({ action: 'validate', kind: 'update' })
    expect(v.reason).toContain('3 DNS records made beside it')
    expect(sendgridAdapter.plan(ctx, desired(T_DOMAIN, f, '2001'), domainObs())).toEqual([])
  })

  it('ip access is read only', () => {
    const o: Observed = {
      type: T_IP,
      externalId: '3001',
      name: '203.0.113.7',
      fields: { ip: '203.0.113.7' },
      tags: {}
    }
    expect(sendgridAdapter.plan(ctx, desired(T_IP, {}, '3001'), o)).toEqual([])
    expect(() => sendgridAdapter.plan(ctx, null, o)).toThrow(/read only/)
    expect(() => sendgridAdapter.plan(ctx, desired(T_IP, {}), null)).toThrow(/read only/)
    expect(typeSpec(T_IP).capabilities).toMatchObject({
      create: false,
      update: false,
      delete: false,
      adopt: true
    })
  })
})

describe('sendgrid adapter: risk flags', () => {
  it('risk flags per type', () => {
    const r = (type: string, kind: PlannedOp['kind']) =>
      typeSpec(type).risk(op(type, { kind }), null)
    expect(r(T_KEY, 'create')).toEqual([])
    expect(r(T_KEY, 'delete')).toEqual(['destructive'])
    expect(r(T_SENDER, 'update')).toEqual([])
    expect(r(T_SENDER, 'delete')).toEqual(['destructive'])
    expect(r(T_SENDER, 'replace')).toEqual(['destructive'])
    expect(r(T_DOMAIN, 'update')).toEqual([])
    expect(r(T_DOMAIN, 'delete')).toEqual(['destructive', 'downtime'])
    expect(r(T_DOMAIN, 'replace')).toEqual(['destructive', 'downtime'])
    expect(r(T_IP, 'noop')).toEqual([])
  })
})

describe('sendgrid adapter: apply (api key)', () => {
  const want = () => desired(T_KEY, { name: 'demo-app-mail' })

  it('create posts mail.send only and hands the key out as an output, nowhere else', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /api_keys$/, body: { result: [] } },
      { method: 'POST', path: /api_keys$/, body: fx('api-key-create') }
    ])
    const res = await sendgridAdapter.apply(ctx, op(T_KEY, { kind: 'create' }), want())
    expect(res.ok).toBe(true)
    expect(res.externalId).toBe(KID)
    expect(res.outputs).toEqual({
      api_key: NEW_KEY,
      smtp_host: 'smtp.sendgrid.net',
      smtp_port: '587',
      smtp_user: 'apikey'
    })
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'demo-app-mail',
      scopes: ['mail.send']
    })
    expect(JSON.stringify(res.observed)).not.toContain(NEW_KEY)
    expect(JSON.stringify(res.answer)).not.toContain(NEW_KEY)
    // Every output the adapter hands out is declared, the key is secret and once-only.
    const declared = typeSpec(T_KEY).outputs!
    expect(declared.map((o) => o.key).sort()).toEqual(Object.keys(res.outputs!).sort())
    expect(declared.find((o) => o.key === 'api_key')).toMatchObject({
      secret: true,
      onceOnly: true
    })
  })

  it('create is idempotent: a resumed create with its id recorded posts nothing and never re-reads the key', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /api_keys\/[^/]+$/, body: fx('api-key') }
    ])
    const res = await sendgridAdapter.apply(
      ctx,
      op(T_KEY, { kind: 'create' }),
      desired(T_KEY, { name: 'demo-app-mail' }, KID)
    )
    expect(res.answer).toMatchObject({ already: 'exists' })
    expect(res.outputs).not.toHaveProperty('api_key')
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('create over a key the Hub did not make is ALREADY_EXISTS, nothing written', async () => {
    const { ctx, calls } = harness([{ method: 'GET', path: /api_keys$/, body: fx('api-keys') }])
    await expect(
      sendgridAdapter.apply(ctx, op(T_KEY, { kind: 'create' }), want())
    ).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      retryable: false
    })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('findExisting names a key of the same name for the plan', async () => {
    const { ctx } = harness([{ method: 'GET', path: /api_keys$/, body: fx('api-keys') }])
    const hit = await sendgridAdapter.findExisting?.(ctx, T_KEY, want())
    expect(hit?.externalId).toBe(KID)
  })

  it('rename reads first, patches the name only, and writes nothing when it already matches', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /api_keys\/[^/]+$/, body: fx('api-key') },
      { method: 'PATCH', path: /api_keys\/[^/]+$/, body: {} }
    ])
    const res = await sendgridAdapter.apply(
      ctx,
      op(T_KEY, { externalId: KID }),
      desired(T_KEY, { name: 'renamed' }, KID)
    )
    expect(res.answer).toMatchObject({ changed: ['name'] })
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'renamed' })
    const { ctx: c2, calls: calls2 } = harness([
      { method: 'GET', path: /api_keys\/[^/]+$/, body: fx('api-key') }
    ])
    const same = await sendgridAdapter.apply(
      c2,
      op(T_KEY, { externalId: KID }),
      desired(T_KEY, { name: 'demo-app-mail' }, KID)
    )
    expect(same.answer).toMatchObject({ already: 'matches' })
    expect(calls2.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('rotate makes a NEW key, keeps the old one valid, and answers the new id and outputs', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /api_keys\/[^/]+$/, body: fx('api-key') },
      {
        method: 'POST',
        path: /api_keys$/,
        body: { ...fx('api-key-create'), api_key_id: 'FakeKeyIdRotated000003' }
      }
    ])
    const res = await sendgridAdapter.apply(
      ctx,
      op(T_KEY, { externalId: KID, action: 'rotate' }),
      desired(T_KEY, { name: 'demo-app-mail', [ROTATE_OUTPUTS_FIELD]: true }, KID)
    )
    expect(res.externalId).toBe('FakeKeyIdRotated000003')
    expect(res.outputs?.api_key).toBe(NEW_KEY)
    expect(res.answer).toMatchObject({
      rotated: true,
      previous_key_id: KID,
      previous_key_kept: true
    })
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([])
    expect(JSON.stringify(res.answer)).not.toContain(NEW_KEY)
  })

  it('rotate refuses a target other than the one planned', async () => {
    const { ctx, calls } = harness([])
    await expect(
      sendgridAdapter.apply(
        ctx,
        op(T_KEY, { externalId: 'OtherKeyId0000000000001', action: 'rotate' }),
        desired(T_KEY, { name: 'x' }, KID)
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(calls).toEqual([])
  })

  it('delete: gone is a no-op success, present is deleted once, the connection’s own key is refused', async () => {
    const { ctx, calls } = harness([{ method: 'DELETE', path: /api_keys\/[^/]+$/, status: 204 }])
    const res = await sendgridAdapter.apply(
      ctx,
      op(T_KEY, { kind: 'delete', externalId: KID }),
      null
    )
    expect(res).toMatchObject({ ok: true, externalId: KID, observed: null })
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    const { ctx: c2 } = harness([])
    expect(
      (await sendgridAdapter.apply(c2, op(T_KEY, { kind: 'delete', externalId: KID }), null)).ok
    ).toBe(true)
    await expect(
      sendgridAdapter.apply(ctx, op(T_KEY, { kind: 'delete', externalId: OWN_ID }), null)
    ).rejects.toMatchObject({ code: 'CONNECTION_KEY' })
  })

  it('readOutputs never asks for the once-only key', async () => {
    const { ctx } = harness([{ method: 'GET', path: /api_keys\/[^/]+$/, body: fx('api-key') }])
    const out = await sendgridAdapter.readOutputs?.(ctx, T_KEY, KID)
    expect(out).toEqual({ smtp_host: 'smtp.sendgrid.net', smtp_port: '587', smtp_user: 'apikey' })
    const { ctx: c2 } = harness([])
    expect(await sendgridAdapter.readOutputs?.(c2, T_KEY, KID)).toEqual({})
  })
})

describe('sendgrid adapter: apply (verified sender)', () => {
  const want = () =>
    desired(T_SENDER, senderFields({ nickname: 'New sender', from_email: 'new@example.com' }))

  it('create posts the sender and answers the From address as an output; reply-to defaults to it', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') },
      {
        method: 'POST',
        path: /verified_senders$/,
        status: 201,
        body: {
          ...fx('verified-senders').results[1],
          id: 1003,
          nickname: 'New sender',
          from_email: 'new@example.com'
        }
      }
    ])
    const res = await sendgridAdapter.apply(ctx, op(T_SENDER, { kind: 'create' }), want())
    expect(res).toMatchObject({
      ok: true,
      externalId: '1003',
      outputs: { smtp_from: 'new@example.com' }
    })
    expect(res.answer).toMatchObject({ verification: 'sent' })
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      nickname: 'New sender',
      from_email: 'new@example.com',
      reply_to: 'new@example.com',
      city: 'Exampleville',
      country: 'US'
    })
    expect(typeSpec(T_SENDER).outputs?.map((o) => o.key)).toEqual(['smtp_from'])
  })

  it('create over an address that already has a sender is ALREADY_EXISTS; missing fields are refused first', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') }
    ])
    await expect(
      sendgridAdapter.apply(
        ctx,
        op(T_SENDER, { kind: 'create' }),
        desired(T_SENDER, senderFields())
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    await expect(
      sendgridAdapter.apply(
        ctx,
        op(T_SENDER, { kind: 'create' }),
        desired(T_SENDER, senderFields({ city: '' }))
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
  })

  it('findExisting names the sender for an address', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') }
    ])
    const hit = await sendgridAdapter.findExisting?.(
      ctx,
      T_SENDER,
      desired(T_SENDER, senderFields())
    )
    expect(hit?.externalId).toBe('1001')
  })

  it('update patches only the changed fields; a no-change is a no-write', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') },
      { method: 'PATCH', path: /verified_senders\/1001$/, body: {} }
    ])
    const res = await sendgridAdapter.apply(
      ctx,
      op(T_SENDER, { externalId: '1001' }),
      desired(T_SENDER, senderFields({ nickname: 'Hub alerts' }), '1001')
    )
    expect(res.answer).toMatchObject({ changed: ['nickname'] })
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ nickname: 'Hub alerts' })
    const { ctx: c2, calls: calls2 } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') }
    ])
    const same = await sendgridAdapter.apply(
      c2,
      op(T_SENDER, { externalId: '1001' }),
      desired(T_SENDER, senderFields(), '1001')
    )
    expect(same.answer).toMatchObject({ already: 'matches' })
    expect(calls2.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('resend posts once while unverified and nothing when already verified', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') },
      { method: 'POST', path: /verified_senders\/resend\/1002$/, status: 204 }
    ])
    const res = await sendgridAdapter.apply(
      ctx,
      op(T_SENDER, { externalId: '1002', action: 'resend_verification' }),
      desired(T_SENDER, senderFields(), '1002')
    )
    expect(res.answer).toMatchObject({ resent: true })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    const done = await sendgridAdapter.apply(
      ctx,
      op(T_SENDER, { externalId: '1001', action: 'resend_verification' }),
      desired(T_SENDER, senderFields(), '1001')
    )
    expect(done.answer).toMatchObject({ already: 'verified' })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('delete is idempotent', async () => {
    const { ctx, calls } = harness([
      { method: 'DELETE', path: /verified_senders\/1001$/, status: 204 }
    ])
    const res = await sendgridAdapter.apply(
      ctx,
      op(T_SENDER, { kind: 'delete', externalId: '1001' }),
      null
    )
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    await expect(
      sendgridAdapter.apply(ctx, op(T_SENDER, { kind: 'delete', externalId: '1/2' }), null)
    ).rejects.toMatchObject({ code: 'BAD_ID' })
  })
})

describe('sendgrid adapter: apply (domain authentication)', () => {
  const f = { domain: 'example.com', subdomain: 'em', automatic_security: true, default: false }

  it('create posts the domain and answers the CNAME records as the dns_records output only', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /whitelabel\/domains$/, body: [] },
      { method: 'POST', path: /whitelabel\/domains$/, status: 201, body: fx('whitelabel-domain') }
    ])
    const res = await sendgridAdapter.apply(
      ctx,
      op(T_DOMAIN, { kind: 'create' }),
      desired(T_DOMAIN, f)
    )
    expect(res.externalId).toBe('2001')
    const rows = JSON.parse(res.outputs?.dns_records ?? '[]')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      key: 'mail_cname',
      type: 'CNAME',
      host: 'em1234.example.com',
      data: 'u900001.wl001.sendgrid.net'
    })
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      domain: 'example.com',
      subdomain: 'em',
      automatic_security: true,
      custom_spf: false,
      default: false
    })
    expect(JSON.stringify(res.observed)).not.toContain('sendgrid.net')
    expect(JSON.stringify(res.answer ?? {})).not.toContain('sendgrid.net')
    expect(typeSpec(T_DOMAIN).outputs?.map((o) => o.key)).toEqual(['dns_records'])
  })

  it('create over an existing authentication is ALREADY_EXISTS; a bad domain is refused', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /whitelabel\/domains$/, body: fx('whitelabel-domains') }
    ])
    await expect(
      sendgridAdapter.apply(ctx, op(T_DOMAIN, { kind: 'create' }), desired(T_DOMAIN, f))
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    await expect(
      sendgridAdapter.apply(
        ctx,
        op(T_DOMAIN, { kind: 'create' }),
        desired(T_DOMAIN, { ...f, domain: 'not a domain' })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    const hit = await sendgridAdapter.findExisting?.(ctx, T_DOMAIN, desired(T_DOMAIN, f))
    expect(hit?.externalId).toBe('2001')
  })

  it('a resumed create re-reads the records (they are not once-only)', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /whitelabel\/domains\/2001$/, body: fx('whitelabel-domain') }
    ])
    const res = await sendgridAdapter.apply(
      ctx,
      op(T_DOMAIN, { kind: 'create' }),
      desired(T_DOMAIN, f, '2001')
    )
    expect(res.answer).toMatchObject({ already: 'exists' })
    expect(res.outputs?.dns_records).toContain('em1234.example.com')
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
    expect(await sendgridAdapter.readOutputs?.(ctx, T_DOMAIN, '2001')).toHaveProperty('dns_records')
  })

  it('validate: a failing check is retryable with the failing records named; success answers valid', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /whitelabel\/domains\/2001$/, body: fx('whitelabel-domain') },
      { method: 'POST', path: /domains\/2001\/validate$/, body: fx('validate-fail') }
    ])
    const v = op(T_DOMAIN, { externalId: '2001', action: 'validate' })
    await expect(sendgridAdapter.apply(ctx, v, desired(T_DOMAIN, f, '2001'))).rejects.toMatchObject(
      {
        code: 'NOT_VALID_YET',
        retryable: true,
        message: expect.stringContaining('mail_cname, dkim2')
      }
    )
    const { ctx: c2 } = harness([
      {
        method: 'GET',
        path: /whitelabel\/domains\/2001$/,
        body: { ...fx('whitelabel-domain'), valid: true }
      },
      { method: 'POST', path: /domains\/2001\/validate$/, body: fx('validate-ok') }
    ])
    const res = await sendgridAdapter.apply(c2, v, desired(T_DOMAIN, f, '2001'))
    expect(res.answer).toMatchObject({ valid: true })
    expect(res.observed?.fields.valid).toBe(true)
  })

  it('validate refuses a target other than the one planned', async () => {
    const { ctx, calls } = harness([])
    await expect(
      sendgridAdapter.apply(
        ctx,
        op(T_DOMAIN, { externalId: '2002', action: 'validate' }),
        desired(T_DOMAIN, f, '2001')
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(calls).toEqual([])
  })

  it('update patches default; replace deletes then creates; delete is idempotent', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /whitelabel\/domains\/2001$/, body: fx('whitelabel-domain') },
      { method: 'PATCH', path: /whitelabel\/domains\/2001$/, body: {} }
    ])
    const res = await sendgridAdapter.apply(
      ctx,
      op(T_DOMAIN, { externalId: '2001' }),
      desired(T_DOMAIN, { ...f, default: true }, '2001')
    )
    expect(res.answer).toMatchObject({ changed: ['default'] })
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ default: true })
    const { ctx: c2, calls: calls2 } = harness([
      { method: 'DELETE', path: /whitelabel\/domains\/2001$/, status: 204 },
      { method: 'GET', path: /whitelabel\/domains$/, body: [] },
      {
        method: 'POST',
        path: /whitelabel\/domains$/,
        status: 201,
        body: { ...fx('whitelabel-domain'), id: 2003, subdomain: 'mail' }
      }
    ])
    const rep = await sendgridAdapter.apply(
      c2,
      op(T_DOMAIN, { kind: 'replace', externalId: '2001' }),
      desired(T_DOMAIN, { ...f, subdomain: 'mail' }, '2001')
    )
    expect(rep.externalId).toBe('2003')
    expect(calls2.map((c) => c.method)).toEqual(['DELETE', 'GET', 'POST'])
    const { ctx: c3 } = harness([])
    expect(
      (await sendgridAdapter.apply(c3, op(T_DOMAIN, { kind: 'delete', externalId: '2001' }), null))
        .ok
    ).toBe(true)
  })
})

describe('sendgrid adapter: ip access', () => {
  it('writes are refused', async () => {
    const { ctx, calls } = harness([])
    for (const kind of ['create', 'update', 'delete'] as const)
      await expect(
        sendgridAdapter.apply(
          ctx,
          op(T_IP, { kind, externalId: '3001' }),
          desired(T_IP, {}, '3001')
        )
      ).rejects.toMatchObject({ code: 'READ_ONLY' })
    expect(calls).toEqual([])
  })
})

describe('sendgrid adapter: notify', () => {
  const row = (over: Partial<HubResourceRow> = {}): HubResourceRow =>
    ({
      id: 7,
      connection_id: 1,
      provider: 'sendgrid',
      type: T_SENDER,
      external_id: '1001',
      name: 'Demo alerts',
      scope: 'app',
      app_id: 1,
      environment_id: null,
      desired: { ...senderFields(), recipients: ['ops@example.com', 'lead@example.com'] },
      observed: null,
      drift: false,
      observed_at: null,
      tags: {},
      refs: [],
      created_by: null,
      adopted: false,
      deleted_at: null,
      created_at: null,
      updated_at: null,
      ...over
    }) as HubResourceRow
  const msg = {
    kind: 'text' as const,
    title: 'Deploy failed: demo · staging\r\nBcc: evil@example.com',
    body: 'The deploy of 0.3.217 failed <b>badly</b>.',
    link: 'https://hub.example.com/hub/releases',
    severity: 'critical' as const
  }

  it('sends one mail, one personalization per recipient, from the verified sender', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') },
      { method: 'POST', path: /mail\/send$/, status: 202 }
    ])
    const res = await sendgridAdapter.notify!(ctx, row(), msg)
    expect(res).toMatchObject({ ok: true, answer: { sent: 2 } })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body.personalizations).toEqual([
      { to: [{ email: 'ops@example.com' }] },
      { to: [{ email: 'lead@example.com' }] }
    ])
    expect(post.body.from).toEqual({ email: 'alerts@example.com', name: 'Demo Hub' })
    expect(post.body.subject).toBe('[Critical] Deploy failed: demo · staging Bcc: evil@example.com')
    expect(post.body.subject).not.toMatch(/[\r\n]/)
    const html = post.body.content.find((c: any) => c.type === 'text/html').value
    expect(html).toContain('&lt;b&gt;badly&lt;/b&gt;')
    expect(html).toContain('href="https://hub.example.com/hub/releases"')
    expect(post.body.content[0].value).toContain('https://hub.example.com/hub/releases')
  })

  it('maps 429 to retryable', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') },
      {
        method: 'POST',
        path: /mail\/send$/,
        status: 429,
        body: { errors: [{ message: 'too many requests' }] },
        headers: { 'retry-after': '30' }
      }
    ])
    await expect(sendgridAdapter.notify!(ctx, row(), msg)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      status: 429
    })
  })

  it('refuses an unverified sender, no recipients, a gone sender and a type that does not send', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') }
    ])
    await expect(
      sendgridAdapter.notify!(ctx, row({ external_id: '1002' }), msg)
    ).rejects.toMatchObject({
      code: 'SENDER_NOT_VERIFIED'
    })
    await expect(
      sendgridAdapter.notify!(ctx, row({ desired: senderFields() }), msg)
    ).rejects.toMatchObject({ code: 'NO_RECIPIENTS' })
    await expect(
      sendgridAdapter.notify!(ctx, row({ external_id: '9999' }), msg)
    ).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    await expect(sendgridAdapter.notify!(ctx, row({ type: T_KEY }), msg)).rejects.toMatchObject({
      code: 'NOT_A_SENDER'
    })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })
})

describe('sendgrid adapter: health', () => {
  it('key: ok for mail.send only, warns when the key can do more; sender and domain warn while pending', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /api_keys\/FakeKeyIdDemoApp0000001$/, body: fx('api-key') },
      {
        method: 'GET',
        path: /api_keys\/FakeKeyIdWide00000000001$/,
        body: {
          api_key_id: 'FakeKeyIdWide00000000001',
          name: 'wide',
          scopes: ['mail.send', 'api_keys.create']
        }
      },
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') },
      { method: 'GET', path: /whitelabel\/domains\/2001$/, body: fx('whitelabel-domain') }
    ])
    expect((await sendgridAdapter.health!(ctx, T_KEY, KID)).status).toBe('ok')
    expect((await sendgridAdapter.health!(ctx, T_KEY, 'FakeKeyIdWide00000000001')).status).toBe(
      'warn'
    )
    expect((await sendgridAdapter.health!(ctx, T_SENDER, '1001')).status).toBe('ok')
    const pending = await sendgridAdapter.health!(ctx, T_SENDER, '1002')
    expect(pending.status).toBe('warn')
    expect(pending.message).toContain('verification link')
    expect((await sendgridAdapter.health!(ctx, T_DOMAIN, '2001')).status).toBe('warn')
    expect((await sendgridAdapter.health!(ctx, T_DOMAIN, '9')).status).toBe('down')
  })
})

describe('sendgrid adapter: failures', () => {
  it('maps 429 to retryable and scrubs the key from the text', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /api_keys$/,
        status: 429,
        body: { errors: [{ message: `slow down ${KEY}` }] },
        headers: { 'retry-after': '20' }
      }
    ])
    const err: any = await sendgridAdapter.list(ctx, T_KEY).catch((e) => e)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 20')
    expect(err.message).not.toContain(KEY)
  })

  it('does not retry a refusal and never shows a secret in a validation error', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /verified_senders$/, body: fx('verified-senders') },
      {
        method: 'POST',
        path: /verified_senders$/,
        status: 400,
        body: { errors: [{ message: `bad address ${KEY}`, field: 'from_email' }] }
      }
    ])
    const err: any = await sendgridAdapter
      .apply(
        ctx,
        op(T_SENDER, { kind: 'create' }),
        desired(T_SENDER, senderFields({ nickname: 'New', from_email: 'new@example.com' }))
      )
      .catch((e) => e)
    expect(err).toMatchObject({ code: 'PROVIDER_REJECTED', retryable: false, status: 400 })
    expect(err.message).toContain('from_email')
    expect(err.message).not.toContain(KEY)
    expect(err.message).not.toContain('test-secret-sendgrid-key-0001')
  })

  it('a 5xx is retryable and a 401 is not', async () => {
    const { ctx } = harness([{ method: 'GET', path: /api_keys$/, status: 503, body: {} }])
    await expect(sendgridAdapter.list(ctx, T_KEY)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true
    })
    const { ctx: c2 } = harness([
      { method: 'GET', path: /api_keys$/, status: 401, body: fx('error-validation') }
    ])
    const err: any = await sendgridAdapter.list(c2, T_KEY).catch((e) => e)
    expect(err).toMatchObject({ code: 'AUTH_FAILED', retryable: false })
    expect(err.message).not.toContain('test-secret-sendgrid-key-0001')
  })
})
