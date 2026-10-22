// #2841 GET /traffic-map/blast-radius?node=&window= — simulate a dependency down.
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sim = vi.hoisted(() => ({ calls: [] as unknown[][], answer: {} as unknown }))
const blast = vi.hoisted(() => ({ calls: [] as unknown[] }))

vi.mock('../../services/traffic-actions/simulate-down.js', async (orig) => ({
  ...(await orig<typeof import('../../services/traffic-actions/simulate-down.js')>()),
  simulateDown: async (...args: unknown[]) => {
    sim.calls.push(args)
    return sim.answer
  }
}))
vi.mock('../../services/traffic-actions/blast-radius.js', async (orig) => ({
  ...(await orig<typeof import('../../services/traffic-actions/blast-radius.js')>()),
  blastRadius: async (node: unknown) => {
    blast.calls.push(node)
    return { node: 'items/orders', screens: [] }
  }
}))

import { tmActionsRoutes } from './tm-actions.js'

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001'

async function app(): Promise<FastifyInstance> {
  const a = Fastify()
  a.addHook('preHandler', async (req) => {
    ;(req as unknown as { user: unknown }).user = { id: ADMIN }
  })
  await a.register(
    async (f) => tmActionsRoutes(f, { send: async () => ({ status: 201, body: {} }) }),
    {
      prefix: '/traffic-map'
    }
  )
  await a.ready()
  return a
}

beforeEach(() => {
  sim.calls = []
  sim.answer = { node: 'redis', routes: [] }
  blast.calls = []
})

describe('GET /blast-radius (simulate down)', () => {
  it('a dependency node simulates it down over 24 h by default', async () => {
    const a = await app()
    const res = await a.inject({ method: 'GET', url: '/traffic-map/blast-radius?node=redis' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ node: 'redis', routes: [] })
    expect(sim.calls[0][0]).toEqual({ id: 'redis', kind: 'cache' })
    expect(sim.calls[0][1]).toBe('24h')
    expect(sim.calls[0][2]).toMatchObject({ until: null, who: ADMIN, fresh: false })
  })

  it('a window turns a partner into a simulation; without one it stays the #2152 view', async () => {
    const a = await app()
    await a.inject({ method: 'GET', url: '/traffic-map/blast-radius?node=ext:4&window=7d' })
    expect(sim.calls[0][1]).toBe('7d')
    const res = await a.inject({
      method: 'GET',
      url: '/traffic-map/blast-radius?node=items/orders'
    })
    expect(res.statusCode).toBe(200)
    expect(blast.calls).toHaveLength(1)
    expect(sim.calls).toHaveLength(1)
  })

  it('passes a past end time through, clamped', async () => {
    const a = await app()
    const until = new Date(Date.now() - 2 * 3600_000).toISOString()
    await a.inject({
      method: 'GET',
      url: `/traffic-map/blast-radius?node=db&window=1h&until=${until}`
    })
    expect(typeof (sim.calls[0][2] as { until: unknown }).until).toBe('number')
  })

  it('refuses nodes it cannot simulate and unknown windows', async () => {
    const a = await app()
    const bad = await a.inject({ method: 'GET', url: '/traffic-map/blast-radius?node=k7' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('BLAST_NODE')
    const win = await a.inject({
      method: 'GET',
      url: '/traffic-map/blast-radius?node=db&window=30d'
    })
    expect(win.statusCode).toBe(400)
    expect(win.json().code).toBe('BLAST_WINDOW')
    const ent = await a.inject({
      method: 'GET',
      url: '/traffic-map/blast-radius?node=items/orders&window=24h'
    })
    expect(ent.statusCode).toBe(400)
    expect(sim.calls).toHaveLength(0)
  })

  it('an unknown partner is a 404', async () => {
    sim.answer = null
    const a = await app()
    const res = await a.inject({
      method: 'GET',
      url: '/traffic-map/blast-radius?node=ext:99&window=24h'
    })
    expect(res.statusCode).toBe(404)
  })
})
