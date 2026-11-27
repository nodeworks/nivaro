import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 44b: plan-price estimates of Vercel, Auth0, Expo and GitHub from recorded
// answers of each provider's plan read and the bundled, dated price table in its folder.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const registry = await import('../../../services/hub/providers/registry.js')
const { CORE_PROVIDERS } = await import('../../../services/hub/providers/index.js')

import type { ProviderAdapter, ProviderContext } from '../../../services/hub/providers/types.js'

const adapter = (key: string) => CORE_PROVIDERS.find((p) => p.key === key) as ProviderAdapter
const typeOf = (key: string, type: string) =>
  adapter(key).types.find((t) => t.key === type) as NonNullable<ProviderAdapter['types'][number]>

type Handler = (url: string, init: { body?: unknown }) => { status?: number; body: unknown }

function ctxFor(
  key: string,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  handler: Handler
) {
  const calls: string[] = []
  const fetchImpl = async (url: string, init: { body?: unknown }) => {
    calls.push(url)
    const a = handler(url, init)
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 })
  }
  const ctx = makeProviderContext({
    adapter: adapter(key),
    connectionId: 11,
    config,
    secrets,
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as never }
  }) as ProviderContext
  return { ctx, calls }
}

const noDesired = null

beforeEach(() => {
  registry.resetProvidersForTest()
  for (const p of CORE_PROVIDERS) registry.registerProvider(p)
})

describe('vercel estimates', () => {
  const team = (plan: string | null, status = 200) =>
    ctxFor('vercel', { teamId: 'team_abc123' }, { token: 'test-secret-vercel' }, () => ({
      status,
      body: plan ? { id: 'team_abc123', slug: 'acme', billing: { plan, seats: 3 } } : {}
    }))
  const KINDS = ['project', 'env_var', 'domain', 'deployment'] as const

  it('estimate from recorded price answer: every type is a known zero on the Pro plan, with its price in the note', async () => {
    for (const k of KINDS) {
      const e = await typeOf('vercel', `vercel.${k}`).estimate?.(team('pro').ctx, noDesired, null)
      expect(e).toMatchObject({
        basis: 'plan_price',
        confidence: 'exact',
        monthlyCents: 0,
        priceAsOf: '2026-11-26'
      })
      expect(e?.note).toContain('$20 per seat')
      expect(e?.note).toContain('3 seats')
    }
  })

  it('traffic past the Pro allowance is a transfer line; under it adds nothing', async () => {
    const over = team('pro').ctx
    over.traffic = { egressGbMonth: 1500, source: 'form' }
    const e = await typeOf('vercel', 'vercel.project').estimate?.(over, noDesired, null)
    expect(e?.lines).toHaveLength(1)
    expect(e?.lines[0]).toMatchObject({
      kind: 'transfer',
      qty: 500,
      unitCents: 15,
      monthlyCents: 7500
    })
    expect(e?.monthlyCents).toBe(7500)
    expect(e?.confidence).toBe('usage_varies')
    const under = team('pro').ctx
    under.traffic = { egressGbMonth: 400, source: 'measured' }
    expect(
      (await typeOf('vercel', 'vercel.project').estimate?.(under, noDesired, null))?.lines
    ).toEqual([])
  })

  it('the Hobby plan is free and says so; an unreadable plan is unknown', async () => {
    const hobby = await typeOf('vercel', 'vercel.project').estimate?.(
      team('hobby').ctx,
      noDesired,
      null
    )
    expect(hobby?.monthlyCents).toBe(0)
    expect(hobby?.note).toContain('Hobby')
    const nope = await typeOf('vercel', 'vercel.project').estimate?.(
      team(null, 404).ctx,
      noDesired,
      null
    )
    expect(nope?.confidence).toBe('unknown')
  })

  it('bundled fallback names its date', async () => {
    const e = await typeOf('vercel', 'vercel.deployment').estimate?.(
      team('pro').ctx,
      noDesired,
      null
    )
    expect(e?.priceAsOf).toBe(adapter('vercel').bundledPrices?.asOf)
  })
})

describe('auth0 estimates', () => {
  it('estimate from recorded price answer: no fixed charge, the plans’ list prices in the note', async () => {
    const x = ctxFor('auth0', { domain: 't.eu.auth0.com', client_id: 'cid' }, {}, () => ({
      body: {}
    }))
    for (const t of ['auth0.application', 'auth0.api', 'auth0.connection_binding']) {
      const type = adapter('auth0').types.find((y) => y.key === t) ?? adapter('auth0').types[0]
      const e = await type.estimate?.(x.ctx, noDesired, null)
      expect(e).toMatchObject({
        basis: 'plan_price',
        monthlyCents: 0,
        confidence: 'list_price',
        priceAsOf: '2026-11-26'
      })
      expect(e?.note).toContain('$35')
      expect(e?.note).toContain('$240')
    }
    expect(x.calls).toEqual([])
  })

  it('every auth0 type carries the estimate', () => {
    expect(adapter('auth0').types.every((t) => typeof t.estimate === 'function')).toBe(true)
  })
})

