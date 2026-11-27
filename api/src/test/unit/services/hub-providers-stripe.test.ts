import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

// Hub providers Task 27: the Stripe adapter against recorded (fake-valued) answers.

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { ensureCoreProviders, CORE_PROVIDERS } = await import(
  '../../../services/hub/providers/index.js'
)
const registry = await import('../../../services/hub/providers/registry.js')
const { stripeAdapter } = await import('../../../services/hub/providers/stripe/index.js')
const { stripePathAllowed, formEncode } = await import(
  '../../../services/hub/providers/stripe/client.js'
)

import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/stripe/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TEST_KEY = 'rk_test_testsecretkey0001'
const LIVE_KEY = 'rk_live_testsecretkey0002'
const PROD = 'prod_TESTproduct0001'
const PRICE = 'price_TESTprice0001'
const HOOK = 'we_TESTendpoint0001'
const SIGNING = 'whsec_test-secret-signing-0001'

interface Call {
  method: string
  path: string
  query: URLSearchParams
  form: URLSearchParams
  headers: Record<string, string>
}
interface Route {
  method: string
  path: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function harness(routes: Route[], key = TEST_KEY) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      path: u.pathname,
      query: u.searchParams,
      form: new URLSearchParams(init?.body ? String(init.body) : ''),
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response('{"error":{"message":"not found"}}', { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: stripeAdapter,
    connectionId: 1,
    config: {},
    secrets: { apiKey: key },
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
    scope: 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: { 'nivaro-hub:resource': '7', 'nivaro-hub:app': 'demo' }
  }
}

const op = (type: string, over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'update',
  type,
  resourceId: 7,
  externalId: PROD,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

const typeSpec = (key: string) => {
  const t = stripeAdapter.types.find((x) => x.key === key)
  if (!t) throw new Error(`no type ${key}`)
  return t
}

const PRODUCT_T = 'stripe.product'
const PRICE_T = 'stripe.price'
const HOOK_T = 'stripe.webhook_endpoint'
const PORTAL_T = 'stripe.billing_portal_config'
const TAX_T = 'stripe.tax_rate'

beforeEach(() => {
  registry.resetProvidersForTest()
})

describe('stripe adapter: registration', () => {
  it('is a core provider on api.stripe.com with a secret key and five types', () => {
    ensureCoreProviders()
    expect(registry.getProvider('stripe')).toBe(stripeAdapter)
    expect(CORE_PROVIDERS).toContain(stripeAdapter)
    expect(stripeAdapter.connection.hosts({})).toEqual(['api.stripe.com'])
    expect(stripeAdapter.connection.fields.find((f) => f.key === 'apiKey')?.secret).toBe(true)
    expect(stripeAdapter.connection.describe({})).not.toContain(TEST_KEY)
    expect(stripeAdapter.connection.validate?.({}, { apiKey: 'pk_test_abcdefghijk' })).not.toEqual(
      []
    )
    expect(stripeAdapter.connection.validate?.({}, { apiKey: TEST_KEY })).toEqual([])
    expect(stripeAdapter.types.map((t) => t.key)).toEqual([
      PRODUCT_T,
      PRICE_T,
      HOOK_T,
      PORTAL_T,
      TAX_T
    ])
    for (const t of stripeAdapter.types) expect(t.costClass).toBeUndefined()
  })

  it('refuses a host other than api.stripe.com', async () => {
    const { ctx } = harness([])
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })
})

describe('stripe adapter: testConnection', () => {
  it('lists missing permissions when the key is refused', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /products$/, status: 401, body: fx('error-401') }
    ])
    const r = await stripeAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('read products')
    expect(r.message ?? '').not.toContain(TEST_KEY)
  })

  it('names the account and the mode; a 403 on one area is a missing permission', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/products$/, body: { data: [] } },
      { method: 'GET', path: /\/prices$/, body: { data: [] } },
      {
        method: 'GET',
        path: /webhook_endpoints$/,
        status: 403,
        body: { error: { message: 'no' } }
      },
      { method: 'GET', path: /configurations$/, body: { data: [] } },
      { method: 'GET', path: /tax_rates$/, body: { data: [] } },
      { method: 'GET', path: /\/account$/, body: fx('account') }
    ])
    const r = await stripeAdapter.testConnection(ctx)
    expect(r.identity).toBe('Stripe acct_TEST0001 · Demo Co (test mode)')
    expect(r.missing).toEqual(['read webhook endpoints'])
    expect(r.ok).toBe(false)
  })
})

