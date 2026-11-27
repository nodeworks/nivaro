import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Hub providers Task 43: the Namecheap adapter against recorded (fake-valued) XML answers under
// providers/namecheap/__fixtures__, on the sandbox host. Nothing here reaches Namecheap and
// nothing is ever registered.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const registry = await import('../../../services/hub/providers/registry.js')
const { CORE_PROVIDERS, ensureCoreProviders } = await import(
  '../../../services/hub/providers/index.js'
)
const { namecheapAdapter } = await import('../../../services/hub/providers/namecheap/index.js')
const { recordId } = await import('../../../services/hub/providers/namecheap/dns.js')
const { missingEstimates } = await import('../../../services/hub/providers/pricing/index.js')

import type {
  DesiredResource,
  Observed,
  PlannedOp,
  ProviderContext
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/namecheap/__fixtures__')
const fx = (name: string): string => readFileSync(join(FIX, `${name}.xml`), 'utf8')

const KEY = 'test-secret-nc-key-0001'
const IP = '203.0.113.10'
const D = 'hub-test-example.com'

interface Call {
  url: string
  command: string
  params: URLSearchParams
}
type Answer = string | { status: number; body?: string }
type Routes = Record<string, Answer | Answer[]>

function harness(routes: Routes, config: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const queue = new Map<string, Answer[]>()
  for (const [k, v] of Object.entries(routes)) queue.set(k, Array.isArray(v) ? [...v] : [v])
  const fetchImpl = async (url: string, init: any) => {
    const params = new URLSearchParams(String(init?.body ?? ''))
    const command = String(params.get('Command'))
    calls.push({ url, command, params })
    const list = queue.get(command)
    const next = list && (list.length > 1 ? list.shift() : list[0])
    if (!next) return new Response(fx('error-not-found'), { status: 200 })
    if (typeof next === 'string') return new Response(fx(next), { status: 200 })
    return new Response(next.body ? fx(next.body) : '', { status: next.status })
  }
  const ctx = makeProviderContext({
    adapter: namecheapAdapter,
    connectionId: 7,
    config: { api_user: 'hubtest', client_ip: IP, sandbox: true, ...config },
    secrets: { api_key: KEY },
    now: () => new Date('2026-11-27T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  }) as ProviderContext
  const commands = () => calls.map((c) => c.command)
  return { ctx, calls, commands }
}

function desired(
  type: string,
  fields: Record<string, unknown>,
  refs: Record<string, string | string[] | null> = {},
  externalId: string | null = null
): DesiredResource {
  return {
    resourceId: 51,
    type,
    externalId,
    scope: type === 'namecheap.domain' ? 'shared' : 'app',
    appId: type === 'namecheap.domain' ? null : 1,
    environmentId: type === 'namecheap.domain' ? null : 2,
    fields,
    refs,
    tags: {}
  }
}

const spec = (type: string) => namecheapAdapter.types.find((t) => t.key === type)!
const riskOf = (op: PlannedOp, d: DesiredResource | null) => spec(op.type).risk(op, d)

const CONTACT = {
  first_name: 'Test',
  last_name: 'Person',
  email: 'hub-test@example.com',
  phone: '+1.5555550100',
  address_line_1: '1 Test Street',
  city: 'Testville',
  state: 'NY',
  zip_code: '10001',
  country_code: 'US'
}

async function observedDomain(name = D): Promise<Observed> {
  const h = harness({
    'namecheap.domains.getList': 'getlist',
    'namecheap.domains.dns.getList': 'dns-getlist'
  })
  return (await namecheapAdapter.observe(h.ctx, 'namecheap.domain', name)) as Observed
}

describe('namecheap adapter: contract', () => {
  it('registers as a core provider with a valid spec, registrar domain, estimates', () => {
    expect(CORE_PROVIDERS).toContain(namecheapAdapter)
    registry.resetProvidersForTest?.()
    ensureCoreProviders()
    expect(registry.getProvider('namecheap')).toBe(namecheapAdapter)
    expect(spec('namecheap.domain').registrar).toBe(true)
    expect(spec('namecheap.domain').scope).toBe('shared')
    expect(missingEstimates([namecheapAdapter])).toEqual([])
    expect(namecheapAdapter.connection.hosts({ sandbox: true })).toEqual([
      'api.sandbox.namecheap.com'
    ])
    expect(namecheapAdapter.connection.hosts({})).toEqual(['api.namecheap.com'])
  })

  it('validates the connection form (IPv4 client address, user, key)', () => {
    const v = namecheapAdapter.connection.validate!
    expect(v({ api_user: 'hubtest', client_ip: IP }, { api_key: KEY })).toEqual([])
    expect(v({ api_user: 'hub test', client_ip: '::1' }, { api_key: '' }).length).toBe(3)
  })

  it('declares outputs and none leak into observed/desired', async () => {
    for (const t of namecheapAdapter.types) expect(t.outputs ?? []).toEqual([])
    const o = await observedDomain()
    expect(JSON.stringify(o)).not.toContain(KEY)
  })
})

describe('namecheap adapter: calls', () => {
  it('sends the API key in the POST body, never in the address', async () => {
    const h = harness({ 'namecheap.domains.getList': 'getlist' })
    await namecheapAdapter.observe(h.ctx, 'namecheap.domain', D)
    expect(h.calls[0].url).toBe('https://api.sandbox.namecheap.com/xml.response')
    expect(h.calls[0].url).not.toContain(KEY)
    expect(h.calls[0].params.get('ApiKey')).toBe(KEY)
    expect(h.calls[0].params.get('ClientIp')).toBe(IP)
    expect(h.calls[0].params.get('UserName')).toBe('hubtest')
  })

  it('testConnection lists missing permissions and shows the address Namecheap sees', async () => {
    const good = harness({
      'namecheap.users.getBalances': 'balances',
      'namecheap.domains.getList': 'getlist'
    })
    const t = await namecheapAdapter.testConnection(good.ctx)
    expect(t.ok).toBe(true)
    expect(t.identity).toContain('hubtest (sandbox)')
    expect(t.missing).toEqual([])
    const bad = harness({ 'namecheap.users.getBalances': 'error-ip' })
    const r = await namecheapAdapter.testConnection(bad.ctx)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['calls from 198.51.100.77'])
    expect(r.message).toContain('Invalid request IP: 198.51.100.77')
    expect(r.message).toContain('error 1011150')
    expect(r.message).toContain('the connection says 203.0.113.10')
    const auth = harness({ 'namecheap.users.getBalances': 'error-auth' })
    const a = await namecheapAdapter.testConnection(auth.ctx)
    expect(a.ok).toBe(false)
    expect(a.missing).toEqual(['API access for this user'])
  })

  it('maps 429 and "Too many requests" to retryable', async () => {
    const http = harness({ 'namecheap.domains.getList': { status: 429 } })
    await expect(namecheapAdapter.observe(http.ctx, 'namecheap.domain', D)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
    const xml = harness({ 'namecheap.domains.getList': 'error-rate' })
    await expect(namecheapAdapter.observe(xml.ctx, 'namecheap.domain', D)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
    const down = harness({ 'namecheap.domains.getList': { status: 503 } })
    await expect(namecheapAdapter.observe(down.ctx, 'namecheap.domain', D)).rejects.toMatchObject({
      retryable: true
    })
  })

  it('secrets never in errors', async () => {
    const h = harness({ 'namecheap.domains.getList': 'error-echo-key' })
    const err = await namecheapAdapter.observe(h.ctx, 'namecheap.domain', D).catch((e) => e)
    expect(err.code).toBe('PROVIDER_REJECTED')
    expect(String(err.message)).not.toContain(KEY)
    expect(String(err.message)).toContain('error 2050900')
  })

  it('refuses names that are not domains before any call', async () => {
    const h = harness({})
    await expect(
      namecheapAdapter.observe(h.ctx, 'namecheap.domain', '../evil')
    ).rejects.toMatchObject({ code: 'BAD_ID' })
    expect(h.calls).toEqual([])
  })
})

describe('namecheap.domain', () => {
  it('observe reads expiry, lock, auto-renew and nameservers; a foreign name is null', async () => {
    const o = await observedDomain()
    expect(o.fields).toMatchObject({
      name: D,
      auto_renew: true,
      transfer_lock: true,
      expires_at: '2027-03-15T00:00:00.000Z',
      nameservers: []
    })
    const other = await observedDomain('hub-test-other.net')
    expect(other.fields.nameservers).toEqual([
      'ns1.hub-test-dns.example',
      'ns2.hub-test-dns.example'
    ])
    const h = harness({ 'namecheap.domains.getList': 'getlist-empty' })
    expect(await namecheapAdapter.observe(h.ctx, 'namecheap.domain', 'not-mine.com')).toBeNull()
  })

  it('health answers expiresAt, autoRenew and locked for the domain watch', async () => {
    const h = harness({
      'namecheap.domains.getList': 'getlist',
      'namecheap.domains.dns.getList': 'dns-getlist'
    })
    const ok = await namecheapAdapter.health!(h.ctx, 'namecheap.domain', D)
    expect(ok.status).toBe('ok')
    expect(ok.details).toMatchObject({
      expiresAt: '2027-03-15T00:00:00.000Z',
      autoRenew: true,
      locked: true
    })
    const warn = await namecheapAdapter.health!(h.ctx, 'namecheap.domain', 'hub-test-other.net')
    expect(warn.status).toBe('warn')
    expect(warn.details).toMatchObject({ autoRenew: false, locked: false, daysLeft: 22 })
  })

  it('plan diff: registration is an admin-only, typed-confirm, costed create', () => {
    const d = desired('namecheap.domain', { name: 'hub-test-new.com', years: 2, contact: CONTACT })
    const [op] = namecheapAdapter.plan({} as ProviderContext, d, null)
    expect(op.kind).toBe('create')
    expect(op.data).toEqual({ $adminOnly: true, $confirm: 'register hub-test-new.com' })
    expect(riskOf(op, d)).toEqual(['cost'])
    expect(spec('namecheap.domain').costClass!(d)).toBe('yearly')
    expect(() =>
      namecheapAdapter.plan(
        {} as ProviderContext,
        desired('namecheap.domain', { name: 'x-y.com', contact: {} }),
        null
      )
    ).toThrow(/contact needs/)
  })

  it('risk flags: lock off is destructive, nameservers are downtime, renew is a cost', async () => {
    const o = await observedDomain()
    const unlock = desired('namecheap.domain', { name: D, transfer_lock: false }, {}, D)
    const [u] = namecheapAdapter.plan({} as ProviderContext, unlock, o)
    expect(u.kind).toBe('update')
    expect(riskOf(u, unlock)).toEqual(['destructive'])
    const ns = desired(
      'namecheap.domain',
      { name: D, nameservers: ['ns1.a-b.example', 'ns2.a-b.example'] },
      {},
      D
    )
    const [n] = namecheapAdapter.plan({} as ProviderContext, ns, o)
    expect(riskOf(n, ns)).toEqual(['downtime'])
    const renew = desired('namecheap.domain', { name: D, renew: true }, {}, D)
    const [r] = namecheapAdapter.plan({} as ProviderContext, renew, o)
    expect(r.action).toBe('renew')
    expect(r.data).toEqual({ $adminOnly: true, $confirm: `renew ${D}` })
    expect(riskOf(r, renew)).toEqual(['cost'])
    const same = desired('namecheap.domain', { name: D, transfer_lock: true }, {}, D)
    expect(namecheapAdapter.plan({} as ProviderContext, same, o)[0].kind).toBe('noop')
  })

  it('never registers a taken or premium name, nor one already in the account', async () => {
    const d = desired('namecheap.domain', { name: 'hub-test-new.com', contact: CONTACT })
    const [op] = namecheapAdapter.plan({} as ProviderContext, d, null)
    const taken = harness({
      'namecheap.domains.getList': 'getlist-empty',
      'namecheap.domains.check': 'check-taken'
    })
    await expect(namecheapAdapter.apply(taken.ctx, op, d)).rejects.toMatchObject({
      code: 'DOMAIN_UNAVAILABLE'
    })
    expect(taken.commands()).not.toContain('namecheap.domains.create')
    const premium = harness({
      'namecheap.domains.getList': 'getlist-empty',
      'namecheap.domains.check': 'check-premium'
    })
    await expect(namecheapAdapter.apply(premium.ctx, op, d)).rejects.toMatchObject({
      code: 'DOMAIN_PREMIUM'
    })
    expect(premium.commands()).not.toContain('namecheap.domains.create')
    const mine = harness({ 'namecheap.domains.getList': 'getlist-new' })
    await expect(namecheapAdapter.apply(mine.ctx, op, d)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })
    expect(mine.commands()).toEqual(['namecheap.domains.getList'])
  })

  it('registers an available name once, with the contact and WHOIS privacy', async () => {
    const d = desired('namecheap.domain', { name: 'hub-test-new.com', years: 1, contact: CONTACT })
    const [op] = namecheapAdapter.plan({} as ProviderContext, d, null)
    const h = harness({
      'namecheap.domains.getList': ['getlist-empty', 'getlist-new'],
      'namecheap.domains.check': 'check-available',
      'namecheap.domains.create': 'create'
    })
    const r = await namecheapAdapter.apply(h.ctx, op, d)
    expect(r.externalId).toBe('hub-test-new.com')
    const create = h.calls.find((c) => c.command === 'namecheap.domains.create')!
    expect(create.params.get('Years')).toBe('1')
    expect(create.params.get('RegistrantEmailAddress')).toBe('hub-test@example.com')
    expect(create.params.get('AuxBillingCountry')).toBe('US')
    expect(create.params.get('WGEnabled')).toBe('yes')
    expect(h.commands().filter((c) => c === 'namecheap.domains.create')).toHaveLength(1)
  })

  it('apply is idempotent: a lock already in place and a renewal already done are not sent again', async () => {
    const o = await observedDomain()
    const lock = desired('namecheap.domain', { name: D, transfer_lock: false }, {}, D)
    const [op] = namecheapAdapter.plan({} as ProviderContext, lock, o)
    const h = harness({
      'namecheap.domains.getList': 'getlist',
      'namecheap.domains.setRegistrarLock': 'set-lock'
    })
    await namecheapAdapter.apply(h.ctx, op, lock)
    expect(
      h.calls
        .find((c) => c.command === 'namecheap.domains.setRegistrarLock')!
        .params.get('LockAction')
    ).toBe('UNLOCK')
    // The second run reads the lock already off: nothing written.
    const again = harness({
      'namecheap.domains.getList': 'getlist',
      'namecheap.domains.dns.getList': 'dns-getlist'
    })
    const unlockedOp = { ...op, externalId: 'hub-test-other.net' }
    await namecheapAdapter.apply(again.ctx, unlockedOp, { ...lock, externalId: null })
    expect(again.commands()).not.toContain('namecheap.domains.setRegistrarLock')
    const renew = desired('namecheap.domain', { name: D, renew: true }, {}, D)
    const [r] = namecheapAdapter.plan({} as ProviderContext, renew, o)
    const done = harness({ 'namecheap.domains.getList': 'getlist-renewed' })
    await namecheapAdapter.apply(done.ctx, r, renew)
    expect(done.commands()).not.toContain('namecheap.domains.renew')
    const fresh = harness({
      'namecheap.domains.getList': ['getlist', 'getlist-renewed'],
      'namecheap.domains.renew': 'renew'
    })
    await namecheapAdapter.apply(fresh.ctx, r, renew)
    expect(fresh.commands().filter((c) => c === 'namecheap.domains.renew')).toHaveLength(1)
  })

  it('nameservers go through setCustom with SLD and TLD', async () => {
    const o = await observedDomain()
    const ns = desired(
      'namecheap.domain',
      { name: D, nameservers: ['ns2.a-b.example', 'ns1.a-b.example'] },
      {},
      D
    )
    const [op] = namecheapAdapter.plan({} as ProviderContext, ns, o)
    const h = harness({
      'namecheap.domains.getList': 'getlist',
      'namecheap.domains.dns.setCustom': 'set-custom'
    })
    await namecheapAdapter.apply(h.ctx, op, ns)
    const call = h.calls.find((c) => c.command === 'namecheap.domains.dns.setCustom')!
    expect(call.params.get('SLD')).toBe('hub-test-example')
    expect(call.params.get('TLD')).toBe('com')
    expect(call.params.get('Nameservers')).toBe('ns1.a-b.example,ns2.a-b.example')
  })

  it('estimate from recorded price answer', async () => {
    const d = desired('namecheap.domain', { name: 'hub-test-new.com', years: 2, contact: CONTACT })
    const h = harness({
      'namecheap.users.getPricing': ['pricing-renew-com', 'pricing-register-com']
    })
    const e = await spec('namecheap.domain').estimate!(h.ctx, d, null)
    expect(e.confidence).toBe('list_price')
    expect(e.oneTimeCents).toBe(1118 + 1718)
    expect(e.yearlyCents).toBe(1718)
    expect(e.monthlyCents).toBe(0)
    expect(e.note).toContain('this account')
    // No price API answer: the dated table, saying so.
    const none = harness({})
    const b = await spec('namecheap.domain').estimate!(none.ctx, null, await observedDomain())
    expect(b.yearlyCents).toBe(1898)
    expect(b.priceAsOf).toBe('2026-11-27')
    const odd = await spec('namecheap.domain').estimate!(
      none.ctx,
      desired('namecheap.domain', { name: 'x.zz-unknown' }),
      null
    )
    expect(odd.confidence).toBe('unknown')
  })
})

describe('namecheap.dns_record', () => {
  const refs = { domain: D }
  it('observe finds a record by host, type and value; a gone one is null', async () => {
    const h = harness({ 'namecheap.domains.dns.getHosts': 'gethosts' })
    const id = recordId(D, { host: '@', type: 'A', address: '192.0.2.10' })
    const o = await namecheapAdapter.observe(h.ctx, 'namecheap.dns_record', id)
    expect(o?.fields).toMatchObject({
      domain: D,
      host: '@',
      type: 'A',
      address: '192.0.2.10',
      ttl: 1800
    })
    const gone = recordId(D, { host: '@', type: 'A', address: '192.0.2.99' })
    expect(await namecheapAdapter.observe(h.ctx, 'namecheap.dns_record', gone)).toBeNull()
    await expect(
      namecheapAdapter.observe(h.ctx, 'namecheap.dns_record', 'bad')
    ).rejects.toMatchObject({
      code: 'BAD_EXTERNAL_ID'
    })
  })

  it('create keeps every other record and the mail setting; an identical record is ALREADY_EXISTS', async () => {
    const d = desired(
      'namecheap.dns_record',
      { host: 'api', type: 'A', address: '192.0.2.20' },
      refs
    )
    const [op] = namecheapAdapter.plan({} as ProviderContext, d, null)
    expect(op.kind).toBe('create')
    const h = harness({
      'namecheap.domains.dns.getHosts': 'gethosts',
      'namecheap.domains.dns.setHosts': 'sethosts'
    })
    const r = await namecheapAdapter.apply(h.ctx, op, d)
    expect(r.externalId).toBe(recordId(D, { host: 'api', type: 'A', address: '192.0.2.20' }))
    const set = h.calls.find((c) => c.command === 'namecheap.domains.dns.setHosts')!
    expect(set.params.get('HostName1')).toBe('@')
    expect(set.params.get('HostName2')).toBe('www')
    expect(set.params.get('HostName3')).toBe('api')
    expect(set.params.get('EmailType')).toBe('FWD')
    const dup = desired(
      'namecheap.dns_record',
      { host: '@', type: 'A', address: '192.0.2.10' },
      refs
    )
    const [dop] = namecheapAdapter.plan({} as ProviderContext, dup, null)
    const h2 = harness({ 'namecheap.domains.dns.getHosts': 'gethosts' })
    await expect(namecheapAdapter.apply(h2.ctx, dop, dup)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })
    expect(h2.commands()).not.toContain('namecheap.domains.dns.setHosts')
  })

  it('refuses a domain on other nameservers and MX records', async () => {
    const d = desired(
      'namecheap.dns_record',
      { host: 'api', type: 'A', address: '192.0.2.20' },
      { domain: 'hub-test-other.net' }
    )
    const [op] = namecheapAdapter.plan({} as ProviderContext, d, null)
    const h = harness({ 'namecheap.domains.dns.getHosts': 'gethosts-other-dns' })
    await expect(namecheapAdapter.apply(h.ctx, op, d)).rejects.toMatchObject({
      code: 'NOT_NAMECHEAP_DNS'
    })
    expect(() =>
      namecheapAdapter.plan(
        {} as ProviderContext,
        desired('namecheap.dns_record', { type: 'MX', address: 'mx.a.example' }, refs),
        null
      )
    ).toThrow(/record type/)
  })

  it('risk flags per op and an update that answers the new id', async () => {
    const h = harness({
      'namecheap.domains.dns.getHosts': 'gethosts',
      'namecheap.domains.dns.setHosts': 'sethosts'
    })
    const id = recordId(D, { host: '@', type: 'A', address: '192.0.2.10' })
    const o = (await namecheapAdapter.observe(h.ctx, 'namecheap.dns_record', id)) as Observed
    const moved = desired(
      'namecheap.dns_record',
      { host: '@', type: 'A', address: '192.0.2.11' },
      refs,
      id
    )
    const [u] = namecheapAdapter.plan({} as ProviderContext, moved, o)
    expect(u.kind).toBe('update')
    expect(riskOf(u, moved)).toEqual(['downtime'])
    const r = await namecheapAdapter.apply(h.ctx, u, moved)
    expect(r.externalId).toBe(recordId(D, { host: '@', type: 'A', address: '192.0.2.11' }))
    const [del] = namecheapAdapter.plan({} as ProviderContext, null, o)
    expect(riskOf(del, null)).toEqual(['destructive'])
    const rename = desired(
      'namecheap.dns_record',
      { host: 'app', type: 'A', address: '192.0.2.10' },
      refs,
      id
    )
    const [rep] = namecheapAdapter.plan({} as ProviderContext, rename, o)
    expect(rep.kind).toBe('replace')
    expect(riskOf(rep, rename).sort()).toEqual(['destructive', 'downtime'])
  })

  it('delete is idempotent: a record already gone writes nothing', async () => {
    const h = harness({ 'namecheap.domains.dns.getHosts': 'gethosts' })
    const gone = recordId(D, { host: 'old', type: 'TXT', address: 'x' })
    await namecheapAdapter.apply(
      h.ctx,
      {
        kind: 'delete',
        type: 'namecheap.dns_record',
        resourceId: 51,
        externalId: gone,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      null
    )
    expect(h.commands()).toEqual(['namecheap.domains.dns.getHosts'])
  })
})
