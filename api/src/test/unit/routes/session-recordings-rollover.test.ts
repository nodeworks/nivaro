import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * POST /session-recordings/:id/events at the size cap: the session rolls over
 * into a next part and the chunk is stored there, answered 200 — the recorder
 * never sees a refusal and nothing is lost. Later chunks posted to the id the
 * recorder knows follow the chain to its newest part. A one-shot clip still
 * stops with 409 size_cap.
 */

const H = '11111111-1111-4111-8111-111111111111'
const N = '22222222-2222-4222-8222-222222222222'

type Rec = {
  id: string
  user: string
  app: string | null
  meta: string | null
  byte_size: number
  truncated: boolean
  ended_at: Date | null
}

const h = vi.hoisted(() => ({
  recs: new Map<string, Rec>(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updates: [] as Array<{
    table: string
    where: Record<string, unknown>
    patch: Record<string, unknown>
  }>,
  chain: [] as Rec[],
  hasSeq: false,
  rolled: null as { id: string; byte_size: number } | null,
  newest: null as Rec | null
}))

vi.mock('../../../db/index.js', () => {
  const db = vi.fn((table: string) => {
    const where: Record<string, unknown> = {}
    const q: Record<string, unknown> = {}
    q.where = vi.fn((w: unknown) => {
      if (w && typeof w === 'object') Object.assign(where, w)
      return q
    })
    for (const m of ['whereNull', 'modify', 'orderBy']) q[m] = vi.fn(() => q)
    q.first = vi.fn(async () =>
      table === 'nivaro_session_recordings' ? h.recs.get(String(where.id)) : undefined
    )
    q.insert = vi.fn(async (row: Record<string, unknown>) => {
      h.inserts.push({ table, row })
    })
    q.update = vi.fn(async (patch: Record<string, unknown>) => {
      h.updates.push({ table, where: { ...where }, patch })
      return 1
    })
    return q
  })
  ;(db as unknown as Record<string, unknown>).raw = vi.fn((sql: string) => ({ sql }))
  return { db }
})

vi.mock('../../../services/session-recording-chain.js', async (orig) => {
  const actual = await orig<typeof import('../../../services/session-recording-chain.js')>()
  return {
    ...actual,
    chainParts: vi.fn(async () => h.chain),
    chainHasSeq: vi.fn(async () => h.hasSeq),
    rollOver: vi.fn(async () => h.rolled),
    newestPart: vi.fn(async () => h.newest)
  }
})
vi.mock('../../../services/session-replay-cost.js', () => ({
  chunkMeta: () => ({ route: '/', build: '', retries: 0 }),
  dailyCapStatus: async () => ({ reached: false, cap_bytes: null, used_bytes: 0 }),
  noteChunk: vi.fn()
}))
vi.mock('../../../services/session-replay-index.js', () => ({ scheduleReplayIndex: vi.fn() }))
vi.mock('../../../services/session-replay-stats.js', () => ({
  recordChunkStats: vi.fn(async () => {})
}))
vi.mock('../../../services/session-replay-storage.js', () => ({
  ensureRecordingHot: vi.fn(async () => ({ state: 'hot' })),
  deleteColdObject: vi.fn(async () => {}),
  purgeColdObjects: vi.fn(async () => 0)
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async () => undefined,
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { id: 'U1' }
  },
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { id: 'ADMIN' }
  }
}))

import { sessionRecordingRoutes } from '../../../routes/session-recordings.js'
import { rollOver } from '../../../services/session-recording-chain.js'

async function post(id: string, seq: number) {
  const app = Fastify()
  await app.register(sessionRecordingRoutes, { prefix: '/api/session-recordings' })
  const res = await app.inject({
    method: 'POST',
    url: `/api/session-recordings/${id}/events`,
    payload: { seq, events: [{ type: 3, timestamp: 1, data: { source: 1 } }] }
  })
  return { status: res.statusCode, body: res.json() }
}

const eventsInserted = () => h.inserts.filter((i) => i.table === 'nivaro_session_events')

const rec = (over: Partial<Rec>): Rec => ({
  id: H,
  user: 'U1',
  app: 'efp',
  meta: null,
  byte_size: 0,
  truncated: false,
  ended_at: null,
  ...over
})

beforeEach(() => {
  h.recs.clear()
  h.inserts = []
  h.updates = []
  h.chain = []
  h.hasSeq = false
  h.rolled = null
  h.newest = null
  vi.mocked(rollOver).mockClear()
})

describe('chunk at the size cap', () => {
  it('rolls over and stores the chunk in the next part, answered 200', async () => {
    h.recs.set(H, rec({ byte_size: 14_999_990 }))
    h.rolled = { id: N, byte_size: 500 }
    const r = await post(H, 7)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ data: { ok: true } })
    expect(rollOver).toHaveBeenCalledTimes(1)
    expect(eventsInserted()).toEqual([
      { table: 'nivaro_session_events', row: expect.objectContaining({ recording: N, seq: 7 }) }
    ])
    // Nothing marked truncated.
    expect(h.updates.some((u) => u.patch.truncated === true)).toBe(false)
  })

  it('follows a roll-over another request made first', async () => {
    h.recs.set(H, rec({ byte_size: 14_999_990 }))
    h.rolled = null
    h.newest = rec({ id: N, byte_size: 300 })
    const r = await post(H, 8)
    expect(r.status).toBe(200)
    expect(eventsInserted()[0].row).toMatchObject({ recording: N, seq: 8 })
  })

  it('still stops a one-shot clip with 409 size_cap', async () => {
    h.recs.set(H, rec({ app: 'error-clip', byte_size: 14_999_990 }))
    const r = await post(H, 3)
    expect(r.status).toBe(409)
    expect(r.body.reason).toBe('size_cap')
    expect(rollOver).not.toHaveBeenCalled()
    expect(eventsInserted()).toEqual([])
  })
})

describe('chunks after a roll-over', () => {
  it('go to the newest part when posted to the id the recorder knows', async () => {
    const head = rec({ ended_at: new Date(), meta: JSON.stringify({ parts: 2 }) })
    const next = rec({
      id: N,
      meta: JSON.stringify({ chain: H, continues: H, part: 2 }),
      byte_size: 10
    })
    h.recs.set(H, head)
    h.chain = [head, next]
    const r = await post(H, 9)
    expect(r.status).toBe(200)
    expect(eventsInserted()[0].row).toMatchObject({ recording: N, seq: 9 })
  })

  it('count a seq an earlier part already holds as a duplicate', async () => {
    const head = rec({ ended_at: new Date(), meta: JSON.stringify({ parts: 2 }) })
    h.recs.set(H, head)
    h.chain = [head, rec({ id: N, byte_size: 10 })]
    h.hasSeq = true
    const r = await post(H, 5)
    expect(r.status).toBe(200)
    expect(r.body.data.duplicate).toBe(true)
    expect(eventsInserted()).toEqual([])
  })

  it('stay refused once the session has really ended', async () => {
    const head = rec({ ended_at: new Date() })
    h.recs.set(H, head)
    h.chain = [head]
    const r = await post(H, 5)
    expect(r.status).toBe(409)
  })
})
