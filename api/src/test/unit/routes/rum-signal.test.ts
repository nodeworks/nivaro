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

import { rumRoutes, summarizeWidgets } from '../../../routes/rum.js'

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

const ROLE = '0AC9B6D2-1111-2222-3333-444455556666'

describe('POST /rum widget timing (#1353)', () => {
  it('stores catalog key + role in the route and fetch/paint in existing columns', async () => {
    const res = await send([
      {
        kind: 'widget',
        widget: 'my-requests',
        role: ROLE.toLowerCase(),
        fetch_ms: 120,
        paint_ms: 30
      }
    ])
    expect(res.json()).toEqual({ data: { accepted: 1 } })
    const row = (h.inserts[0] as Array<Record<string, unknown>>)[0]
    expect(row).toMatchObject({
      kind: 'widget',
      route: `widget:my-requests@${ROLE}`,
      ttfb_ms: 120,
      fcp_ms: 30,
      duration_ms: 150
    })
    expect(h.fire).not.toHaveBeenCalled()
  })

  it('drops widget events with a malformed key or no fetch time', async () => {
    const res = await send([
      { kind: 'widget', widget: 'a b<script>', fetch_ms: 1, paint_ms: 1 },
      { kind: 'widget', widget: 'ok', paint_ms: 1 }
    ])
    expect(res.json()).toEqual({ data: { accepted: 0 } })
  })

  it('an unknown role is stored as no role', async () => {
    await send([{ kind: 'widget', widget: 'ok', role: 'nope', fetch_ms: 5, paint_ms: 5 }])
    expect((h.inserts[0] as Array<{ route: string }>)[0].route).toBe('widget:ok@-')
  })
})

describe('summarizeWidgets', () => {
  it('ranks keys by p75 total, slowest first, across roles', () => {
    const row = (key: string, role: string, f: number, p: number) => ({
      route: `widget:${key}@${role}`,
      ttfb_ms: f,
      fcp_ms: p,
      duration_ms: f + p
    })
    const out = summarizeWidgets([
      row('fast', ROLE, 10, 5),
      row('slow', ROLE, 900, 100),
      row('slow', '-', 700, 50),
      { route: '/not-a-widget', ttfb_ms: 1, fcp_ms: 1, duration_ms: 2 }
    ])
    expect(out.map((r) => r.key)).toEqual(['slow', 'fast'])
    expect(out[0]).toMatchObject({ samples: 2, total_p75: 1000 })
  })
})
