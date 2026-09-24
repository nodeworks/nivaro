import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same route-harness idiom as integration-partners.test.ts: mock the admin
// gate + db module before importing the route, so its GET routes are
// reachable with no real auth/DB stack. `services/external-apis.js` is
// DELIBERATELY left un-mocked here — the whole point of these tests is that
// `serializeLog()` runs the REAL `maskHeaders()` on the way out, so a stored
// raw secret can never reach the response regardless of what wrote it.
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  }),
  authenticate: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { externalApisRoutes } from '../../../routes/external-apis.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(externalApisRoutes)
  return app
}

afterEach(() => vi.clearAllMocks())

const RAW_LOG_ROW = {
  id: 1,
  api_id: 9,
  endpoint_id: null,
  triggered_by: 'test',
  method: 'GET',
  url: 'https://partner.example/status',
  // Never landed the write-side mask (a row written before that fix, or by
  // a caller that hands headers straight through) — MUST NOT reach the
  // response regardless.
  request_headers: JSON.stringify({ Authorization: 'Bearer raw-secret-token' }),
  request_body: null,
  response_status: 200,
  response_headers: JSON.stringify({ 'set-cookie': 'sid=raw-session-id' }),
  response_body: '{}',
  duration_ms: 12,
  error: null,
  user_id: null,
  created_at: new Date('2026-09-23T00:00:00.000Z')
}

type Chain = Record<string, ReturnType<typeof vi.fn>>

function makeSingleRowChain(overrides: Partial<{ first: unknown }> = {}): Chain {
  const chain: Chain = {}
  for (const m of ['where', 'orderBy', 'limit', 'offset']) chain[m] = vi.fn(() => chain)
  chain.first = vi.fn(() => Promise.resolve(overrides.first ?? undefined))
  return chain
}

describe('GET /logs/:logId re-masks every reader of nivaro_external_api_logs (Task 15e fix)', () => {
  it('masks a raw stored Authorization + set-cookie header on read', async () => {
    const chain = makeSingleRowChain({ first: RAW_LOG_ROW })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_external_api_logs') return chain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/logs/1' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.request_headers.Authorization).toBe('Bearer ••••••')
    expect(d.response_headers['set-cookie']).toBe('••••••')
    // The bodies themselves are untouched — masking is headers-only.
    expect(d.response_body).toBe('{}')
    await app.close()
  })

  it('a row with no stored headers stays null, not an empty object', async () => {
    const chain = makeSingleRowChain({ first: { ...RAW_LOG_ROW, request_headers: null } })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_external_api_logs') return chain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/logs/1' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.request_headers).toBeNull()
    await app.close()
  })

  it('404s an unknown log id', async () => {
    const chain = makeSingleRowChain({ first: undefined })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_external_api_logs') return chain
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/logs/999' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

describe('GET /:id/logs (the list route) re-masks headers too', () => {
  it('masks the same raw secrets in the list body', async () => {
    let logsCallCount = 0
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_external_apis') {
        const chain: Chain = { where: vi.fn(() => chain) }
        chain.first = vi.fn().mockResolvedValue({ id: 9 })
        return chain
      }
      if (table === 'nivaro_external_api_logs') {
        logsCallCount++
        if (logsCallCount === 1) {
          // Rows query: awaited directly (never `.select()`d) — `.offset()`
          // is its own last call, so it can just BE the promise instead of
          // going through a `.then` property on a plain object.
          const chain: Record<string, unknown> = {}
          for (const m of ['where', 'orderBy', 'limit']) chain[m] = vi.fn(() => chain)
          chain.offset = vi.fn(() => Promise.resolve([RAW_LOG_ROW]))
          return chain
        }
        // Count query.
        const chain: Chain = { where: vi.fn(() => chain), count: vi.fn(() => chain) }
        chain.first = vi.fn().mockResolvedValue({ total: 1 })
        return chain
      }
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/9/logs' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data[0]
    expect(d.request_headers.Authorization).toBe('Bearer ••••••')
    expect(d.response_headers['set-cookie']).toBe('••••••')
    await app.close()
  })
})
