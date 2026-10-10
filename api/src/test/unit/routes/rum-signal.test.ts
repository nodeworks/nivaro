import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** POST /rum (#1371): a rage click or a dead-click burst is a replay signal. */

const h = vi.hoisted(() => ({ inserts: [] as unknown[], fire: vi.fn(async () => ({ sent: 1 })) }))

vi.mock('../../../db/index.js', () => ({
  db: () => ({
    insert: (rows: unknown) => {
      h.inserts.push(rows)
      return { catch: async () => {} }
    }
  })
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { id: 'U1' }
  },
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/replay-auto-signals.js', () => ({ fireReplaySignal: h.fire }))

import { rumRoutes } from '../../../routes/rum.js'

async function send(events: unknown[]) {
  const app = Fastify()
  await app.register(rumRoutes, { prefix: '/api/rum' })
  return app.inject({ method: 'POST', url: '/api/rum', payload: { events } })
}

beforeEach(() => {
  h.inserts = []
  h.fire.mockClear()
})

describe('POST /rum signals', () => {
  it('a rage click asks the person who raged to record', async () => {
    const res = await send([{ kind: 'rage', route: "/claims :: button 'Save'", duration_ms: 3 }])
    expect(res.json()).toEqual({ data: { accepted: 1 } })
    expect(h.fire).toHaveBeenCalledWith('rage-click', { userIds: ['U1'] })
  })

  it('accepts dead-click bursts as their own kind', async () => {
    await send([{ kind: 'dead', route: "/claims :: a 'Next'", duration_ms: 3 }])
    expect(h.fire).toHaveBeenCalledWith('dead-click', { userIds: ['U1'] })
    expect((h.inserts[0] as Array<{ kind: string }>)[0].kind).toBe('dead')
  })

  it('page timings are not signals', async () => {
    await send([{ kind: 'load', route: '/claims', duration_ms: 900 }])
    expect(h.fire).not.toHaveBeenCalled()
  })
})
