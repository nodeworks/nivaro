import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A Teams/mail Approve link used to approve on GET — any link scanner that
// prefetched it decided for the approver. GET now only asks; the page's
// button POSTs the decision.
//
// Security audit H8: the card goes to a SHARED channel, so the link alone decides nothing —
// only the approver it names, signed in to Nivaro in that browser, can use it; once; 24 h.

vi.mock('../../../config.js', () => ({
  config: {
    SESSION_SECRET: 'message-actions-test-secret-0123456789abcdef',
    PUBLIC_URL: 'https://nivaro.test',
    ADMIN_URL: 'https://nivaro.test'
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
// Realtime round 9 (#21): the landing page reads where the approval stands now.
const PENDING = {
  status: 'pending',
  chain_name: 'Capital spend',
  step_label: 'Finance review',
  step_number: 1,
  step_count: 1,
  last: null,
  mine: null,
  waiting_on_holder: true
}
const linkState = { current: { ...PENDING } as Record<string, unknown> }
vi.mock('../../../services/approval-link-state.js', async (orig) => ({
  ...(await orig<object>()),
  loadApprovalLinkState: vi.fn(async () => linkState.current)
}))
// Who may read the approval's record (judged as the signed-in person): everyone but 'no-read'.
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (u: { id: string }) => (u.id === 'no-read' ? null : { id: '372789' }))
}))
vi.mock('../../../db/index.js', () => ({
  db: () => ({ where: () => ({ first: async () => undefined }) })
}))
vi.mock('../../../routes/approvals.js', () => ({
  applyApprovalDecision: vi.fn(async () => ({ ok: true }))
}))
// The signed-in person: the `x-test-session` header names the session user (no header = none).
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: Record<string, any>) => {
    const uid = req.session?.userId
    if (!uid) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id: uid, status: 'active', role: null }
    req.isAdmin = false
    req.authMethod = 'session'
  })
}))

// The pushed-widget recompute budget (security review L3): off = every recompute is over budget.
const budget = { open: true }
vi.mock('../../../services/widget-live.js', () => ({ takeBudget: () => budget.open }))

import { runWithTenantDb } from '../../../db/tenant-context.js'
import { applyApprovalDecision } from '../../../routes/approvals.js'
import {
  decisionPostFromOwnPage,
  emailDecisionLinks,
  linkPage,
  messageActionsRoutes,
  signActionToken,
  TOKEN_TTL_SECONDS,
  verifyActionToken
} from '../../../routes/message-actions.js'
import { loadApprovalLinkState } from '../../../services/approval-link-state.js'
import { BUSY, SignalStreamRoute } from '../../../services/public-signal-stream.js'

const mint = () =>
  signActionToken({
    action_id: 'approve',
    kind: 'approval',
    ref_id: '42',
    user: 'u-1',
    collection: 'workflows',
    item: '372789'
  })

function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
    set: vi.fn(async (k: string, v: string, ..._rest: unknown[]) => {
      if (store.has(k)) return null
      store.set(k, v)
      return 'OK'
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0))
  }
}

async function app(redis = fakeRedis()) {
  const a = Fastify({ logger: false })
  a.decorate('redis', redis as never)
  a.decorateRequest('session', null as never)
  a.addHook('onRequest', async (req) => {
    const uid = req.headers['x-test-session']
    ;(req as unknown as { session: Record<string, unknown> }).session = {
      userId: typeof uid === 'string' ? uid : undefined
    }
  })
  await a.register(messageActionsRoutes)
  return a
}

const post = (token: string, session?: string) => ({
  method: 'POST' as const,
  url: '/callback',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    // The landing page's own button (security review L5).
    'sec-fetch-site': 'same-origin',
    ...(session ? { 'x-test-session': session } : {})
  },
  payload: `token=${encodeURIComponent(token)}`
})

afterEach(() => {
  vi.clearAllMocks()
  linkState.current = { ...PENDING }
})