describe('stripe adapter: observe and list', () => {
  it('observe maps fields and tags, and carries no secret', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/webhook_endpoints\//, body: { ...fx('webhook'), secret: SIGNING } }
    ])
    const seen = await stripeAdapter.observe(ctx, HOOK_T, HOOK)
    expect(seen).toMatchObject({
      externalId: HOOK,
      status: 'enabled',
      tags: { 'nivaro-hub:resource': '9' },
      fields: {
        url: 'https://hooks.example.com/stripe',
        enabled_events: ['checkout.session.completed', 'invoice.paid'],
        status: 'enabled'
      }
    })
    expect(JSON.stringify(seen)).not.toContain('whsec_')
    expect(calls[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(calls[0].headers['stripe-version']).toBeTruthy()
  })

  it('a missing object, or one from the other mode, reads as gone', async () => {
    const { ctx } = harness([])
    expect(await stripeAdapter.observe(ctx, PRODUCT_T, PROD)).toBeNull()
    const { ctx: c2 } = harness([
      { method: 'GET', path: /\/products\//, body: { ...fx('product'), livemode: true } }
    ])
    expect(await stripeAdapter.observe(c2, PRODUCT_T, PROD)).toBeNull()
  })

  it('maps a price with its product as a provider id and an archived product as archived', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/prices\//, body: fx('price') },
      { method: 'GET', path: /\/products\//, body: { ...fx('product'), active: false } }
    ])
    const price = await stripeAdapter.observe(ctx, PRICE_T, PRICE)
    expect(price?.fields).toMatchObject({
      product: PROD,
      currency: 'usd',
      unit_amount: 1500,
      interval: 'month',
      interval_count: 1,
      lookup_key: 'demo_monthly'
    })
    expect((await stripeAdapter.observe(ctx, PRODUCT_T, PROD))?.status).toBe('archived')
  })

  it('list pages by starting_after and skips the other mode', async () => {
    const { ctx, calls } = harness([
      {
        method: 'GET',
        path: /\/products$/,
        body: {
          data: [fx('product'), { ...fx('product'), id: 'prod_OTHER0001', livemode: true }],
          has_more: true
        }
      }
    ])
    const page = await stripeAdapter.list(ctx, PRODUCT_T, 'prod_CURSOR0001')
    expect(page.items.map((i) => i.externalId)).toEqual([PROD])
    expect(page.cursor).toBe('prod_OTHER0001')
    expect(calls[0].query.get('starting_after')).toBe('prod_CURSOR0001')
    expect(calls[0].query.get('active')).toBe('true')
  })

  it('refuses an id that is not a safe path segment or the wrong kind', async () => {
    const { ctx, calls } = harness([])
    for (const id of ['../x', 'a/b', '', 'price_TESTprice0001'])
      await expect(stripeAdapter.observe(ctx, PRODUCT_T, id)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    expect(calls).toEqual([])
  })
})

