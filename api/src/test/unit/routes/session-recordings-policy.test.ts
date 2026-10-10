import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The policy the recorders are handed and held to: masking rules (#1361) and
 * per-route sampling on GET /enabled; the daily byte cap (#1368) on /enabled,
 * /start and the events route (409 {reason:'daily_cap'} stops a recorder).
 */

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  daily: null as Record<string, unknown> | null,
  recording: null as Record<string, unknown> | null,
  inserts: [] as Array<{ table: string; row: unknown }>
}))

vi.mock('../../../db/index.js', () => {
  const db = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull']) chain[m] = vi.fn(() => chain)
    chain.first = vi.fn(async (...cols: string[]) => {
      if (table === 'nivaro_settings') {
        const out: Record<string, unknown> = {}
        for (const c of cols) out[c] = h.settings[c]
        return out
      }
      if (table === 'nivaro_session_replay_daily') return h.daily
      if (table === 'nivaro_session_recordings') return h.recording
      return null // nivaro_session_events: no duplicate
    })
    chain.insert = vi.fn(async (row: unknown) => {
      h.inserts.push({ table, row })
      return [1]
    })
    chain.update = vi.fn(async () => 1)
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
import { resetReplayCostState } from '../../../services/session-replay-cost.js'

const REC = '6f1c2b3a-1234-4abc-9def-0123456789ab'
const MB = 1_048_576

async function call(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  const app = Fastify()
  await app.register(sessionRecordingRoutes, { prefix: '/api/session-recordings' })
  const res = await app.inject({ method, url: `/api/session-recordings${url}`, payload })
  return { status: res.statusCode, body: res.json() }
}

beforeEach(() => {
  resetReplayCostState()
  h.settings = { session_recording_enabled: true, error_replay_enabled: false }
  h.daily = null
  h.recording = { id: REC, user: 'U1', byte_size: 0, truncated: false, ended_at: null }
  h.inserts = []
})

describe('GET /session-recordings/enabled', () => {
  it('masks everything, records everywhere and has no cap when nothing is set', async () => {
    const r = await call('GET', '/enabled')
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual({
      enabled: true,
      error_replay: false,
      masking: { mask_rich_text: true, mask_file_names: true, allow_fields: [] },
      sampling: { default: 1, routes: {} },
      cap_reached: false
    })
  })

  it('hands over the stored masking rules and sampling', async () => {
    h.settings.replay_masking = JSON.stringify({
      mask_rich_text: false,
      allow_fields: ['orders.status']
    })
    h.settings.replay_sampling = JSON.stringify({ default: 0.5, routes: { '/reports/*': 0 } })
    const r = await call('GET', '/enabled')
    expect(r.body.data.masking).toEqual({
      mask_rich_text: false,
      mask_file_names: true,
      allow_fields: ['orders.status']
    })
    expect(r.body.data.sampling).toEqual({ default: 0.5, routes: { '/reports/*': 0 } })
  })

  it('says when today’s cap is reached', async () => {
    h.settings.replay_daily_cap_mb = 5
    h.daily = { bytes: 6 * MB, cap_hit_at: null }
    const r = await call('GET', '/enabled')
    expect(r.body.data.cap_reached).toBe(true)
  })
})

describe('daily cap (#1368)', () => {
  it('refuses a new recording once the cap is reached', async () => {
    h.settings.replay_daily_cap_mb = 5
    h.daily = { bytes: 5 * MB, cap_hit_at: new Date() }
    const r = await call('POST', '/start', {})
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'Daily recording cap reached', reason: 'daily_cap' })
    expect(h.inserts.filter((i) => i.table === 'nivaro_session_recordings')).toHaveLength(0)
  })

  it('answers 409 daily_cap to a chunk once the cap is reached, storing nothing', async () => {
    h.settings.replay_daily_cap_mb = 5
    h.daily = { bytes: 5 * MB, cap_hit_at: new Date() }
    const r = await call('POST', `/${REC}/events`, {
      seq: 0,
      events: [{ type: 3, timestamp: 1 }],
      route: '/home'
    })
    expect(r.status).toBe(409)
    expect(r.body.reason).toBe('daily_cap')
    expect(h.inserts.filter((i) => i.table === 'nivaro_session_events')).toHaveLength(0)
  })

  it('stores a chunk under the cap', async () => {
    h.settings.replay_daily_cap_mb = 5
    h.daily = { bytes: MB, cap_hit_at: null }
    const r = await call('POST', `/${REC}/events`, {
      seq: 0,
      events: [{ type: 3, timestamp: 1 }],
      route: '/content/orders/12',
      build: '0.2.35'
    })
    expect(r.status).toBe(200)
    expect(h.inserts.filter((i) => i.table === 'nivaro_session_events')).toHaveLength(1)
  })
})