describe('live landing page (rt9 #21)', () => {
  const decided = {
    ...PENDING,
    status: 'approved',
    step_label: null,
    waiting_on_holder: false,
    last: {
      decision: 'approved',
      by: 'Beth Lee',
      at: '2026-11-14T15:42:00.000Z',
      step_label: 'Finance review',
      mine: false
    }
  }

  it('tells an anonymous link holder only that it was decided — no names, no times', async () => {
    linkState.current = decided
    const res = await (await app()).inject({
      method: 'GET',
      url: `/callback?token=${encodeURIComponent(mint())}`
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('This approval has already been decided')
    expect(res.body).not.toContain('Beth Lee')
    expect(res.body).not.toContain('<time')
    expect(res.body).not.toContain('<form')
    // Final answer: no live stream.
    expect(res.body).toContain('var STREAM=null')
  })

  it('an anonymous holder of a pending link elsewhere sees only the step label', async () => {
    linkState.current = { ...PENDING, waiting_on_holder: false, last: decided.last }
    const res = await (await app()).inject({
      method: 'GET',
      url: `/callback?token=${encodeURIComponent(mint())}`
    })
    expect(res.body).toContain('Waiting on Finance review')
    expect(res.body).not.toContain('Beth Lee')
  })

  it('names who decided and when once signed in as someone who can read the record', async () => {
    linkState.current = decided
    const res = await (await app()).inject({
      method: 'GET',
      url: `/callback?token=${encodeURIComponent(mint())}`,
      headers: { 'x-test-session': 'colleague' }
    })
    expect(res.body).toContain('Already approved')
    expect(res.body).toContain('Beth Lee')
    expect(res.body).toContain('<time datetime="2026-11-14T15:42:00.000Z"')
  })

  it('keeps names from a signed-in person who cannot read the record', async () => {
    linkState.current = decided
    const res = await (await app()).inject({
      method: 'GET',
      url: `/callback?token=${encodeURIComponent(mint())}`,
      headers: { 'x-test-session': 'no-read' }
    })
    expect(res.body).toContain('This approval has already been decided')
    expect(res.body).not.toContain('Beth Lee')
  })

  it('a pending page listens on its own token-scoped stream', async () => {
    const token = mint()
    const res = await (await app()).inject({
      method: 'GET',
      url: `/callback?token=${encodeURIComponent(token)}`,
      headers: { 'x-test-session': 'u-1' }
    })
    expect(res.body).toContain(`stream?token=${encodeURIComponent(token)}`)
    expect(String(res.headers['content-security-policy'])).toMatch(/script-src 'nonce-/)
  })

  it('refuses a double decision gracefully: the page says who decided, nothing is applied', async () => {
    linkState.current = decided
    const res = await (await app()).inject(post(mint(), 'u-1'))
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('Already approved')
    expect(res.body).toContain('Beth Lee')
    expect(applyApprovalDecision).not.toHaveBeenCalled()
  })

  it('a decision raced by someone else answers with the new state, not an error', async () => {
    vi.mocked(applyApprovalDecision).mockImplementationOnce(async () => {
      linkState.current = decided
      return { ok: false, status: 409, error: 'Instance is already approved' } as never
    })
    const res = await (await app()).inject(post(mint(), 'u-1'))
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('Already approved')
  })

  it('the stream refuses tampered and expired tokens', async () => {
    const a = await app()
    const token = mint()
    const forged = `${token.split('.')[0]}.AAAA`
    expect(
      (await a.inject({ method: 'GET', url: `/stream?token=${encodeURIComponent(forged)}` }))
        .statusCode
    ).toBe(404)
    const expired = signActionToken({
      action_id: 'approve',
      kind: 'approval',
      ref_id: '42',
      user: 'u-1',
      exp: Math.floor(Date.now() / 1000) - 10
    })
    expect(
      (await a.inject({ method: 'GET', url: `/stream?token=${encodeURIComponent(expired)}` }))
        .statusCode
    ).toBe(404)
    expect(
      (
        await a.inject({
          method: 'GET',
          url: `/callback?token=${encodeURIComponent(expired)}`,
          headers: { 'x-test-session': 'u-1' }
        })
      ).statusCode
    ).toBe(401)
  })

  it('email links live a week and name one approver', async () => {
    const { emailDecisionLinks, EMAIL_TOKEN_TTL_SECONDS } = await import(
      '../../../routes/message-actions.js'
    )
    const links = emailDecisionLinks({
      instance: { id: 42, collection: 'workflows', item: '9' },
      userId: 'u-1'
    })
    const t = decodeURIComponent(links.approve_url.split('token=')[1])
    const p = verifyActionToken(t)
    expect(p).toMatchObject({ action_id: 'approve', user: 'u-1', ref_id: '42' })
    const ttl = (p?.exp ?? 0) - Math.floor(Date.now() / 1000)
    expect(ttl).toBeGreaterThan(EMAIL_TOKEN_TTL_SECONDS - 5)
    expect(
      verifyActionToken(decodeURIComponent(links.reject_url.split('token=')[1]))?.action_id
    ).toBe('reject')
  })
})

describe('decision tokens', () => {
  it('live 24 hours and carry a one-time id', () => {
    const p = verifyActionToken(mint())
    expect(p?.jti).toMatch(/^[0-9a-f-]{36}$/)
    const ttl = (p?.exp ?? 0) - Math.floor(Date.now() / 1000)
    expect(ttl).toBeLessThanOrEqual(TOKEN_TTL_SECONDS)
    expect(ttl).toBeGreaterThan(TOKEN_TTL_SECONDS - 5)
  })
})

describe('GET /callback (decision link)', () => {
  it('sends a signed-out visitor through sign-in and back, deciding nothing', async () => {
    const token = mint()
    const res = await (await app()).inject({
      method: 'GET',
      url: `/callback?token=${encodeURIComponent(token)}`
    })
    expect(res.statusCode).toBe(302)
    const loc = String(res.headers.location)
    expect(loc).toMatch(/^https:\/\/nivaro\.test\/api\/auth\/login\?returnTo=/)
    expect(decodeURIComponent(loc)).toContain('/api/message-actions/callback?token=')
    expect(applyApprovalDecision).not.toHaveBeenCalled()
  })

  it('shows the approver a confirm page and decides nothing (a prefetching scanner)', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: `/callback?token=${encodeURIComponent(mint())}`,
      headers: { 'x-test-session': 'U-1' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<form method="post"')
    expect(applyApprovalDecision).not.toHaveBeenCalled()
  })

  it('tells anyone else in the channel the link is not theirs', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: `/callback?token=${encodeURIComponent(mint())}`,
      headers: { 'x-test-session': 'someone-else' }
    })
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('<form')
  })
})

