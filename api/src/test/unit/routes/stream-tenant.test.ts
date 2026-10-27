import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Admin GET /api/stream in cloud mode (H13): a stream hears only the tenant it was opened
 * under, and it ends when its account stops being an administrator.
 */
const state = vi.hoisted(() => ({ tenant: '', identityAdmin: true }))

vi.mock('../../../services/tenant-rooms.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/tenant-rooms.js')>()),
  currentTenantKey: () => state.tenant
}))
vi.mock('../../../middleware/authenticate.js', async (orig) => ({
  ...(await orig<typeof import('../../../middleware/authenticate.js')>()),
  requireAdmin: async (req: {
    headers: Record<string, unknown>
    user?: unknown
    isAdmin?: boolean
    authMethod?: string
  }) => {
    state.tenant = String(req.headers['x-test-tenant'] ?? '')
    req.user = { id: 'admin' }
    req.isAdmin = true
    req.authMethod = 'token'
    req.headers.authorization = 'Bearer tok'
  }
}))
vi.mock('../../../services/stream-ticket.js', () => ({
  recheckStreamIdentity: vi.fn(async (_r: unknown, _u: unknown, _b: unknown, last: unknown) => ({
    identity: state.identityAdmin ? (last as object) : { ...(last as object), isAdmin: false },
    reason: null
  }))
}))

let base = ''
let app: ReturnType<typeof Fastify>

function open(headers: Record<string, string> = {}) {
  const frames: Array<Record<string, unknown>> = []
  const raw: string[] = []
  const req = request(`${base}/stream`, { headers }, (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      raw.push(chunk)
      for (const line of chunk.split('\n'))
        if (line.startsWith('data: ') && line.includes('"type"'))
          frames.push(JSON.parse(line.slice(6)))
    })
  })
  req.end()
  return { frames, raw, close: () => req.destroy() }
}

async function until(fn: () => boolean, ms = 2000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const { streamRoutes } = await import('../../../routes/stream.js')
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(streamRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  vi.useRealTimers()
  await app.close()
})

describe('admin stream tenant isolation (H13)', () => {
  it('a tenant-A stream does not hear tenant B', async () => {
    const { broadcast } = await import('../../../routes/stream.js')
    const a = open({ 'x-test-tenant': 'A' })
    await new Promise((r) => setTimeout(r, 100))
    const ev = (collection: string) => ({
      type: 'update',
      collection,
      id: '1',
      timestamp: new Date().toISOString()
    })
    broadcast(ev('from_b'), 'B')
    broadcast(ev('from_a'), 'A')
    await until(() => a.frames.length >= 1)
    await new Promise((r) => setTimeout(r, 50))
    expect(a.frames.map((f) => f.collection)).toEqual(['from_a'])
    a.close()
  })

  it('ends the stream when the account is no longer an administrator', async () => {
    const s = open({ 'x-test-tenant': '' })
    await new Promise((r) => setTimeout(r, 100))
    state.identityAdmin = false
    vi.advanceTimersByTime(25_000)
    await until(() => s.raw.join('').includes('session.ended'))
    s.close()
  })
})