describe('expo estimates', () => {
  const eas = (plan: string | null) =>
    ctxFor('expo', { account: 'acme' }, { token: 'test-secret-expo' }, () =>
      plan
        ? { body: { data: { account: { byName: { id: 'a1', subscription: { name: plan } } } } } }
        : { body: { errors: [{ message: 'not allowed' }] } }
    )
  const build = (platform: string) =>
    ({
      resourceId: 1,
      type: 'expo.build',
      externalId: null,
      scope: 'app',
      appId: 1,
      environmentId: 1,
      fields: { platform, profile: 'production' },
      refs: {},
      tags: {}
    }) as never

  it('estimate from recorded price answer: a build is a one-time amount by platform, the plan in the note', async () => {
    const ios = await typeOf('expo', 'expo.build').estimate?.(
      eas('Starter').ctx,
      build('ios'),
      null
    )
    expect(ios).toMatchObject({
      basis: 'usage',
      confidence: 'list_price',
      oneTimeCents: 200,
      monthlyCents: 0
    })
    expect(ios?.note).toContain('$19 a month')
    const android = await typeOf('expo', 'expo.build').estimate?.(
      eas('Production').ctx,
      build('android'),
      null
    )
    expect(android?.oneTimeCents).toBe(100)
    expect(android?.priceAsOf).toBe('2026-11-26')
  })

  it('a build that already ran costs nothing more; an unknown platform or unreadable plan degrades, never throws', async () => {
    const done = await typeOf('expo', 'expo.build').estimate?.(eas('Starter').ctx, noDesired, {
      type: 'expo.build',
      externalId: 'p:b',
      name: null,
      fields: { platform: 'ios' },
      tags: {}
    })
    expect(done?.oneTimeCents).toBe(0)
    const none = await typeOf('expo', 'expo.build').estimate?.(
      eas('Starter').ctx,
      build('web'),
      null
    )
    expect(none?.confidence).toBe('unknown')
    const blind = await typeOf('expo', 'expo.build').estimate?.(eas(null).ctx, build('ios'), null)
    expect(blind).toMatchObject({ confidence: 'usage_varies', oneTimeCents: 200 })
  })

  it('a project adds no fixed charge; without a readable plan it is unknown', async () => {
    const p = await typeOf('expo', 'expo.project').estimate?.(eas('Starter').ctx, noDesired, null)
    expect(p).toMatchObject({ basis: 'plan_price', monthlyCents: 0, confidence: 'exact' })
    expect(p?.note).toContain('starter plan')
    expect(
      (await typeOf('expo', 'expo.project').estimate?.(eas(null).ctx, noDesired, null))?.confidence
    ).toBe('unknown')
  })
})

describe('github estimates', () => {
  const org = (plan: string | null, status = 200) =>
    ctxFor(
      'github',
      { owner: 'acme', auth_method: 'pat' },
      { token: 'test-secret-github' },
      () => ({
        status,
        body: plan
          ? { login: 'acme', plan: { name: plan, seats: 12, filled_seats: 9 } }
          : { message: 'Not Found' }
      })
    )

  it('estimate from recorded price answer: a repository adds no fixed charge, the plan seat price in the note', async () => {
    const e = await typeOf('github', 'github.repository').estimate?.(
      org('team').ctx,
      noDesired,
      null
    )
    expect(e).toMatchObject({
      basis: 'plan_price',
      confidence: 'exact',
      monthlyCents: 0,
      priceAsOf: '2026-11-26'
    })
    expect(e?.note).toContain('$4 per seat')
    expect(e?.note).toContain('12 seats')
    const free = await typeOf('github', 'github.repository').estimate?.(
      org('free').ctx,
      noDesired,
      null
    )
    expect(free?.note).toContain('Free plan')
  })

  it('a personal account has no readable plan: the repository is unknown', async () => {
    const e = await typeOf('github', 'github.repository').estimate?.(
      org(null, 404).ctx,
      noDesired,
      null
    )
    expect(e?.confidence).toBe('unknown')
  })

  it('a workflow is usage: the Linux minute price and what the plan includes', async () => {
    const e = await typeOf('github', 'github.workflow').estimate?.(org('team').ctx, noDesired, null)
    expect(e).toMatchObject({ basis: 'usage', confidence: 'usage_varies', monthlyCents: 0 })
    expect(e?.note).toContain('0.008')
    expect(e?.note).toContain('3,000')
    const blind = await typeOf('github', 'github.workflow').estimate?.(
      org(null, 404).ctx,
      noDesired,
      null
    )
    expect(blind?.confidence).toBe('usage_varies')
  })
})