describe('POST /callback (the confirm button)', () => {
  it('applies the decision for the signed-in approver, as that session user', async () => {
    const res = await (await app()).inject(post(mint(), 'u-1'))
    expect(res.statusCode).toBe(200)
    expect(applyApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 42,
        decision: 'approved',
        user: expect.objectContaining({ id: 'u-1' })
      })
    )
  })

  it('refuses without a session (no redirect on POST) and for another person', async () => {
    const a = await app()
    expect((await a.inject(post(mint()))).statusCode).toBe(401)
    expect((await a.inject(post(mint(), 'intruder'))).statusCode).toBe(403)
    expect(applyApprovalDecision).not.toHaveBeenCalled()
  })

  it('works once: the same link a second time decides nothing', async () => {
    const a = await app()
    const token = mint()
    expect((await a.inject(post(token, 'u-1'))).statusCode).toBe(200)
    const again = await a.inject(post(token, 'u-1'))
    expect(again.statusCode).toBe(409)
    expect(applyApprovalDecision).toHaveBeenCalledTimes(1)
  })

  it('a failed decision leaves the link usable again', async () => {
    vi.mocked(applyApprovalDecision).mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: 'boom'
    } as never)
    const a = await app()
    const token = mint()
    expect((await a.inject(post(token, 'u-1'))).statusCode).toBe(500)
    expect((await a.inject(post(token, 'u-1'))).statusCode).toBe(200)
  })

  it('refuses a forged token', async () => {
    const token = mint()
    const res = await (await app()).inject(post(`${token.split('.')[0]}.AAAA`, 'u-1'))
    expect(res.statusCode).toBe(401)
    expect(applyApprovalDecision).not.toHaveBeenCalled()
  })

  it('refuses an old token without a one-time id', async () => {
    const legacy = signActionToken({
      action_id: 'approve',
      kind: 'approval',
      ref_id: '42',
      user: 'u-1',
      jti: ''
    })
    const res = await (await app()).inject(post(legacy, 'u-1'))
    expect(res.statusCode).toBe(410)
    expect(applyApprovalDecision).not.toHaveBeenCalled()
  })
})

/** Run `fn` inside a cloud tenant's context (as the tenant middleware does). */
const inTenant = <T>(tenantId: string, origin: string | undefined, fn: () => T | Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb(
      {} as never,
      tenantId,
      () => void Promise.resolve().then(fn).then(resolve, reject),
      tenantId,
      origin
    )
  )

describe('tenant binding (security review M1)', () => {
  it('a token minted for one cloud tenant is refused on another and self-hosted', async () => {
    const token = await inTenant('tenant-a', 'https://a.nivaro.dev', () => mint())
    expect(await inTenant('tenant-a', undefined, () => verifyActionToken(token))).not.toBeNull()
    expect(await inTenant('tenant-b', undefined, () => verifyActionToken(token))).toBeNull()
    expect(verifyActionToken(token)).toBeNull()
  })

  it('a self-hosted token is refused inside any tenant', async () => {
    const token = mint()
    expect(verifyActionToken(token)).not.toBeNull()
    expect(await inTenant('tenant-a', undefined, () => verifyActionToken(token))).toBeNull()
  })

  it('a cross-tenant decision POST decides nothing', async () => {
    const token = await inTenant('tenant-a', undefined, () => mint())
    const a = await app()
    const res = await inTenant('tenant-b', undefined, () => a.inject(post(token, 'u-1')))
    expect(res.statusCode).toBe(401)
    expect(applyApprovalDecision).not.toHaveBeenCalled()
  })
})