describe('stripe adapter: plan', () => {
  const { ctx: testCtx } = harness([])
  const { ctx: liveCtx } = harness([], LIVE_KEY)
  const obsProduct = (over: Record<string, unknown> = {}): Observed => ({
    type: PRODUCT_T,
    externalId: PROD,
    name: 'Demo plan',
    fields: { name: 'Demo plan', description: 'A demo product', active: true, ...over },
    tags: {},
    status: 'active'
  })
  const obsPrice = (): Observed => ({
    type: PRICE_T,
    externalId: PRICE,
    name: 'Monthly',
    fields: {
      product: PROD,
      currency: 'usd',
      unit_amount: 1500,
      interval: 'month',
      interval_count: 1,
      nickname: 'Monthly',
      lookup_key: null,
      tax_behavior: 'unspecified',
      active: true
    },
    tags: {}
  })

  it('create says it; test mode is open to owners, live mode is admin only', () => {
    const d = desired(PRODUCT_T, { name: 'Demo plan' })
    const [t] = stripeAdapter.plan(testCtx, d, null)
    expect(t.kind).toBe('create')
    expect(t.reason).toContain('Stripe product Demo plan')
    expect(t.data?.$adminOnly).toBeUndefined()
    const [l] = stripeAdapter.plan(liveCtx, d, null)
    expect(l.data?.$adminOnly).toBe(true)
  })

  it('every live op carries the admin gate: update, replace and delete too', () => {
    const upd = stripeAdapter.plan(
      liveCtx,
      desired(PRODUCT_T, { name: 'New', description: 'A demo product', active: true }, PROD),
      obsProduct()
    )
    expect(upd[0]).toMatchObject({ kind: 'update', data: { $adminOnly: true } })
    const del = stripeAdapter.plan(liveCtx, null, obsProduct())
    expect(del[0]).toMatchObject({ kind: 'delete', data: { $adminOnly: true } })
  })

  it('update lists the changed fields with labels', () => {
    const [p] = stripeAdapter.plan(
      testCtx,
      desired(PRODUCT_T, { name: 'Demo plan', description: 'New text', active: true }, PROD),
      obsProduct()
    )
    expect(p.changes).toEqual([{ field: 'description', from: 'A demo product', to: 'New text' }])
    expect(p.reason).toContain('Description')
  })

  it('an amount change on a price is a replace; a nickname change is an update', () => {
    const want = {
      currency: 'usd',
      unit_amount: 2000,
      interval: 'month',
      interval_count: 1,
      nickname: 'Monthly',
      active: true
    }
    const [r] = stripeAdapter.plan(
      testCtx,
      desired(PRICE_T, want, PRICE, { product: PROD }),
      obsPrice()
    )
    expect(r.kind).toBe('replace')
    expect(r.reason).toContain('archived')
    const [u] = stripeAdapter.plan(
      testCtx,
      desired(PRICE_T, { ...want, unit_amount: 1500, nickname: 'Pro' }, PRICE, { product: PROD }),
      obsPrice()
    )
    expect(u.kind).toBe('update')
  })

  it('delete archives (never deletes) and says Stripe keeps it; an archived object plans nothing', () => {
    const [d] = stripeAdapter.plan(testCtx, null, obsProduct())
    expect(d.kind).toBe('delete')
    expect(d.reason).toContain('Archive')
    expect(d.reason).toContain('never deletes')
    expect(stripeAdapter.plan(testCtx, null, obsProduct({ active: false }))).toEqual([])
    expect(
      stripeAdapter.plan(
        testCtx,
        desired(
          PRODUCT_T,
          { name: 'Demo plan', description: 'A demo product', active: true },
          PROD
        ),
        obsProduct()
      )
    ).toEqual([])
  })

  it('a webhook endpoint plan offers the rotate op only when asked', () => {
    const observed: Observed = {
      type: HOOK_T,
      externalId: HOOK,
      name: 'https://hooks.example.com/stripe',
      fields: {
        url: 'https://hooks.example.com/stripe',
        enabled_events: ['invoice.paid'],
        description: null,
        status: 'enabled'
      },
      tags: {},
      status: 'enabled'
    }
    const want = {
      url: 'https://hooks.example.com/stripe',
      enabled_events: ['invoice.paid'],
      status: 'enabled'
    }
    expect(stripeAdapter.plan(testCtx, desired(HOOK_T, want, HOOK), observed)).toEqual([])
    const [r] = stripeAdapter.plan(
      testCtx,
      desired(HOOK_T, { ...want, rotate_outputs: true }, HOOK),
      observed
    )
    expect(r).toMatchObject({ kind: 'update', action: 'rotate' })
  })
})

