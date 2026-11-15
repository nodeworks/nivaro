import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Realtime round 9 (#22): /form-status/:token — public, token-scoped, nothing internal.

vi.mock('../../../config.js', () => ({
  config: {
    SESSION_SECRET: 'form-status-route-test-secret-0123456789abcdef',
    PUBLIC_URL: 'https://nivaro.test'
  }
}))

const resolve = vi.fn()
const status = vi.fn()
vi.mock('../../../services/submission-status.js', async (orig) => ({
  ...(await orig<object>()),
  resolveStatusLink: (t: string) => resolve(t),
  loadPublicStatus: (l: unknown) => status(l)
}))

// The pushed-widget recompute budget (security review L3): off = every recompute is over budget.
const budget = { open: true }
vi.mock('../../../services/widget-live.js', () => ({ takeBudget: () => budget.open }))

import { formStatusPublicRoutes } from '../../../routes/form-status.js'
import { BUSY, SignalStreamRoute } from '../../../services/public-signal-stream.js'

const LINK = {
  submissionId: 'sub-a',
  createdAt: '2026-11-14T15:00:00.000Z',
  formName: 'Site access request',
  collection: 'requests',
  item: '101',
  formId: 'form-1',
  createdBy: 'creator-1',
  cfg: {}
}

async function app(redis: unknown = null) {
  const a = Fastify({ logger: false })
  a.decorate('redis', redis as never)
  await a.register(formStatusPublicRoutes)
  return a
}

afterEach(() => vi.clearAllMocks())

describe('GET /form-status/:token', () => {
  it('answers 404 with a plain page for a token that does not resolve', async () => {
    resolve.mockResolvedValue(null)
    const res = await (await app()).inject({ method: 'GET', url: '/form-status/forged.token' })
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('This link is not valid')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).not.toContain('<script')
    expect(status).not.toHaveBeenCalled()
  })

  it('shows only the mapped stage — no record values, no ids', async () => {
    resolve.mockResolvedValue(LINK)
    status.mockResolvedValue({ stage: 'in_review', label: 'Being looked at', gone: false })
    const res = await (await app()).inject({ method: 'GET', url: '/form-status/good.token' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Being looked at')
    expect(res.body).toContain('Site access request')
    expect(res.body).not.toContain('creator-1')
    expect(res.body).not.toContain('sub-a')
    expect(res.body).not.toContain('requests')
    expect(String(res.headers['content-security-policy'])).toMatch(/script-src 'nonce-/)
    // Live while it can still change.
    expect(res.body).toContain('/form-status/good.token/stream')
  })

  it('stops listening once decided', async () => {
    resolve.mockResolvedValue(LINK)
    status.mockResolvedValue({ stage: 'decided', label: 'Approved', gone: false })
    const res = await (await app()).inject({ method: 'GET', url: '/form-status/good.token' })
    expect(res.body).toContain('Approved')
    expect(res.body).toContain('var STREAM=null')
  })

  it('rate-limits page loads per address', async () => {
    resolve.mockResolvedValue(LINK)
    status.mockResolvedValue({ stage: 'received', label: 'Received', gone: false })
    const counts = new Map<string, number>()
    const redis = {
      // windowed-limit's Redis path: count per key.
      eval: vi.fn(async (_s: string, _n: number, key: string) => {
        const n = (counts.get(key) ?? 0) + 1
        counts.set(key, n)
        return n
      })
    }
    const a = await app(redis)
    const codes: number[] = []
    for (let i = 0; i < 122; i++) {
      codes.push((await a.inject({ method: 'GET', url: '/form-status/good.token' })).statusCode)
    }
    expect(codes.slice(0, 120).every((c) => c === 200)).toBe(true)
    expect(codes.slice(120)).toEqual([429, 429])
    // The counter is per address, never per token (a guesser rotating tokens is still capped).
    expect([...counts.keys()].every((k) => !k.includes('good.token'))).toBe(true)
  })
})

describe('GET /form-status/:token/stream', () => {
  it('refuses a token that does not resolve, before any stream opens', async () => {
    resolve.mockResolvedValue(null)
    const res = await (await app()).inject({ method: 'GET', url: '/form-status/x.y/stream' })
    expect(res.statusCode).toBe(404)
  })
})

describe('stream recomputes are budgeted (security review L3)', () => {
  it('an over-budget recompute answers BUSY and reads nothing', async () => {
    resolve.mockResolvedValue(LINK)
    status.mockResolvedValue({ stage: 'in_review', label: 'Being looked at', gone: false })
    let subject: { signature(): Promise<string | null> } | null = null
    const spy = vi
      .spyOn(SignalStreamRoute.prototype, 'serve')
      .mockImplementation(async (_req, reply, opts) => {
        const r = await opts.open()
        if (r.ok) subject = r.subject
        void reply.send({ ok: true })
      })
    try {
      await (await app()).inject({ method: 'GET', url: '/form-status/budget.token/stream' })
      expect(subject).not.toBeNull()
      budget.open = false
      expect(await subject!.signature()).toBe(BUSY)
      expect(status).not.toHaveBeenCalled()
      budget.open = true
      expect(await subject!.signature()).not.toBe(BUSY)
      expect(status).toHaveBeenCalledTimes(1)
    } finally {
      budget.open = true
      spy.mockRestore()
    }
  })
})