describe('links name the tenant origin (security review L4)', () => {
  it('email decision links and the record link use the tenant origin, not PUBLIC_URL', async () => {
    const links = await inTenant('tenant-a', 'https://acme.nivaro.dev', () =>
      emailDecisionLinks({ instance: { id: 9, collection: 'orders', item: '5' }, userId: 'u-1' })
    )
    expect(links.approve_url.startsWith('https://acme.nivaro.dev/api/message-actions/')).toBe(true)
    const html = await inTenant('tenant-a', 'https://acme.nivaro.dev', () => {
      const token = mint()
      return linkPage({
        token,
        payload: verifyActionToken(token)!,
        state: { ...PENDING } as never,
        holderHere: true,
        spent: false,
        liveMode: 'normal',
        nonce: 'n'
      })
    })
    expect(html).toContain('https://acme.nivaro.dev/collections/workflows/372789')
    expect(html).not.toContain('nivaro.test')
  })

  it('self-hosted links keep the configured address', () => {
    const links = emailDecisionLinks({
      instance: { id: 9, collection: 'orders', item: '5' },
      userId: 'u-1'
    })
    expect(links.approve_url.startsWith('https://nivaro.test/api/message-actions/')).toBe(true)
  })
})

describe('decision POST origin check (security review L5)', () => {
  const own = ['https://nivaro.test']
  it('fetch metadata decides when present: only same-origin passes', () => {
    expect(decisionPostFromOwnPage({ 'sec-fetch-site': 'same-origin', origin: 'null' }, own)).toBe(
      true
    )
    for (const site of ['same-site', 'cross-site', 'none'])
      expect(
        decisionPostFromOwnPage({ 'sec-fetch-site': site, origin: 'https://nivaro.test' }, own)
      ).toBe(false)
  })

  it('without fetch metadata, Origin must be ours; null or absent is refused', () => {
    expect(decisionPostFromOwnPage({ origin: 'https://nivaro.test' }, own)).toBe(true)
    expect(decisionPostFromOwnPage({ origin: 'https://evil.example' }, own)).toBe(false)
    expect(decisionPostFromOwnPage({ origin: 'https://sub.nivaro.test' }, own)).toBe(false)
    expect(decisionPostFromOwnPage({ origin: 'null' }, own)).toBe(false)
    expect(decisionPostFromOwnPage({}, own)).toBe(false)
  })

  it('a form posted from another site decides nothing', async () => {
    const a = await app()
    const req = post(mint(), 'u-1')
    const res = await a.inject({
      ...req,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-test-session': 'u-1',
        'sec-fetch-site': 'same-site',
        origin: 'https://other.nivaro.test'
      }
    })
    expect(res.statusCode).toBe(403)
    expect(applyApprovalDecision).not.toHaveBeenCalled()
    const noHeaders = await a.inject({
      ...req,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-session': 'u-1' }
    })
    expect(noHeaders.statusCode).toBe(403)
    // Our own page's button (Origin: null under no-referrer, fetch metadata same-origin) decides.
    const own = await a.inject({
      ...req,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-test-session': 'u-1',
        'sec-fetch-site': 'same-origin',
        origin: 'null'
      }
    })
    expect(own.statusCode).toBe(200)
    expect(applyApprovalDecision).toHaveBeenCalledTimes(1)
  })
})

describe('stream recomputes are budgeted (security review L3)', () => {
  it('an over-budget recompute answers BUSY and reads nothing', async () => {
    let subject: { signature(): Promise<string | null> } | null = null
    const spy = vi
      .spyOn(SignalStreamRoute.prototype, 'serve')
      .mockImplementation(async (_req, reply, opts) => {
        const r = await opts.open()
        if (r.ok) subject = r.subject
        void reply.send({ ok: true })
      })
    try {
      const token = signActionToken({
        action_id: 'approve',
        kind: 'approval',
        ref_id: '77',
        user: 'u-budget',
        collection: 'workflows',
        item: '1'
      })
      await (await app()).inject({
        method: 'GET',
        url: `/stream?token=${encodeURIComponent(token)}`
      })
      expect(subject).not.toBeNull()
      vi.mocked(loadApprovalLinkState).mockClear()
      budget.open = false
      expect(await subject!.signature()).toBe(BUSY)
      expect(loadApprovalLinkState).not.toHaveBeenCalled()
      budget.open = true
      expect(await subject!.signature()).not.toBe(BUSY)
      expect(loadApprovalLinkState).toHaveBeenCalledTimes(1)
    } finally {
      budget.open = true
      spy.mockRestore()
    }
  })
})