describe('stripe adapter: risk flags', () => {
  it('archive, replace, rotate and disabling are downtime; the rest nothing', () => {
    const r = (type: string, p: Partial<PlannedOp>) => typeSpec(type).risk(op(type, p), null)
    expect(r(PRODUCT_T, { kind: 'create' })).toEqual([])
    expect(r(PRODUCT_T, { kind: 'delete' })).toEqual(['downtime'])
    expect(r(PRICE_T, { kind: 'replace' })).toEqual(['downtime'])
    expect(r(HOOK_T, { action: 'rotate' })).toEqual(['downtime'])
    expect(r(HOOK_T, { changes: [{ field: 'status', from: 'enabled', to: 'disabled' }] })).toEqual([
      'downtime'
    ])
    expect(r(TAX_T, { kind: 'update' })).toEqual([])
  })
})

describe('stripe adapter: apply', () => {
  it('product create posts a form with an idempotency key and the Hub tags', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/products$/, body: { data: [], has_more: false } },
      { method: 'POST', path: /\/products$/, body: fx('product') }
    ])
    const res = await stripeAdapter.apply(
      ctx,
      op(PRODUCT_T, { kind: 'create', externalId: null }),
      desired(PRODUCT_T, { name: 'Demo plan', description: 'A demo product', active: true })
    )
    expect(res).toMatchObject({ ok: true, externalId: PROD })
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.form.get('name')).toBe('Demo plan')
    expect(post?.form.get('metadata[nivaro-hub:resource]')).toBe('7')
    expect(post?.headers['idempotency-key']).toBe('nivaro-hub-create-stripe.product-7')
    expect(post?.headers['content-type']).toBe('application/x-www-form-urlencoded')
  })

  it('create over a product the Hub did not make is ALREADY_EXISTS, nothing written', async () => {
    const other = { ...fx('product'), metadata: {} }
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/products$/, body: { data: [other], has_more: false } }
    ])
    await expect(
      stripeAdapter.apply(
        ctx,
        op(PRODUCT_T, { kind: 'create', externalId: null }),
        desired(PRODUCT_T, { name: 'Demo plan' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('a resumed create finds its own tagged object and writes nothing', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/products$/, body: { data: [fx('product')], has_more: false } }
    ])
    const res = await stripeAdapter.apply(
      ctx,
      op(PRODUCT_T, { kind: 'create', externalId: null }),
      desired(PRODUCT_T, { name: 'Demo plan' })
    )
    expect(res.answer).toMatchObject({ already: 'exists' })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('findExisting names a same-named product for the plan', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/products$/, body: { data: [fx('product')], has_more: false } }
    ])
    const hit = await stripeAdapter.findExisting?.(
      ctx,
      PRODUCT_T,
      desired(PRODUCT_T, { name: 'Demo plan' })
    )
    expect(hit?.externalId).toBe(PROD)
  })

  it('update reads first and posts only what differs; a match writes nothing', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/products\//, body: fx('product') },
      { method: 'POST', path: /\/products\//, body: fx('product') }
    ])
    await stripeAdapter.apply(
      ctx,
      op(PRODUCT_T, {}),
      desired(PRODUCT_T, { name: 'Renamed', description: 'A demo product', active: true }, PROD)
    )
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect([...posts[0].form.keys()]).toEqual(['name'])
    const { ctx: c2, calls: calls2 } = harness([
      { method: 'GET', path: /\/products\//, body: fx('product') }
    ])
    const again = await stripeAdapter.apply(
      c2,
      op(PRODUCT_T, {}),
      desired(PRODUCT_T, { name: 'Demo plan', description: 'A demo product', active: true }, PROD)
    )
    expect(again.answer).toMatchObject({ already: 'matches' })
    expect(calls2.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('delete of a product or price ARCHIVES it: active=false, never a DELETE', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/products\//, body: fx('product') },
      { method: 'POST', path: /\/products\//, body: { ...fx('product'), active: false } }
    ])
    const res = await stripeAdapter.apply(ctx, op(PRODUCT_T, { kind: 'delete' }), null)
    expect(res).toMatchObject({ ok: true, externalId: PROD, observed: null })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST'])
    expect(calls[1].form.get('active')).toBe('false')
    const { ctx: c2, calls: calls2 } = harness([
      { method: 'GET', path: /\/prices\//, body: fx('price') },
      { method: 'POST', path: /\/prices\//, body: { ...fx('price'), active: false } }
    ])
    await stripeAdapter.apply(c2, op(PRICE_T, { kind: 'delete', externalId: PRICE }), null)
    expect(calls2.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('a price replace creates the new price (transferring the lookup key), then archives the old', async () => {
    const newPrice = { ...fx('price'), id: 'price_TESTprice0002', unit_amount: 2000 }
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/prices\/price_TESTprice0001$/, body: fx('price') },
      { method: 'GET', path: /\/prices$/, body: { data: [fx('price')] } },
      { method: 'POST', path: /\/prices$/, body: newPrice },
      {
        method: 'POST',
        path: /\/prices\/price_TESTprice0001$/,
        body: { ...fx('price'), active: false }
      }
    ])
    const res = await stripeAdapter.apply(
      ctx,
      op(PRICE_T, { kind: 'replace', externalId: PRICE }),
      desired(
        PRICE_T,
        {
          currency: 'usd',
          unit_amount: 2000,
          interval: 'month',
          interval_count: 1,
          nickname: 'Monthly',
          lookup_key: 'demo_monthly',
          active: true
        },
        PRICE,
        { product: PROD }
      )
    )
    expect(res.externalId).toBe('price_TESTprice0002')
    expect(res.answer).toMatchObject({ replaced: PRICE })
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts.map((c) => c.path)).toEqual(['/v1/prices', `/v1/prices/${PRICE}`])
    expect(posts[0].form.get('product')).toBe(PROD)
    expect(posts[0].form.get('unit_amount')).toBe('2000')
    expect(posts[0].form.get('recurring[interval]')).toBe('month')
    expect(posts[0].form.get('transfer_lookup_key')).toBe('true')
    expect(posts[1].form.get('active')).toBe('false')
  })

  describe('price replace and the lookup key', () => {
    const want = () =>
      desired(
        PRICE_T,
        {
          currency: 'usd',
          unit_amount: 2000,
          interval: 'month',
          interval_count: 1,
          nickname: 'Monthly',
          lookup_key: 'demo_monthly',
          active: true
        },
        PRICE,
        { product: PROD }
      )
    const run = (holder: any) => {
      const { ctx, calls } = harness([
        { method: 'GET', path: /\/prices\/price_TESTprice0001$/, body: fx('price') },
        { method: 'GET', path: /\/prices$/, body: { data: holder ? [holder] : [] } },
        { method: 'POST', path: /\/prices$/, body: { ...fx('price'), id: 'price_TESTprice0002' } },
        {
          method: 'POST',
          path: /\/prices\/price_TESTprice0001$/,
          body: { ...fx('price'), active: false }
        }
      ])
      return {
        calls,
        go: () =>
          stripeAdapter.apply(ctx, op(PRICE_T, { kind: 'replace', externalId: PRICE }), want())
      }
    }

    it('the price being replaced hands its lookup key over', async () => {
      const { go, calls } = run(fx('price'))
      await go()
      const post = calls.find((c) => c.method === 'POST' && c.path === '/v1/prices')
      expect(post?.form.get('transfer_lookup_key')).toBe('true')
    })

    it('a price carrying this resource’s tag may hand it over too', async () => {
      const { go, calls } = run({
        ...fx('price'),
        id: 'price_TESTprice0003',
        metadata: { 'nivaro-hub:resource': '7' }
      })
      await go()
      expect(
        calls
          .find((c) => c.path === '/v1/prices' && c.method === 'POST')
          ?.form.get('transfer_lookup_key')
      ).toBe('true')
    })

    it('a key held by a price of another app is refused, nothing written', async () => {
      const { go, calls } = run({
        ...fx('price'),
        id: 'price_FOREIGN0001',
        metadata: { 'nivaro-hub:resource': '99' }
      })
      await expect(go()).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
      expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    })

    it('a key held by an untagged price is refused, nothing written', async () => {
      const { go, calls } = run({ ...fx('price'), id: 'price_UNTAGGED0001', metadata: {} })
      await expect(go()).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
      expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    })
  })

  it('a price needs its product resolved; bad input is refused before any call', async () => {
    const { ctx, calls } = harness([])
    await expect(
      stripeAdapter.apply(
        ctx,
        op(PRICE_T, { kind: 'create', externalId: null }),
        desired(PRICE_T, { currency: 'usd', unit_amount: 100 })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    await expect(
      stripeAdapter.apply(
        ctx,
        op(HOOK_T, { kind: 'create', externalId: null }),
        desired(HOOK_T, { url: 'http://hooks.example.com/x', enabled_events: ['invoice.paid'] })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    expect(calls).toEqual([])
  })

  it('a step whose target differs from the resource is refused', async () => {
    const { ctx, calls } = harness([])
    await expect(
      stripeAdapter.apply(
        ctx,
        op(PRODUCT_T, { externalId: 'prod_OTHER0001' }),
        desired(PRODUCT_T, { name: 'x' }, PROD)
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(calls).toEqual([])
  })

  it('tax rate: percentage change is a replace, a name change is an update', async () => {
    const { ctx } = harness([])
    const observed: Observed = {
      type: TAX_T,
      externalId: 'txr_TESTtaxrate0001',
      name: 'Sales tax',
      fields: { display_name: 'Sales tax', percentage: 8.25, inclusive: false, active: true },
      tags: {}
    }
    const base = { display_name: 'Sales tax', percentage: 8.25, inclusive: false, active: true }
    expect(
      stripeAdapter.plan(
        ctx,
        desired(TAX_T, { ...base, percentage: 9 }, 'txr_TESTtaxrate0001'),
        observed
      )[0].kind
    ).toBe('replace')
    expect(
      stripeAdapter.plan(
        ctx,
        desired(TAX_T, { ...base, display_name: 'Tax' }, 'txr_TESTtaxrate0001'),
        observed
      )[0].kind
    ).toBe('update')
  })

  it('portal configuration create sends nested features and only the modelled ones', async () => {
    const { ctx, calls } = harness([
      { method: 'POST', path: /configurations$/, body: fx('portal') }
    ])
    await stripeAdapter.apply(
      ctx,
      op(PORTAL_T, { kind: 'create', externalId: null }),
      desired(PORTAL_T, {
        headline: 'Manage billing',
        invoice_history: true,
        customer_update: true,
        customer_update_allowed: ['phone', 'email'],
        subscription_cancel: false
      })
    )
    const f = calls[0].form
    expect(f.get('business_profile[headline]')).toBe('Manage billing')
    expect(f.get('features[customer_update][allowed_updates][0]')).toBe('phone')
    expect(f.get('features[subscription_cancel][enabled]')).toBe('false')
    expect([...f.keys()].some((k) => k.includes('subscription_update'))).toBe(false)
  })
})

describe('stripe adapter: webhook signing secret (once-only output)', () => {
  it('create answers the secret as an output only', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /webhook_endpoints$/, body: { data: [], has_more: false } },
      { method: 'POST', path: /webhook_endpoints$/, body: fx('webhook-created') }
    ])
    const res = await stripeAdapter.apply(
      ctx,
      op(HOOK_T, { kind: 'create', externalId: null }),
      desired(HOOK_T, {
        url: 'https://hooks.example.com/stripe',
        enabled_events: ['invoice.paid', 'checkout.session.completed'],
        description: 'Demo hook'
      })
    )
    expect(res.outputs).toEqual({ signing_secret: SIGNING })
    expect(JSON.stringify(res.observed)).not.toContain(SIGNING)
    expect(JSON.stringify(res.answer)).not.toContain(SIGNING)
  })

  it('declares signing_secret as a secret, once-only output; none leak into observed or plans', () => {
    expect(typeSpec(HOOK_T).outputs).toEqual([
      { key: 'signing_secret', label: 'Webhook signing secret', secret: true, onceOnly: true }
    ])
    for (const t of stripeAdapter.types.filter((x) => x.key !== HOOK_T))
      expect(t.outputs).toBeUndefined()
    expect(stripeAdapter.readOutputs).toBeUndefined()
    expect(typeSpec(HOOK_T).fields.map((f) => f.key)).not.toContain('signing_secret')
    const { ctx } = harness([])
    const plan = stripeAdapter.plan(
      ctx,
      desired(HOOK_T, {
        url: 'https://hooks.example.com/stripe',
        enabled_events: ['invoice.paid']
      }),
      null
    )
    expect(JSON.stringify(plan)).not.toContain('whsec_')
  })

  it('rotate makes a new endpoint with the same settings, returns its secret and removes the old one', async () => {
    const created = { ...fx('webhook-created'), id: 'we_TESTendpoint0002' }
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/webhook_endpoints\/we_TESTendpoint0001$/, body: fx('webhook') },
      { method: 'POST', path: /webhook_endpoints$/, body: created },
      { method: 'DELETE', path: /webhook_endpoints\/we_TESTendpoint0001$/, body: { deleted: true } }
    ])
    const res = await stripeAdapter.apply(
      ctx,
      op(HOOK_T, { action: 'rotate', externalId: HOOK }),
      desired(
        HOOK_T,
        {
          url: 'https://hooks.example.com/stripe',
          enabled_events: ['invoice.paid'],
          rotate_outputs: true
        },
        HOOK
      )
    )
    expect(res.externalId).toBe('we_TESTendpoint0002')
    expect(res.outputs).toEqual({ signing_secret: SIGNING })
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.form.get('url')).toBe('https://hooks.example.com/stripe')
    expect(post?.headers['idempotency-key']).toContain('rotate')
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'DELETE'])
  })

  it('deleting a webhook endpoint is a real DELETE (the one thing Stripe lets be deleted)', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /webhook_endpoints\//, body: fx('webhook') },
      { method: 'DELETE', path: /webhook_endpoints\//, body: { deleted: true } }
    ])
    await stripeAdapter.apply(ctx, op(HOOK_T, { kind: 'delete', externalId: HOOK }), null)
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE'])
  })
})

