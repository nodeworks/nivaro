import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * POST /session-recordings/:id/events (#1369): recorders retry a chunk under
 * the same seq, so a seq the recording already holds must answer ok without a
 * second row or double-counted bytes.
 */

const h = vi.hoisted(() => ({
  recording: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
  inserts: [] as unknown[],
  updates: [] as unknown[],
  stats: [] as Array<[string, unknown[]]>
}))

vi.mock('../../../db/index.js', () => {
  const db = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull']) chain[m] = vi.fn(() => chain)
    chain.first = vi.fn(async () =>
      table === 'nivaro_session_recordings' ? h.recording : h.existing
    )
    chain.insert = vi.fn(async (row: unknown) => {
      h.inserts.push(row)
      return [1]
    })
    chain.update = vi.fn(async (row: unknown) => {
      h.updates.push(row)
      return 1
    })
    return chain
  })
  ;(db as unknown as Record<string, unknown>).raw = vi.fn((sql: string) => ({ sql }))
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async () => undefined,
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { id: 'U1' }
  },
  requireAdmin: async () => undefined
}))
// #1374 — the upload hands each stored chunk to the replay indexer.
const scheduleReplayIndex = vi.hoisted(() => vi.fn())
vi.mock('../../../services/session-replay-index.js', () => ({ scheduleReplayIndex }))

vi.mock('../../../services/session-replay-stats.js', () => ({
  recordChunkStats: async (id: string, events: unknown[]) => {
    h.stats.push([id, events])
  }
}))

import { sessionRecordingRoutes } from '../../../routes/session-recordings.js'

const REC = '6f1c2b3a-1234-4abc-9def-0123456789ab'

async function post(body: unknown) {
  const app = Fastify()
  await app.register(sessionRecordingRoutes, { prefix: '/api/session-recordings' })
  return app.inject({
    method: 'POST',
    url: `/api/session-recordings/${REC}/events`,
    payload: body as Record<string, unknown>
  })
}

beforeEach(() => {
  h.recording = { id: REC, user: 'U1', byte_size: 0, truncated: false, ended_at: null }
  h.existing = null
  h.inserts = []
  h.updates = []
  scheduleReplayIndex.mockClear()
  h.stats = []
})

describe('POST /session-recordings/:id/events', () => {
  it('stores a new seq and counts its bytes', async () => {
    const res = await post({ seq: 3, events: [{ type: 3, timestamp: 1 }] })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { ok: true } })
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]).toMatchObject({ recording: REC, seq: 3 })
    expect(h.updates).toHaveLength(1)
    expect(scheduleReplayIndex).toHaveBeenCalledWith(REC, 3, [{ type: 3, timestamp: 1 }])
    // #1358: the stored chunk feeds the recording's active-time stat.
    expect(h.stats).toEqual([[REC, [{ type: 3, timestamp: 1 }]]])
  })

  it('answers ok for a seq it already holds, without a second row or more bytes', async () => {
    h.existing = { id: 42 }
    const res = await post({ seq: 3, events: [{ type: 3, timestamp: 1 }] })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { ok: true, duplicate: true } })
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
    expect(scheduleReplayIndex).not.toHaveBeenCalled()
    expect(h.stats).toHaveLength(0)
  })

  it('still answers 409 for a closed recording, duplicate or not', async () => {
    h.recording = { ...h.recording, ended_at: new Date() }
    h.existing = { id: 42 }
    const res = await post({ seq: 3, events: [{ type: 3, timestamp: 1 }] })
    expect(res.statusCode).toBe(409)
  })

  it("refuses someone else's recording", async () => {
    h.recording = { ...h.recording, user: 'U2' }
    const res = await post({ seq: 0, events: [{ type: 3, timestamp: 1 }] })
    expect(res.statusCode).toBe(403)
    expect(h.inserts).toHaveLength(0)
  })
})
