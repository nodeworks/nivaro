import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Hub providers Task 43: Cloudflare Registrar (`cloudflare.domain`) and the shared XML reader,
// against recorded (fake-valued) answers. Nothing reaches a real account; nothing is registered.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { cloudflareProvider } = await import('../../../services/hub/providers/cloudflare/index.js')
const { parseXml, xmlAttr, xmlList, xmlText, xmlChild } = await import(
  '../../../services/hub/providers/xml.js'
)
const awsXml = await import('../../../services/hub/providers/aws/xml.js')
const { ensureCoreProviders } = await import('../../../services/hub/providers/index.js')
ensureCoreProviders()

import type {
  DesiredResource,
  Observed,
  ProviderContext
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/cloudflare/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TOKEN = 'test-secret-cf-token-0001'
const A = 'a0000000000000000000000000000001'
const D = 'hub-test-example.com'
const T = 'cloudflare.domain'

interface Route {
  method: string
  path: RegExp
  status?: number
  body?: unknown
}

function harness(routes: Route[]) {
  const calls: Array<{ method: string; path: string; body: any }> = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call = {
      method: String(init?.method ?? 'GET'),
      path: u.pathname.replace(/^\/client\/v4/, ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    const hit = routes.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response(JSON.stringify(fx('error-not-found')), { status: 404 })
    return new Response(JSON.stringify(hit.body ?? {}), { status: hit.status ?? 200 })
  }
  const ctx = makeProviderContext({
    adapter: cloudflareProvider,
    connectionId: 1,
    config: { accountId: A },
    secrets: { apiToken: TOKEN },
    now: () => new Date('2026-11-27T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  }) as ProviderContext
  return { ctx, calls, writes: () => calls.filter((c) => c.method !== 'GET') }
}

const spec = cloudflareProvider.types.find((t) => t.key === T)!
const domainPath = new RegExp(`^/accounts/${A}/registrar/domains/hub-test-example\\.com$`)

function desired(fields: Record<string, unknown>): DesiredResource {
  return {
    resourceId: 61,
    type: T,
    externalId: D,
    scope: 'shared',
    appId: null,
    environmentId: null,
    fields: { name: D, ...fields },
    refs: {},
    tags: {}
  }
}

async function observed(): Promise<Observed> {
  const h = harness([{ method: 'GET', path: domainPath, body: fx('registrar-domain') }])
  return (await cloudflareProvider.observe(h.ctx, T, D)) as Observed
}

describe('cloudflare.domain (Registrar)', () => {
  it('is a shared registrar type that cannot be registered, transferred or deleted here', () => {
    expect(spec.registrar).toBe(true)
    expect(spec.scope).toBe('shared')
    expect(spec.capabilities).toMatchObject({
      create: false,
      delete: false,
      update: true,
      adopt: true
    })
    expect(spec.costClass!(desired({}))).toBe('yearly')
    expect(spec.outputs ?? []).toEqual([])
  })

  it('observe reads expiry, auto-renew, lock, privacy and the registrant under the pinned account', async () => {
    const o = await observed()
    expect(o.fields).toMatchObject({
      name: D,
      auto_renew: true,
      locked: true,
      privacy: true,
      expires_at: '2027-01-15T10:00:00.000Z',
      registrant_organization: 'Hub Test Org'
    })
    // Another account's (or an unknown) domain answers 404: gone, never followed elsewhere.
    const h = harness([])
    expect(await cloudflareProvider.observe(h.ctx, T, 'not-mine.com')).toBeNull()
    expect(h.calls[0].path).toBe(`/accounts/${A}/registrar/domains/not-mine.com`)
    await expect(cloudflareProvider.observe(h.ctx, T, '../zones')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
  })

  it('health answers the domain watch details', async () => {
    const h = harness([{ method: 'GET', path: domainPath, body: fx('registrar-domain') }])
    const r = await cloudflareProvider.health!(h.ctx, T, D)
    expect(r.status).toBe('ok')
    expect(r.details).toMatchObject({
      expiresAt: '2027-01-15T10:00:00.000Z',
      autoRenew: true,
      locked: true
    })
    const gone = await cloudflareProvider.health!(harness([]).ctx, T, 'gone-domain.com')
    expect(gone.status).toBe('down')
  })

  it('list keeps only well-formed names of the account', async () => {
    const h = harness([
      {
        method: 'GET',
        path: new RegExp(`^/accounts/${A}/registrar/domains$`),
        body: fx('registrar-domains')
      }
    ])
    const page = await cloudflareProvider.list(h.ctx, T, null)
    expect(page.items.map((i) => i.externalId)).toEqual([D, 'hub-test-lapsing.dev'])
    expect(page.cursor).toBeNull()
  })

  it('risk flags: auto-renew off = downtime, lock off = destructive, privacy off = public exposure', async () => {
    const o = await observed()
    const off = desired({ auto_renew: false, locked: false, privacy: false })
    const [op] = cloudflareProvider.plan({} as ProviderContext, off, o)
    expect(op.kind).toBe('update')
    expect(spec.risk(op, off).sort()).toEqual(['destructive', 'downtime', 'public_exposure'])
    const same = desired({ auto_renew: true, locked: true })
    expect(cloudflareProvider.plan({} as ProviderContext, same, o)[0].kind).toBe('noop')
  })

  it('apply sends only what still differs, and refuses register / delete', async () => {
    const o = await observed()
    const off = desired({ locked: false })
    const [op] = cloudflareProvider.plan({} as ProviderContext, off, o)
    const h = harness([
      { method: 'GET', path: domainPath, body: fx('registrar-domain') },
      { method: 'PUT', path: domainPath, body: fx('registrar-domain') }
    ])
    await cloudflareProvider.apply(h.ctx, op, off)
    expect(h.writes()).toEqual([
      { method: 'PUT', path: `/accounts/${A}/registrar/domains/${D}`, body: { locked: false } }
    ])
    // Already in that state: nothing sent.
    const already = desired({ locked: true })
    const h2 = harness([{ method: 'GET', path: domainPath, body: fx('registrar-domain') }])
    await cloudflareProvider.apply(
      h2.ctx,
      { ...op, changes: [{ field: 'locked', from: false, to: true }] },
      already
    )
    expect(h2.writes()).toEqual([])
    await expect(
      cloudflareProvider.apply(h2.ctx, { ...op, kind: 'create', externalId: null }, already)
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(
      cloudflareProvider.apply(h2.ctx, { ...op, kind: 'delete' }, null)
    ).rejects.toMatchObject({
      code: 'NOT_DELETABLE'
    })
  })

  it('a domain outside the account cannot be changed', async () => {
    const o = await observed()
    const off = desired({ locked: false })
    const [op] = cloudflareProvider.plan({} as ProviderContext, off, o)
    await expect(cloudflareProvider.apply(harness([]).ctx, op, off)).rejects.toMatchObject({
      code: 'CLOUDFLARE_OUT_OF_ACCOUNT'
    })
  })

  it('maps 429 to retryable and keeps the token out of errors', async () => {
    const h = harness([
      { method: 'GET', path: domainPath, status: 429, body: fx('error-rate-limited') }
    ])
    await expect(cloudflareProvider.observe(h.ctx, T, D)).rejects.toMatchObject({ retryable: true })
    const echo = harness([
      { method: 'GET', path: domainPath, status: 400, body: fx('error-echo-token') }
    ])
    const err = await cloudflareProvider.observe(echo.ctx, T, D).catch((e) => e)
    expect(String(err.message)).not.toContain(TOKEN)
  })

  it('Test says registration is not offered through the API', async () => {
    const h = harness([{ method: 'GET', path: /tokens\/verify$/, body: fx('token-verify') }])
    const t = await cloudflareProvider.testConnection(h.ctx)
    expect(t.message).toContain('register in the Cloudflare dashboard')
    expect(t.permissions.some((p) => p.type === T && p.need === 'read registrar domains')).toBe(
      true
    )
  })

  it('estimate from recorded price answer', async () => {
    const e = await spec.estimate!(harness([]).ctx, null, await observed())
    expect(e.yearlyCents).toBe(1046)
    expect(e.oneTimeCents).toBe(0)
    expect(e.confidence).toBe('list_price')
    expect(e.priceAsOf).toBe('2026-11-26')
    const off = await spec.estimate!(
      harness([]).ctx,
      desired({ auto_renew: false }),
      await observed()
    )
    expect(off.yearlyCents).toBe(0)
    const odd = await spec.estimate!(
      harness([]).ctx,
      { ...desired({}), fields: { name: 'x.zz-none' } },
      null
    )
    expect(odd.confidence).toBe('unknown')
  })
})

describe('providers/xml.ts', () => {
  it('keeps attributes when asked (Namecheap) and drops them otherwise (AWS, unchanged)', () => {
    const text =
      '<?xml version="1.0"?><R xmlns="x"><Item Name="a&amp;b" Gt="1>0">text</Item><Item Name="c"/></R>'
    const withAttrs = parseXml(text, { attributes: true })
    const items = xmlList(withAttrs.R, 'Item')
    expect(items.map((i) => xmlAttr(i, 'Name'))).toEqual(['a&b', 'c'])
    expect(xmlAttr(items[0], 'Gt')).toBe('1>0')
    expect(xmlText(items[0])).toBe('text')
    expect(xmlChild(withAttrs.R, '@xmlns')).toBeUndefined()
    const plain = awsXml.parseAwsXml(text)
    expect(xmlList(plain.R, 'Item')).toEqual(['text', ''])
    expect(() => awsXml.parseAwsXml('<a><b></a>')).toThrow(awsXml.AwsXmlError)
  })

  it('never writes prototype keys from attribute or element names', () => {
    const doc = parseXml('<R __proto__="x"><constructor>1</constructor><k>v</k></R>', {
      attributes: true
    })
    expect(Object.getPrototypeOf(doc.R)).toBe(Object.prototype)
    expect(({} as any).polluted).toBeUndefined()
    expect(xmlText(xmlChild(doc.R, 'k'))).toBe('v')
  })
})
