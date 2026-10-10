import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * POST /session-recordings/start with clip: true (#1377): the clip's app label
 * comes from an allowlist — 'support' → 'support-clip', anything else →
 * 'error-clip' — and every clip is gated by the error-replay bit.
 */

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  inserts: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../db/index.js', () => {
  const db = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull']) chain[m] = vi.fn(() => chain)
    chain.first = vi.fn(async () => (table === 'nivaro_settings' ? h.settings : undefined))
    chain.insert = vi.fn(async (row: Record<string, unknown>) => {
      h.inserts.push(row)
      return [1]
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

import { clipAppLabel, sessionRecordingRoutes } from '../../../routes/session-recordings.js'

async function start(body: Record<string, unknown>) {
  const app = Fastify()
  await app.register(sessionRecordingRoutes, { prefix: '/api/session-recordings' })
  return app.inject({ method: 'POST', url: '/api/session-recordings/start', payload: body })
}

beforeEach(() => {
  h.settings = { error_replay_enabled: true, session_recording_enabled: false }
  h.inserts = []
})

describe('clip kinds', () => {
  it('labels a support clip support-clip', async () => {
    const res = await start({ clip: true, clip_kind: 'support', app: 'efp' })
    expect(res.statusCode).toBe(200)
    expect(h.inserts[0]).toMatchObject({ user: 'U1', app: 'support-clip' })
  })

  it('never takes a free-text label for a clip', async () => {
    await start({ clip: true, clip_kind: 'auto:<script>' })
    await start({ clip: true })
    expect(h.inserts.map((r) => r.app)).toEqual(['error-clip', 'error-clip'])
    expect(clipAppLabel('support')).toBe('support-clip')
    expect(clipAppLabel(undefined)).toBe('error-clip')
  })

  it('refuses any clip while error replay is off', async () => {
    h.settings = { error_replay_enabled: false }
    const res = await start({ clip: true, clip_kind: 'support' })
    expect(res.statusCode).toBe(409)
    expect(h.inserts).toHaveLength(0)
  })
})

describe('auto-record starts (#1371)', () => {
  async function signalToken(userId: string): Promise<string> {
    const { fireReplaySignal, resetAutoSignalsForTest } = await import(
      '../../../services/replay-auto-signals.js'
    )
    resetAutoSignalsForTest()
    let token = ''
    await fireReplaySignal(
      'rage-click',
      { userIds: [userId] },
      {
        emit: (_u, p) => {
          token = p.token
        }
      }
    )
    return token
  }

  it('start with the server token while recording is off, labelled auto:<signal>', async () => {
    h.settings = {
      session_recording_enabled: false,
      error_replay_enabled: false,
      replay_auto_signals: true
    }
    const token = await signalToken('U1')
    expect(token).toMatch(/^[0-9a-f]{36}$/)
    const res = await start({ auto_token: token, app: 'whatever' })
    expect(res.statusCode).toBe(200)
    expect(h.inserts[0]).toMatchObject({ user: 'U1', app: 'auto:rage-click' })
    // single use
    const again = await start({ auto_token: token })
    expect(again.statusCode).toBe(409)
  })

  it('refuse a made-up or someone else’s token', async () => {
    h.settings = { session_recording_enabled: true, replay_auto_signals: true }
    expect((await start({ auto_token: 'f'.repeat(36) })).statusCode).toBe(409)
    const theirs = await signalToken('U2')
    expect((await start({ auto_token: theirs })).statusCode).toBe(409)
    expect(h.inserts).toHaveLength(0)
  })
})
