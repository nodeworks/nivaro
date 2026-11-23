import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Admin GET /api/stream across processes (post-mortem 3.3, third review): other processes'
 * journaled writes arrive with their write time, raw writes stay out, and an admin API key
 * narrowed to named collections sees only those.
 */
vi.mock('../../../middleware/authenticate.js', async (orig) => ({
  ...(await orig<typeof import('../../../middleware/authenticate.js')>()),
  requireAdmin: async (req: {
    headers: Record<string, unknown>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const scoped = req.headers['x-test-key'] === 'scoped'
    req.user = scoped
      ? { id: 'svc', api_key_scopes: [{ collection: 'projects', actions: ['read'] }] }
      : { id: 'admin' }
    req.isAdmin = true
  }
}))

let base = ''
let app: ReturnType<typeof Fastify>

/** Open the stream and collect its `data:` frames; `connected` once the stream says so (it
 *  registers the client in the same turn it writes that line). */
function open(headers: Record<string, string> = {}) {
  const frames: Array<Record<string, unknown>> = []
  const state = { connected: false }
  const req = request(`${base}/stream`, { headers }, (res) => {
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.startsWith(': connected')) state.connected = true
        if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)))
      }
    })
  })
  req.end()
  return { frames, state, close: () => req.destroy() }
}

// Hub phase 6 final fix wave (CI green): no fixed sleeps. Every wait is for something the stream
// says (`: connected`, a sentinel frame sent last), with a generous deadline.
async function until(fn: () => boolean, ms = 20_000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(async () => {
  const { streamRoutes } = await import('../../../routes/stream.js')
  app = Fastify()
  await app.register(streamRoutes)
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await app.close()
})

describe('admin /api/stream hears other processes', () => {
  it('keeps to an API key’s collections, uses the write time, and leaves raw writes out', async () => {
    const { notifyJournalListeners } = await import('../../../services/journal-listeners.js')
    const all = open()
    const scoped = open({ 'x-test-key': 'scoped' })
    await until(() => all.state.connected && scoped.state.connected)
    const at = Date.parse('2026-10-23T12:00:00Z')
    const entry = (collection: string, extra: Record<string, unknown> = {}) => ({
      seq: 1,
      room: `collection:${collection}`,
      event: 'collection:update',
      payload: { collection, item: 1, action: 'update', ...extra }
    })
    notifyJournalListeners(entry('projects'), 'remote', at)
    notifyJournalListeners(entry('secrets'), 'remote', at)
    notifyJournalListeners(entry('projects', { source: 'raw' }), 'remote', at)
    // This process's own writes come from its hooks, never from its own journal entries.
    notifyJournalListeners(entry('projects'), 'local', at)
    // A sentinel both streams may read, sent last: once it is here, anything wrongly let through
    // above would be here too (one connection, frames in order).
    notifyJournalListeners(entry('projects', { item: 'end' }), 'remote', at)
    const ended = (f: Array<Record<string, unknown>>) => f.some((x) => x.id === 'end')
    await until(() => ended(all.frames) && ended(scoped.frames))
    all.frames.pop()
    scoped.frames.pop()
    expect(all.frames.map((f) => f.collection)).toEqual(['projects', 'secrets'])
    expect(all.frames[0].timestamp).toBe('2026-10-23T12:00:00.000Z')
    expect(scoped.frames.map((f) => f.collection)).toEqual(['projects'])
    all.close()
    scoped.close()
  }, 60_000)
})