describe('stripe adapter: the Hub never moves money', () => {
  it('only configuration paths are allowed; charges, refunds, transfers, payouts and subscriptions never', () => {
    for (const p of [
      '/v1/charges',
      '/v1/refunds',
      '/v1/transfers',
      '/v1/payouts',
      '/v1/payment_intents',
      '/v1/subscriptions/sub_123456',
      '/v1/customers',
      '/v1/invoices',
      '/v1/balance',
      '/v1/api_keys',
      '/v1/products/../charges'
    ])
      for (const m of ['GET', 'POST', 'DELETE']) expect(stripePathAllowed(m, p)).toBe(false)
    expect(stripePathAllowed('POST', '/v1/products')).toBe(true)
    expect(stripePathAllowed('POST', '/v1/billing_portal/configurations/bpc_TESTportal0001')).toBe(
      true
    )
  })

  it('products, prices, tax rates and portal configurations can never be DELETEd', () => {
    expect(stripePathAllowed('DELETE', '/v1/products/prod_TESTproduct0001')).toBe(false)
    expect(stripePathAllowed('DELETE', '/v1/prices/price_TESTprice0001')).toBe(false)
    expect(stripePathAllowed('DELETE', '/v1/tax_rates/txr_TESTtaxrate0001')).toBe(false)
    expect(
      stripePathAllowed('DELETE', '/v1/billing_portal/configurations/bpc_TESTportal0001')
    ).toBe(false)
    expect(stripePathAllowed('DELETE', '/v1/webhook_endpoints/we_TESTendpoint0001')).toBe(true)
  })

  it('the client throws before any request for a forbidden path', async () => {
    const { ctx, calls } = harness([])
    const { stripeCall } = await import('../../../services/hub/providers/stripe/client.js')
    await expect(
      stripeCall(ctx, 'POST', '/v1/refunds', { form: { charge: 'ch_1' } })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN_CALL'
    })
    expect(calls).toEqual([])
  })

  it('form encoding nests objects and lists the way Stripe reads them', () => {
    expect(formEncode({ a: { b: 1 }, c: ['x', 'y'], d: null, e: [] })).toBe(
      'a[b]=1&c[0]=x&c[1]=y&d=&e='
    )
  })
})

