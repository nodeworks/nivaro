import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// GET /records/:c/:id/derived (security review 2026-11-15): a record the caller cannot
// read answers the same empty list as a record with nothing kept — never 404 — so the
// difference cannot reveal which hidden records have derived notes.

const state = vi.hoisted(() => ({
  stored: [] as Array<{ field: string }>,
  row: null as Record<string, unknown> | null
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R' }
  })
}))
vi.mock('../../../services/derived-causes.js', () => ({
  readDerivedCauses: async () => state.stored,
  defaultCauseDeps: async () => ({}),
  causesForViewer: async () => [{ field: 'due', text: 'Moved because PO due date changed' }]
}))
vi.mock('../../../services/items.js', () => ({ readOne: async () => state.row }))
vi.mock('../../../services/file-access.js', () => ({ unreadableFileIds: async () => [] }))
vi.mock('../../../services/file-processing.js', () => ({ readProcessingStates: async () => ({}) }))
vi.mock('../../../services/move-unseen.js', () => ({
  clampSince: () => null,
  recordChangesSince: async () => []
}))
vi.mock('../../../services/record-card.js', () => ({ recordCard: async () => null }))
vi.mock('../../../services/revision-access.js', () => ({ recordVisibleTo: async () => false }))

import { recordGlanceRoutes } from '../../../routes/record-glance.js'

async function get(url: string) {
  const app = Fastify()
  await app.register(recordGlanceRoutes)
  const res = await app.inject({ method: 'GET', url })
  await app.close()
  return res
}

describe('GET /records/:collection/:id/derived', () => {
  it('a hidden record with stored notes answers [] (same as nothing kept)', async () => {
    state.stored = [{ field: 'due' }]
    state.row = null
    const hidden = await get('/records/orders/R1/derived')
    state.stored = []
    const empty = await get('/records/orders/R2/derived')
    expect(hidden.statusCode).toBe(200)
    expect(hidden.json()).toEqual({ data: [] })
    expect(empty.statusCode).toBe(hidden.statusCode)
    expect(empty.json()).toEqual(hidden.json())
  })

  it('a readable record gets its causes', async () => {
    state.stored = [{ field: 'due' }]
    state.row = { id: 'R1', due: '2026-11-20' }
    const res = await get('/records/orders/R1/derived')
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
  })
})
