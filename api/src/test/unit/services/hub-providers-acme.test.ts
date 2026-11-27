import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 38: the ACME (Let's Encrypt) adapter against a FAKE CA and fake Cloudflare /
// Route 53 APIs (hub-providers-acme-fake.ts). No real ACME server, DNS API or key is ever used.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))
vi.mock('../../../services/hub/providers/store.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readConnection: vi.fn(),
  openConnectionSecrets: vi.fn()
}))

const { makeProviderContext, forgetConnectionTokens } = await import(
  '../../../services/hub/providers/context.js'
)
const { ensureCoreProviders, CORE_PROVIDERS } = await import(
  '../../../services/hub/providers/index.js'
)
const { configureResourceEngine, resetResourceEngineForTest } = await import(
  '../../../services/hub/providers/engine/deps.js'
)
const store = await import('../../../services/hub/providers/store.js')
const { acmeAdapter } = await import('../../../services/hub/providers/acme/index.js')
const client = await import('../../../services/hub/providers/acme/client.js')
const { parseNames } = await import('../../../services/hub/providers/acme/names.js')
const fake = await import('./hub-providers-acme-fake.js')

import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ROTATE_OUTPUTS_FIELD
} from '../../../services/hub/providers/types.js'

const ACCOUNT_KEY = client.generateAccountKeyPem()
const T_ACCOUNT = 'acme.account'
const T_CERT = 'acme.certificate'
const NOW_MID = new Date('2026-12-01T12:00:00Z') // ~60 days left on the fixture certificate
const NOW_DUE = new Date('2027-01-10T12:00:00Z') // 19 days left: renewal due
const NOW_FRESH = new Date('2026-11-01T00:20:00Z') // 20 minutes after it was issued
const ACCT_ID = (host = fake.CA_STAGING) => client.encodeUrlId(`https://${host}/acme/acct/7`)
const CERT_ID = (host = fake.CA_STAGING, id = 'fake-cert-1') =>
  client.encodeUrlId(`https://${host}/acme/cert/${id}`)

const baseConfig = (over: Record<string, unknown> = {}) => ({
  directory: 'letsencrypt_staging',
  contact_email: 'ops@example.test',
  dns_connection_id: 20,
  dns_wait_seconds: 0,
  ...over
})

function ctxFor(
  world: ReturnType<typeof fake.makeWorld>,
  over: Record<string, unknown> = {},
  now = NOW_MID
) {
  return makeProviderContext({
    adapter: acmeAdapter,
    connectionId: 1,
    config: baseConfig(over),
    secrets: { account_key: ACCOUNT_KEY },
    now: () => now,
    fetch: { fetchImpl: world.fetchImpl as any, timeoutMs: 2000 }
  })
}

const connRows: Record<number, any> = {
  20: {
    id: 20,
    provider: 'cloudflare',
    name: 'cf',
    config: { accountId: fake.CF_ACCOUNT },
    status: 'ok'
  },
  21: {
    id: 21,
    provider: 'aws',
    name: 'aws',
    config: { access_key_id: 'AKIAFAKEFAKEFAKE0001', regions: ['us-east-1'] },
    status: 'ok'
  },
  22: { id: 22, provider: 'github', name: 'gh', config: {}, status: 'ok' }
}
const connSecrets: Record<number, Record<string, string>> = {
  20: { apiToken: 'test-secret-cloudflare-token-0001' },
  21: { secret_access_key: 'test-secret-aws-secret-key-0001' },
  22: {}
}

let world: ReturnType<typeof fake.makeWorld>

function useWorld(opts: Parameters<typeof fake.makeWorld>[0] = {}) {
  world = fake.makeWorld(opts)
  configureResourceEngine({ fetch: { fetchImpl: world.fetchImpl as any, timeoutMs: 2000 } })
  return world
}

beforeEach(() => {
  forgetConnectionTokens(1)
  ensureCoreProviders()
  vi.mocked(store.readConnection).mockImplementation(async (id: number) => connRows[id] ?? null)
  vi.mocked(store.openConnectionSecrets).mockImplementation(
    async (row: { id: number }) => connSecrets[row.id] ?? {}
  )
  useWorld({ account: true })
})
afterEach(() => {
  resetResourceEngineForTest()
})

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
    scope: type === T_ACCOUNT ? 'shared' : 'app',
    appId: type === T_ACCOUNT ? null : 1,
    environmentId: type === T_ACCOUNT ? null : 2,
    fields,
    refs,
    tags: {}
  }
}
const certDesired = (
  over: Record<string, unknown> = {},
  externalId: string | null = null,
  zone = fake.CF_ZONE
) =>
  desired(
    T_CERT,
    {
      name: 'www-prod',
      names: ['app.example.test', 'www.example.test'],
      zone,
      key_type: 'ec256',
      ...over
    },
    externalId,
    { account: ACCT_ID() }
  )