describe('stripe adapter: errors', () => {
  it('maps 429 to a retryable error and says when to retry', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /\/products$/,
        status: 429,
        body: fx('error-429'),
        headers: { 'retry-after': '7' }
      }
    ])
    const err: ProviderError = await stripeAdapter.list(ctx, PRODUCT_T).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 7 s')
  })

  it('a 5xx is retryable, a 401 and a 400 are not', async () => {
    const mk = (status: number) =>
      harness([
        { method: 'GET', path: /\/products$/, status, body: { error: { message: 'nope' } } }
      ]).ctx
    expect(await stripeAdapter.list(mk(503), PRODUCT_T).catch((e) => e)).toMatchObject({
      retryable: true,
      code: 'PROVIDER_UNAVAILABLE'
    })
    expect(await stripeAdapter.list(mk(401), PRODUCT_T).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'AUTH_FAILED'
    })
    expect(await stripeAdapter.list(mk(400), PRODUCT_T).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'PROVIDER_REJECTED'
    })
  })

  it('keys never appear in errors, scrubbed before the text is clipped', async () => {
    const long = `${'x'.repeat(290)} ${TEST_KEY} tail`
    const { ctx } = harness([
      { method: 'GET', path: /\/products$/, status: 400, body: { error: { message: long } } }
    ])
    const err: ProviderError = await stripeAdapter.list(ctx, PRODUCT_T).catch((e) => e)
    expect(err.message).not.toContain(TEST_KEY)
    expect(err.message).not.toContain('rk_test_testsec')
    const { ctx: c2 } = harness([
      { method: 'GET', path: /\/products$/, status: 401, body: fx('error-401') }
    ])
    const e2: ProviderError = await stripeAdapter.list(c2, PRODUCT_T).catch((e) => e)
    expect(e2.message).toContain('Stripe answered 401')
    expect(e2.message).not.toContain('rk_test_')
  })
})

describe('stripe adapter: health', () => {
  it('ok when active, warn when archived, down when gone', async () => {
    const { ctx } = harness([{ method: 'GET', path: /\/products\//, body: fx('product') }])
    expect((await stripeAdapter.health?.(ctx, PRODUCT_T, PROD))?.status).toBe('ok')
    const { ctx: c2 } = harness([
      { method: 'GET', path: /\/products\//, body: { ...fx('product'), active: false } }
    ])
    expect((await stripeAdapter.health?.(c2, PRODUCT_T, PROD))?.status).toBe('warn')
    const { ctx: c3 } = harness([])
    expect((await stripeAdapter.health?.(c3, PRODUCT_T, PROD))?.status).toBe('down')
  })
})
