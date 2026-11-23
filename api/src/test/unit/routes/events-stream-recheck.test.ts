import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * GET /api/events/stream re-reads the subscriber's identity every heartbeat: a permission the
 * role lost stops applying within one heartbeat, not when the connection ends.
 */
const state = vi.hoisted(() => ({ readable: new Set(['orders']), role: 'R1' }))

vi.mock('../../../middleware/authenticate.js', async (orig) => ({
  ...(await orig<typeof import('../../../middleware/authenticate.js')>()),
  authenticate: async (req: {
    user?: unknown
    authMethod?: string
    headers: Record<string, unknown>
  }) => {
    req.user = { id: 'U1', role: 'R1' }
    req.authMethod = 'token'
    req.headers.authorization = 'Bearer tok'
  }
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/permissions.js')>()),
  can: vi.fn(async (_user: { role: string }, _a: string, c: string) => state.readable.has(c))
}))
vi.mock('../../../services/stream-ticket.js', () => ({
  mintStreamTicket: vi.fn(),
  redeemStreamTicket: vi.fn(),
  loadStreamIdentity: vi.fn(),
  recheckStreamIdentity: vi.fn(async () => ({
    identity: { user: { id: 'U1', role: state.role }, isAdmin: false },
    reason: null
  }))
}))

import { publishSseEvent } from '../../../services/sse-hub.js'

let base = ''
let app: ReturnType<typeof Fastify>

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const { eventsStreamRoutes } = await import('../../../routes/events-stream.js')
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(eventsStreamRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  vi.useRealTimers()
  await app.close()
})

// Hub phase 6 final review (rest) Minor 3: no fixed sleeps — every wait is for something the
// stream itself says (its `: connected` line, the heartbeat's `: hb` written once the re-check is
// done, a sentinel event), with a generous deadline, so a loaded machine only makes it slower.
async function until(fn: () => boolean, ms = 10_000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('events stream permission re-check', () => {
  it('stops delivering a collection once the refreshed identity loses read on it', async () => {
    const got: string[] = []
    let connected = false
    let beats = 0
    const req = request(`${base}/stream`, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.startsWith(': connected')) connected = true
          if (line.startsWith(': hb')) beats++
          if (line.startsWith('data: ')) got.push(JSON.parse(line.slice(6)).item)
        }
      })
    })
    req.end()
    // Subscribed once the stream says so (it subscribes in the same turn it writes this line).
    await until(() => connected)
    publishSseEvent({ collection: 'orders', item: 'before', tenant: '' })
    await until(() => got.includes('before'))

    // The role changes; the next heartbeat refreshes the identity and drops cached answers. Its
    // `: hb` is written only once that re-check is done.
    state.role = 'R2'
    state.readable = new Set(['tasks'])
    vi.advanceTimersByTime(25_000)
    await until(() => beats >= 1)
    publishSseEvent({ collection: 'orders', item: 'after', tenant: '' })
    // A sentinel the new role may read, sent after: once it is here, 'after' would be too.
    publishSseEvent({ collection: 'tasks', item: 'sentinel', tenant: '' })
    await until(() => got.includes('sentinel'))
    expect(got).toEqual(['before', 'sentinel'])
    req.destroy()
  }, 60_000)
})