const op = (type: string, over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'create',
  type,
  resourceId: 7,
  externalId: null,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})
const spec = (key: string) => acmeAdapter.types.find((t) => t.key === key)!

const certObs = (over: Record<string, unknown> = {}): Observed => ({
  type: T_CERT,
  externalId: CERT_ID(),
  name: 'app.example.test',
  fields: {
    names: ['app.example.test', 'www.example.test'],
    key_type: 'ec256',
    serial: 'abc',
    not_before: '2026-11-01T00:00:00.000Z',
    not_after: '2027-01-30T00:00:00.000Z',
    ...over
  },
  tags: {}
})
const acctObs = (over: Record<string, unknown> = {}): Observed => ({
  type: T_ACCOUNT,
  externalId: ACCT_ID(),
  name: 'ops@example.test',
  fields: {
    contact_email: 'ops@example.test',
    status: 'valid',
    directory: 'letsencrypt_staging',
    ...over
  },
  tags: {}
})

const calledAcme = () => world.calls.filter((c) => c.host === fake.CA_STAGING)

// ═══ Connection ═══

describe('acme connection', () => {
  it('registers as a core provider and defaults to Let’s Encrypt STAGING', () => {
    expect(CORE_PROVIDERS.some((a) => a.key === 'acme')).toBe(true)
    expect(client.directoryChoice({})).toBe('letsencrypt_staging')
    expect(client.directoryUrl({})).toContain('acme-staging-v02')
    expect(acmeAdapter.connection.hosts({})).toEqual([fake.CA_STAGING])
    expect(acmeAdapter.connection.hosts({ directory: 'letsencrypt_production' })).toEqual([
      'acme-v02.api.letsencrypt.org'
    ])
    expect(
      acmeAdapter.connection.hosts({
        directory: 'custom',
        directory_url: 'https://acme.example.test/dir'
      })
    ).toEqual(['acme.example.test'])
    expect(acmeAdapter.connection.describe(baseConfig())).toContain('staging')
  })

  it('validates the form without echoing the key', () => {
    const v = acmeAdapter.connection.validate!
    expect(v(baseConfig(), { account_key: ACCOUNT_KEY })).toEqual([])
    const bad = v(
      { directory: 'custom', directory_url: 'http://acme.example.test', contact_email: 'nope' },
      { account_key: 'not a key test-secret-xyz' }
    )
    expect(bad.join(' ')).toMatch(/https/)
    expect(bad.join(' ')).toMatch(/contact email/i)
    expect(bad.join(' ')).toMatch(/DNS zones/)
    expect(bad.join(' ')).toMatch(/PEM private key/)
    expect(bad.join(' ')).not.toContain('test-secret-xyz')
    expect(v(baseConfig({ allowed_domains: ['not a domain'] }), {}).join(' ')).toMatch(
      /domain name/
    )
    expect(v(baseConfig({ dns_wait_seconds: 9999 }), {}).join(' ')).toMatch(/0 to/)
  })

  it('testConnection lists what is missing and never shows the key', async () => {
    useWorld({ account: false })
    const t = await acmeAdapter.testConnection(ctxFor(world))
    expect(t.ok).toBe(true)
    expect(t.missing.join(' ')).toMatch(/ACME account/)
    expect(t.message).toMatch(/STAGING/)
    expect(JSON.stringify(t)).not.toContain('PRIVATE KEY')
    useWorld({ account: true })
    const ok = await acmeAdapter.testConnection(ctxFor(world))
    expect(ok.missing).toEqual([])
    expect(ok.identity).toContain('Cloudflare')
  })

  it('testConnection reports an unusable key and a missing DNS connection', async () => {
    const ctx = makeProviderContext({
      adapter: acmeAdapter,
      connectionId: 1,
      config: baseConfig({ dns_connection_id: 22 }),
      secrets: { account_key: 'garbage' },
      fetch: { fetchImpl: world.fetchImpl as any }
    })
    const t = await acmeAdapter.testConnection(ctx)
    expect(t.ok).toBe(false)
    expect(t.missing.join(' ')).toMatch(/account key/)
    expect(t.missing.join(' ')).toMatch(/DNS-01/)
  })
})

// ═══ Account ═══

