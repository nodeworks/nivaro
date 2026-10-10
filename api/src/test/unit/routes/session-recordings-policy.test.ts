import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /session-recordings/enabled carries the policy the recorders apply:
 * masking rules (#1361).
 */

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>
}))

vi.mock('../../../db/index.js', () => {
  const db = vi.fn((_table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull']) chain[m] = vi.fn(() => chain)
    chain.first = vi.fn(async (...cols: string[]) => {
      const out: Record<string, unknown> = {}
      for (const c of cols) out[c] = h.settings[c]
      return out
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

import { sessionRecordingRoutes } from '../../../routes/session-recordings.js'

async function enabled() {
  const app = Fastify()
  await app.register(sessionRecordingRoutes, { prefix: '/api/session-recordings' })
  const res = await app.inject({ method: 'GET', url: '/api/session-recordings/enabled' })
  return { status: res.statusCode, data: res.json().data }
}

beforeEach(() => {
  h.settings = { session_recording_enabled: true, error_replay_enabled: false }
})

describe('GET /session-recordings/enabled', () => {
  it('masks everything when no rules are stored', async () => {
    const r = await enabled()
    expect(r.status).toBe(200)
    expect(r.data).toMatchObject({
      enabled: true,
      error_replay: false,
      masking: { mask_rich_text: true, mask_file_names: true, allow_fields: [] }
    })
  })

  it('hands over the stored masking rules', async () => {
    h.settings.replay_masking = JSON.stringify({
      mask_rich_text: false,
      allow_fields: ['orders.status']
    })
    const r = await enabled()
    expect(r.data.masking).toEqual({
      mask_rich_text: false,
      mask_file_names: true,
      allow_fields: ['orders.status']
    })
  })
})