describe('acme.account', () => {
  it('observes the account of the key, and null for another id or no account', async () => {
    const seen = await acmeAdapter.observe(ctxFor(world), T_ACCOUNT, ACCT_ID())
    expect(seen?.fields).toMatchObject({ contact_email: 'ops@example.test', status: 'valid' })
    expect(
      await acmeAdapter.observe(
        ctxFor(world),
        T_ACCOUNT,
        client.encodeUrlId(`https://${fake.CA_STAGING}/acme/acct/99`)
      )
    ).toBeNull()
    useWorld({ account: false })
    expect(await acmeAdapter.observe(ctxFor(world), T_ACCOUNT, ACCT_ID())).toBeNull()
  })

  it('refuses ids that are not URLs on this CA', async () => {
    await expect(acmeAdapter.observe(ctxFor(world), T_ACCOUNT, 'x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(
      acmeAdapter.observe(ctxFor(world), T_ACCOUNT, client.encodeUrlId('http://evil.test/acct/1'))
    ).rejects.toMatchObject({ code: 'BAD_ID' })
    await expect(
      acmeAdapter.observe(ctxFor(world), T_ACCOUNT, ACCT_ID('acme-v02.api.letsencrypt.org'))
    ).rejects.toMatchObject({ code: 'ACME_DIRECTORY_CHANGED' })
  })

  it('plan: terms are required, create reads in plain words, contact change, delete is typed-confirm', () => {
    const ctx = ctxFor(world)
    expect(() => acmeAdapter.plan(ctx, desired(T_ACCOUNT, { name: 'a' }), null)).toThrow(/terms/)
    const [create] = acmeAdapter.plan(
      ctx,
      desired(T_ACCOUNT, { name: 'a', terms_agreed: true }),
      null
    )
    expect(create.kind).toBe('create')
    expect(create.reason).toMatch(/STAGING/)
    expect(create.reason).not.toMatch(/acme\.account/)
    const [upd] = acmeAdapter.plan(
      ctx,
      desired(T_ACCOUNT, { name: 'a', contact_email: 'new@example.test' }),
      acctObs()
    )
    expect(upd.changes).toEqual([
      { field: 'contact_email', from: 'ops@example.test', to: 'new@example.test' }
    ])
    expect(acmeAdapter.plan(ctx, desired(T_ACCOUNT, { name: 'a' }), acctObs())).toEqual([])
    const [del] = acmeAdapter.plan(ctx, null, acctObs())
    expect(spec(T_ACCOUNT).risk(del, null)).toEqual(['destructive', 'data_loss'])
    expect(spec(T_ACCOUNT).scope).toBe('shared')
  })

  it('apply create makes the account; an existing one is ALREADY_EXISTS unless the run is resumed', async () => {
    useWorld({ account: false })
    const made = await acmeAdapter.apply(
      ctxFor(world),
      op(T_ACCOUNT, { kind: 'create' }),
      desired(T_ACCOUNT, { name: 'a', terms_agreed: true })
    )
    expect(made.externalId).toBe(ACCT_ID())
    expect(world.state.account?.contact).toEqual(['mailto:ops@example.test'])
    // Now it exists: a create (no recorded id) must not bind it.
    await expect(
      acmeAdapter.apply(
        ctxFor(world),
        op(T_ACCOUNT, { kind: 'create' }),
        desired(T_ACCOUNT, { name: 'a', terms_agreed: true })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    // A resumed run (id recorded on the row) carries on.
    const again = await acmeAdapter.apply(
      ctxFor(world),
      op(T_ACCOUNT, { kind: 'create' }),
      desired(T_ACCOUNT, { name: 'a', terms_agreed: true }, ACCT_ID())
    )
    expect(again.ok).toBe(true)
    // findExisting sees it too, so plan can say "adopt".
    expect(
      (await acmeAdapter.findExisting!(ctxFor(world), T_ACCOUNT, desired(T_ACCOUNT, {})))
        ?.externalId
    ).toBe(ACCT_ID())
  })

  it('apply create without agreeing to the terms sends nothing', async () => {
    useWorld({ account: false })
    await expect(
      acmeAdapter.apply(
        ctxFor(world),
        op(T_ACCOUNT, {}),
        desired(T_ACCOUNT, { name: 'a', terms_agreed: false })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    expect(calledAcme().filter((c) => c.method === 'POST')).toEqual([])
  })

  it('apply update changes the contact; delete deactivates; a foreign target is refused', async () => {
    const upd = await acmeAdapter.apply(
      ctxFor(world),
      op(T_ACCOUNT, { kind: 'update', externalId: ACCT_ID() }),
      desired(T_ACCOUNT, { name: 'a', contact_email: 'new@example.test' }, ACCT_ID())
    )
    expect(upd.observed?.fields.contact_email).toBe('new@example.test')
    // idempotent
    const same = await acmeAdapter.apply(
      ctxFor(world),
      op(T_ACCOUNT, { kind: 'update', externalId: ACCT_ID() }),
      desired(T_ACCOUNT, { name: 'a', contact_email: 'new@example.test' }, ACCT_ID())
    )
    expect(same.answer).toMatchObject({ already: 'matches' })
    await expect(
      acmeAdapter.apply(
        ctxFor(world),
        op(T_ACCOUNT, { kind: 'update', externalId: ACCT_ID() }),
        desired(
          T_ACCOUNT,
          { name: 'a' },
          client.encodeUrlId(`https://${fake.CA_STAGING}/acme/acct/8`)
        )
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    const del = await acmeAdapter.apply(
      ctxFor(world),
      op(T_ACCOUNT, { kind: 'delete', externalId: ACCT_ID() }),
      null
    )
    expect(del.answer).toMatchObject({ deactivated: true })
    expect(world.state.deactivated).toEqual([7])
  })

  it('lists the account of the key; certificates have no listing', async () => {
    expect((await acmeAdapter.list(ctxFor(world), T_ACCOUNT)).items).toHaveLength(1)
    expect((await acmeAdapter.list(ctxFor(world), T_CERT)).items).toEqual([])
    const health = await acmeAdapter.health!(ctxFor(world), T_ACCOUNT, ACCT_ID())
    expect(health.status).toBe('ok')
  })
})

// ═══ Certificate: planning ═══

describe('acme.certificate plan', () => {
  it('create: plain words, staging note, wildcard is public_exposure', () => {
    const ctx = ctxFor(world)
    const [create] = acmeAdapter.plan(ctx, certDesired(), null)
    expect(create.kind).toBe('create')
    expect(create.reason).toMatch(/DNS|TXT/)
    expect(create.reason).toMatch(/STAGING/)
    expect(create.reason).not.toMatch(/acme\.certificate|names_|key_type/)
    expect(spec(T_CERT).risk(create, certDesired())).toEqual([])
    const [wild] = acmeAdapter.plan(ctx, certDesired({ names: ['*.example.test'] }), null)
    expect(spec(T_CERT).risk(wild, certDesired())).toEqual(['public_exposure'])
    const prod = ctxFor(world, { directory: 'letsencrypt_production' })
    expect(acmeAdapter.plan(prod, certDesired(), null)[0].reason).not.toMatch(/STAGING/)
  })

  it('create refuses bad names and a missing zone before any call', () => {
    const ctx = ctxFor(world)
    expect(() => acmeAdapter.plan(ctx, certDesired({ names: ['bad name'] }), null)).toThrow(
      /valid certificate name/
    )
    expect(() => acmeAdapter.plan(ctx, certDesired({ names: [] }), null)).toThrow(
      /at least one name/
    )
    expect(() => acmeAdapter.plan(ctx, certDesired({ zone: '' }), null)).toThrow(/zone/)
    expect(() => parseNames(['*.*.example.test'])).toThrow()
    expect(() => parseNames(['1.2.3.4'])).toThrow()
    expect(world.calls).toEqual([])
  })

  it('renews 30 days before expiry, as a normal change; nothing earlier', () => {
    expect(acmeAdapter.plan(ctxFor(world, {}, NOW_MID), certDesired(), certObs())).toEqual([])
    const [renew] = acmeAdapter.plan(ctxFor(world, {}, NOW_DUE), certDesired(), certObs())
    expect(renew).toMatchObject({ kind: 'update', action: 'renew', changes: [] })
    expect(renew.reason).toMatch(/19 day/)
    expect(spec(T_CERT).risk(renew, certDesired())).toEqual([])
    expect(spec(T_CERT).costClass).toBeUndefined()
    const expired = acmeAdapter.plan(
      ctxFor(world, {}, new Date('2027-02-05T00:00:00Z')),
      certDesired(),
      certObs()
    )
    expect(expired[0].reason).toMatch(/expired/)
  })

  it('a changed name list or key type orders a new certificate; a NEW wildcard is flagged, a renewal never', () => {
    const ctx = ctxFor(world)
    const [more] = acmeAdapter.plan(
      ctx,
      certDesired({ names: ['app.example.test', 'www.example.test', 'api.example.test'] }),
      certObs()
    )
    expect(more.action).toBe('reissue')
    expect(spec(T_CERT).risk(more, certDesired())).toEqual([])
    const [wild] = acmeAdapter.plan(
      ctx,
      certDesired({ names: ['app.example.test', 'www.example.test', '*.example.test'] }),
      certObs()
    )
    expect(spec(T_CERT).risk(wild, certDesired())).toEqual(['public_exposure'])
    const [key] = acmeAdapter.plan(ctx, certDesired({ key_type: 'ec384' }), certObs())
    expect(key.changes[0]).toMatchObject({ field: 'key_type', from: 'ec256', to: 'ec384' })
    // order of names does not matter
    expect(
      acmeAdapter.plan(
        ctx,
        certDesired({ names: ['WWW.example.test', 'app.example.test'] }),
        certObs()
      )
    ).toEqual([])
    // an already-approved wildcard renews without the flag
    const wildObs = certObs({ names: ['*.example.test'] })
    const [renew] = acmeAdapter.plan(
      ctxFor(world, {}, NOW_DUE),
      certDesired({ names: ['*.example.test'] }),
      wildObs
    )
    expect(spec(T_CERT).risk(renew, certDesired())).toEqual([])
  })

  it('rotate_outputs plans a rotate op and clears nothing else; delete is a quiet forget', () => {
    const ctx = ctxFor(world)
    const [rot] = acmeAdapter.plan(ctx, certDesired({ [ROTATE_OUTPUTS_FIELD]: true }), certObs())
    expect(rot.action).toBe('rotate')
    expect(spec(T_CERT).risk(rot, certDesired())).toEqual([])
    const [re] = acmeAdapter.plan(
      ctx,
      certDesired({ [ROTATE_OUTPUTS_FIELD]: true, key_type: 'rsa2048' }),
      certObs()
    )
    expect(re.action).toBe('reissue')
    expect(re.data?.$oneShot).toEqual([ROTATE_OUTPUTS_FIELD])
    const [del] = acmeAdapter.plan(ctx, null, certObs())
    expect(del.kind).toBe('delete')
    expect(del.reason).toMatch(/not asked to revoke/)
    expect(spec(T_CERT).risk(del, null)).toEqual([])
  })

  it('declares outputs, the account ref, and a trigger for the once-only key', () => {
    const t = spec(T_CERT)
    expect(t.outputs).toEqual([
      { key: 'fullchain', label: expect.any(String), secret: false },
      { key: 'private_key', label: expect.any(String), secret: true, onceOnly: true }
    ])
    expect(t.refs).toEqual([{ field: 'account', type: T_ACCOUNT }])
    expect(t.fields.find((f) => f.key === ROTATE_OUTPUTS_FIELD)?.trigger).toBe(true)
    expect(t.scope).toBe('app')
  })
})

// ═══ Certificate: apply ═══

describe('acme.certificate apply', () => {
  it('issues through Cloudflare DNS-01: proof TXT made, challenge valid, TXT removed, key only in outputs', async () => {
    const ctx = ctxFor(world)
    const res = await acmeAdapter.apply(ctx, op(T_CERT, {}), certDesired())
    expect(res.ok).toBe(true)
    // The CA ordered both names and every challenge was proven with the right TXT value.
    expect(world.state.orders[0].identifiers.map((i) => i.value)).toEqual([
      'app.example.test',
      'www.example.test'
    ])
    expect(world.state.deniedChallenges).toBe(0)
    expect(world.state.authzs.every((a) => a.status === 'valid')).toBe(true)
    // The TXT records were made in the zone, marked with the resource, and removed afterwards.
    const posts = world.calls.filter((c) => c.host === 'api.cloudflare.com' && c.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0].body).toMatchObject({ type: 'TXT', name: '_acme-challenge.app.example.test' })
    expect(posts[0].body.comment).toMatch(/nivaro-hub:resource=7$/)
    expect(world.cfRecords).toEqual([])
    // Outputs: chain + key. The key is a PEM private key; nothing else carries it.
    expect(res.outputs?.private_key).toMatch(/BEGIN (EC )?PRIVATE KEY/)
    expect(res.outputs?.fullchain).toContain('BEGIN CERTIFICATE')
    const rest = JSON.stringify({ observed: res.observed, answer: res.answer, ext: res.externalId })
    expect(rest).not.toContain('PRIVATE KEY')
    expect(rest).not.toContain(ACCOUNT_KEY.split('\n')[1])
    expect(res.observed?.fields).toMatchObject({
      names: ['app.example.test', 'www.example.test'],
      key_type: 'ec256',
      not_after: '2027-01-30T00:00:00.000Z'
    })
    expect(res.externalId).toBe(CERT_ID(fake.CA_STAGING, `fake-cert-${world.state.orders[0].id}`))
  })

  it('a wildcard and its apex share one TXT name: two records, both removed', async () => {
    useWorld({ account: true, chain: fake.CHAIN_WILDCARD })
    const res = await acmeAdapter.apply(
      ctxFor(world),
      op(T_CERT, {}),
      certDesired({ names: ['example.test', '*.example.test'] })
    )
    expect(res.ok).toBe(true)
    const posts = world.calls.filter((c) => c.host === 'api.cloudflare.com' && c.method === 'POST')
    expect(posts.map((p) => p.body.name)).toEqual([
      '_acme-challenge.example.test',
      '_acme-challenge.example.test'
    ])
    expect(new Set(posts.map((p) => p.body.content)).size).toBe(2)
    expect(world.cfRecords).toEqual([])
  })

  it('issues through Route 53: TXT merged, waits for INSYNC, removed; foreign TXT values are kept', async () => {
    connRows[20] = { ...connRows[20] }
    const ctx = ctxFor(world, { dns_connection_id: 21 })
    world.r53Sets.set('_acme-challenge.app.example.test', {
      ttl: 300,
      values: ['"someone-elses-value"']
    })
    world.txt.set('_acme-challenge.app.example.test', ['"someone-elses-value"'])
    const res = await acmeAdapter.apply(ctx, op(T_CERT, {}), certDesired({}, null, fake.R53_ZONE))
    expect(res.ok).toBe(true)
    expect(world.state.authzs.every((a) => a.status === 'valid')).toBe(true)
    expect(world.calls.some((c) => c.path.startsWith('/2013-04-01/change/'))).toBe(true)
    // The other value survived; ours is gone; the set we created alone is deleted.
    expect(world.r53Sets.get('_acme-challenge.app.example.test')?.values).toEqual([
      '"someone-elses-value"'
    ])
    expect(world.r53Sets.has('_acme-challenge.www.example.test')).toBe(false)
    expect(world.r53Changes.filter((c) => c.startsWith('DELETE'))).toHaveLength(1)
  })

  it('refuses a private Route 53 zone and a Cloudflare zone of another account', async () => {
    useWorld({ account: true, r53Private: true })
    await expect(
      acmeAdapter.apply(
        ctxFor(world, { dns_connection_id: 21 }),
        op(T_CERT, {}),
        certDesired({}, null, fake.R53_ZONE)
      )
    ).rejects.toMatchObject({ code: 'ACME_ZONE_PRIVATE' })
    useWorld({ account: true, cfForeignZone: true })
    await expect(
      acmeAdapter.apply(ctxFor(world), op(T_CERT, {}), certDesired())
    ).rejects.toMatchObject({ code: 'ACME_DNS_FAILED', message: expect.stringMatching(/account/) })
    expect(world.state.orders).toEqual([])
  })

  it('names outside the zone or the allowed domains are refused before an order is made', async () => {
    await expect(
      acmeAdapter.apply(ctxFor(world), op(T_CERT, {}), certDesired({ names: ['app.other.test'] }))
    ).rejects.toMatchObject({ code: 'NAME_OUTSIDE_ZONE' })
    await expect(
      acmeAdapter.apply(
        ctxFor(world, { allowed_domains: ['corp.example.test'] }),
        op(T_CERT, {}),
        certDesired()
      )
    ).rejects.toMatchObject({ code: 'NAME_NOT_ALLOWED' })
    expect(world.state.orders).toEqual([])
  })

  it('a failed challenge removes the TXT records and leaves nothing behind', async () => {
    world.state.breakProof = true
    await expect(
      acmeAdapter.apply(ctxFor(world), op(T_CERT, {}), certDesired())
    ).rejects.toBeInstanceOf(Error)
    expect(world.cfRecords).toEqual([])
    expect(world.state.deniedChallenges).toBeGreaterThan(0)
  }, 30_000)

  it('429 from the CA is retryable and says how long to wait', async () => {
    useWorld({ account: true, rateLimitSeconds: 3600 })
    const err: any = await acmeAdapter
      .apply(ctxFor(world), op(T_CERT, {}), certDesired())
      .catch((e) => e)
    expect(err.code).toBe('ACME_RATE_LIMITED')
    expect(err.retryable).toBe(true)
    expect(err.message).toMatch(/60 minute/)
    expect(world.cfRecords).toEqual([])
  })

  it('a CA that echoes the account key in its answer cannot leak it', async () => {
    world.state.echo = ACCOUNT_KEY
    const err: any = await acmeAdapter
      .apply(ctxFor(world), op(T_CERT, {}), certDesired())
      .catch((e) => e)
    expect(err.message).not.toContain('BEGIN PRIVATE KEY')
    expect(err.message).not.toContain(ACCOUNT_KEY.split('\n')[1])
  })

  it('renew makes a new certificate with a fresh key; a recent order waits an hour (retryable)', async () => {
    useWorld({ account: true, chain: fake.CHAIN_PLAIN })
    const first = await acmeAdapter.apply(ctxFor(world, {}, NOW_DUE), op(T_CERT, {}), certDesired())
    const renew = op(T_CERT, { kind: 'update', action: 'renew', externalId: CERT_ID() })
    const second = await acmeAdapter.apply(
      ctxFor(world, {}, NOW_DUE),
      renew,
      certDesired({}, CERT_ID())
    )
    expect(second.ok).toBe(true)
    expect(second.answer).toMatchObject({ previous_kept_until_expiry: true })
    expect(second.outputs?.private_key).not.toBe(first.outputs?.private_key)
    const tooSoon: any = await acmeAdapter
      .apply(ctxFor(world, {}, NOW_FRESH), renew, certDesired({}, CERT_ID()))
      .catch((e) => e)
    expect(tooSoon.code).toBe('ACME_ORDER_TOO_SOON')
    expect(tooSoon.retryable).toBe(true)
    expect(tooSoon.message).toMatch(/once an hour/)
  })

  it('a named step for another certificate is refused', async () => {
    await expect(
      acmeAdapter.apply(
        ctxFor(world),
        op(T_CERT, { kind: 'update', action: 'renew', externalId: CERT_ID() }),
        certDesired({}, CERT_ID(fake.CA_STAGING, 'other'))
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('delete forgets the certificate without asking the CA to revoke it', async () => {
    const res = await acmeAdapter.apply(
      ctxFor(world),
      op(T_CERT, { kind: 'delete', externalId: CERT_ID() }),
      null
    )
    expect(res.answer).toMatchObject({ released: true, revoked: false })
    expect(world.calls).toEqual([])
  })

  it('needs the connection’s DNS connection to be Cloudflare or Route 53', async () => {
    await expect(
      acmeAdapter.apply(ctxFor(world, { dns_connection_id: 22 }), op(T_CERT, {}), certDesired())
    ).rejects.toMatchObject({ code: 'ACME_DNS_CONNECTION' })
    await expect(
      acmeAdapter.apply(ctxFor(world, { dns_connection_id: 999 }), op(T_CERT, {}), certDesired())
    ).rejects.toMatchObject({ code: 'ACME_DNS_CONNECTION' })
  })
})

// ═══ Certificate: reading ═══

describe('acme.certificate read', () => {
  it('observes the issued certificate from the CA', async () => {
    const seen = await acmeAdapter.observe(ctxFor(world), T_CERT, CERT_ID())
    expect(seen).toMatchObject({
      name: 'app.example.test',
      status: 'issued',
      fields: {
        names: ['app.example.test', 'www.example.test'],
        key_type: 'ec256',
        not_before: '2026-11-01T00:00:00.000Z',
        not_after: '2027-01-30T00:00:00.000Z'
      }
    })
    expect(
      await acmeAdapter.observe(ctxFor(world), T_CERT, CERT_ID(fake.CA_STAGING, 'gone'))
    ).toBeNull()
  })

  it('refuses a certificate id of another CA and a malformed id', async () => {
    await expect(
      acmeAdapter.observe(ctxFor(world), T_CERT, CERT_ID('acme-v02.api.letsencrypt.org'))
    ).rejects.toMatchObject({ code: 'ACME_DIRECTORY_CHANGED' })
    await expect(acmeAdapter.observe(ctxFor(world), T_CERT, '../x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
  })

  it('readOutputs gives the chain and never the key; health follows expiry', async () => {
    const outs = await acmeAdapter.readOutputs!(ctxFor(world), T_CERT, CERT_ID())
    expect(Object.keys(outs)).toEqual(['fullchain'])
    expect(outs.fullchain).toContain('BEGIN CERTIFICATE')
    expect((await acmeAdapter.health!(ctxFor(world, {}, NOW_MID), T_CERT, CERT_ID())).status).toBe(
      'ok'
    )
    const warn = await acmeAdapter.health!(ctxFor(world, {}, NOW_DUE), T_CERT, CERT_ID())
    expect(warn.status).toBe('warn')
    expect(warn.details).toMatchObject({ daysLeft: 19 })
    expect(
      (
        await acmeAdapter.health!(
          ctxFor(world, {}, new Date('2027-03-01T00:00:00Z')),
          T_CERT,
          CERT_ID()
        )
      ).status
    ).toBe('down')
  })

  it('does not ask the CA who we are on every read (the account URL is kept for an hour)', async () => {
    const ctx = ctxFor(world)
    await acmeAdapter.observe(ctx, T_CERT, CERT_ID())
    await acmeAdapter.observe(ctx, T_CERT, CERT_ID())
    expect(calledAcme().filter((c) => c.path === '/acme/new-acct')).toHaveLength(1)
    // An account resource still reads the account itself.
    await acmeAdapter.observe(ctx, T_ACCOUNT, ACCT_ID())
    expect(calledAcme().filter((c) => c.path === '/acme/new-acct')).toHaveLength(2)
  })

  it('every call stays on the directory host', async () => {
    await acmeAdapter.observe(ctxFor(world), T_CERT, CERT_ID())
    expect(new Set(world.calls.map((c) => c.host))).toEqual(new Set([fake.CA_STAGING]))
  })
})

// ═══ Standard contract ═══

describe('acme standard tests', () => {
  it('estimate from recorded price answer: both types are free and exact', async () => {
    for (const t of acmeAdapter.types) {
      const e = await t.estimate!(ctxFor(world), null, null)
      expect(e).toMatchObject({ monthlyCents: 0, basis: 'free', confidence: 'exact' })
    }
  })

  it('declares outputs and none leak into observed/desired', async () => {
    const res = await acmeAdapter.apply(ctxFor(world), op(T_CERT, {}), certDesired())
    expect(
      Object.keys(res.outputs ?? {}).every((k) => spec(T_CERT).outputs!.some((o) => o.key === k))
    ).toBe(true)
    expect(JSON.stringify(res.observed)).not.toContain('BEGIN')
    expect(acmeAdapter.types.every((t) => t.fields.every((f) => f.kind !== 'secret'))).toBe(true)
  })

  it('maps 429 to retryable (also from DNS)', async () => {
    const orig = world.fetchImpl
    configureResourceEngine({
      fetch: {
        fetchImpl: (async (url: string, init: any) =>
          new URL(url).hostname === 'api.cloudflare.com'
            ? new Response('{"success":false,"errors":[{"message":"slow down"}]}', { status: 429 })
            : orig(url, init)) as any,
        timeoutMs: 2000
      }
    })
    const err: any = await acmeAdapter
      .apply(ctxFor(world), op(T_CERT, {}), certDesired())
      .catch((e) => e)
    expect(err.code).toBe('ACME_DNS_FAILED')
    expect(err.retryable).toBe(true)
  })

  it('secrets never reach an error: a failing DNS token and the account key are masked', async () => {
    const orig = world.fetchImpl
    configureResourceEngine({
      fetch: {
        fetchImpl: (async (url: string, init: any) =>
          new URL(url).hostname === 'api.cloudflare.com'
            ? new Response(
                `{"success":false,"errors":[{"message":"bad token ${connSecrets[20].apiToken}"}]}`,
                { status: 403 }
              )
            : orig(url, init)) as any,
        timeoutMs: 2000
      }
    })
    const err: any = await acmeAdapter
      .apply(ctxFor(world), op(T_CERT, {}), certDesired())
      .catch((e) => e)
    expect(err.message).not.toContain(connSecrets[20].apiToken)
  })

  it('an unknown type or a wrong op throws a ProviderError', async () => {
    expect(() => acmeAdapter.plan(ctxFor(world), desired('acme.other', {}), null)).toThrow(
      /no resource type/
    )
    await expect(acmeAdapter.observe(ctxFor(world), 'acme.other', 'x')).rejects.toMatchObject({
      code: 'UNKNOWN_TYPE'
    })
  })

  it('a custom directory on another host cannot reach back into other hosts', async () => {
    const evil = fake.makeWorld({ account: true, host: 'acme.example.test' })
    const dir = (await (await evil.fetchImpl('https://acme.example.test/directory')).json()) as any
    expect(dir.newNonce).toContain('acme.example.test')
    const ctx = ctxFor(evil, {
      directory: 'custom',
      directory_url: 'https://acme.example.test/directory'
    })
    expect(await acmeAdapter.observe(ctx, T_ACCOUNT, ACCT_ID('acme.example.test'))).not.toBeNull()
    // The letsencrypt hosts are not allowed for that connection.
    await expect(ctx.fetch(`https://${fake.CA_STAGING}/directory`)).rejects.toBeTruthy()
  })
})
