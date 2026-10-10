import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Who the signed-in viewer is, per test.
const viewer: { id: string; masquerade?: string } = { id: '' }

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  }),
  requireAuth: vi.fn(
    async (req: { user?: { id: string }; isAdmin?: boolean; masqueradeAdminId?: string }) => {
      req.user = { id: viewer.id }
      req.isAdmin = false
      if (viewer.masquerade) req.masqueradeAdminId = viewer.masquerade
    }
  )
}))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn() as unknown as { transaction: unknown; raw: unknown }
  db.transaction = vi.fn()
  db.raw = vi.fn((sql: string) => ({ sql }))
  return { db }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://admin.example.com' }))

import { db } from '../../../db/index.js'
import {
  hashShareToken,
  SHARE_DEFAULT_HOURS,
  SHARE_MAX_HOURS,
  sessionReplayShareRoutes,
  shareHours
} from '../../../routes/session-replay-shares.js'
import { logActivity } from '../../../services/activity.js'
import { notifyUser } from '../../../services/notification-channels.js'
import { type Call, type FakeTables, fakeDb, whereValue } from '../../fixtures/replay-db.js'

const REC = '264bee7b-87d3-4452-81c9-ce6fbf672de5'
const DANA = '7A0411F3-C687-40E5-ADF5-614157CF88EC'
const T0 = Date.parse('2026-10-01T12:00:00.000Z')
const TOKEN = 'tok-abc'

const events = [
  { type: 4, timestamp: T0, data: { href: 'https://app.example.com/queues' } },
  { type: 2, timestamp: T0, data: { node: { id: 1 } } },
  {
    type: 5,
    timestamp: T0 + 1_000,
    data: { tag: 'console', payload: { level: 'error', msg: 'before' } }
  },
  { type: 3, timestamp: T0 + 5_000, data: { source: 2 } },
  { type: 3, timestamp: T0 + 20_000, data: { source: 2 } },
  { type: 3, timestamp: T0 + 40_000, data: { source: 2 } }
]

const share = (over: Record<string, unknown> = {}) => ({
  id: 'sh-1',
  recording: REC,
  from_ms: 10_000,
  to_ms: 30_000,
  user_id: DANA,
  shared_by: 'test-admin',
  expires_at: new Date(Date.now() + 3_600_000),
  created_at: new Date(),
  shared_by_name: 'Admin User',
  ...over
})

function setup(over: FakeTables = {}) {
  const fake = fakeDb({
    first: {
      nivaro_users: { id: DANA, first_name: 'Dana', last_name: 'Ng', email: 'dana@example.com' },
      nivaro_session_recordings: {
        id: REC,
        user: 'u-1',
        app: null,
        origin: null,
        meta: null,
        masquerade_admin: null
      },
      // Only the right token finds the row.
      'nivaro_replay_shares as s': (calls: Call[]) =>
        whereValue(calls, 's.token_hash') === hashShareToken(TOKEN) ? share() : undefined,
      ...over.first
    },
    rows: { nivaro_session_events: [{ events: JSON.stringify(events) }], ...over.rows },
    inserted: over.inserted
  })
  vi.mocked(db).mockImplementation(fake.dbFn as never)
  return fake
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(sessionReplayShareRoutes)
  return app
}

beforeEach(() => {
  viewer.id = DANA.toLowerCase()
  viewer.masquerade = undefined
})
afterEach(() => vi.clearAllMocks())

describe('POST /session-recordings/:id/share (#1362)', () => {
  it('mints a hashed token for one person, notifies them and answers the link once', async () => {
    const fake = setup()
    const before = Date.now()
    const res = await buildApp().inject({
      method: 'POST',
      url: `/session-recordings/${REC}/share`,
      payload: { from_ms: 10_000, to_ms: 30_000, expires_hours: 24, user_id: DANA }
    })
    expect(res.statusCode).toBe(201)
    const d = res.json().data
    expect(d.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(d.url).toBe(`/session-replays?share=${d.token}`)
    expect(d).not.toHaveProperty('token_hash')
    const [[row]] = fake.callsOf('nivaro_replay_shares', 'insert') as [[Record<string, unknown>]]
    expect(row).toMatchObject({
      recording: REC,
      from_ms: 10_000,
      to_ms: 30_000,
      user_id: DANA,
      shared_by: 'test-admin',
      token_hash: hashShareToken(d.token)
    })
    expect(JSON.stringify(row)).not.toContain(d.token)
    const ttl = (row.expires_at as Date).getTime() - before
    expect(ttl).toBeGreaterThanOrEqual(24 * 3_600_000 - 1_000)
    expect(ttl).toBeLessThanOrEqual(24 * 3_600_000 + 1_000)
    expect(notifyUser).toHaveBeenCalledWith(
      expect.anything(),
      DANA,
      expect.objectContaining({
        target: { kind: 'external', url: `https://admin.example.com${d.url}` }
      })
    )
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session-replay-share-create', item: row.id })
    )
  })

  it('refuses an unknown person, a missing range or an unreplayable window', async () => {
    setup({ first: { nivaro_users: undefined } })
    const app = buildApp()
    const nobody = await app.inject({
      method: 'POST',
      url: `/session-recordings/${REC}/share`,
      payload: { from_ms: 0, to_ms: 5_000, user_id: DANA }
    })
    expect(nobody.statusCode).toBe(400)
    const junkId = await app.inject({
      method: 'POST',
      url: `/session-recordings/${REC}/share`,
      payload: { from_ms: 0, to_ms: 5_000, user_id: "x' OR 1=1" }
    })
    expect(junkId.statusCode).toBe(400)
    setup()
    const noRange = await app.inject({
      method: 'POST',
      url: `/session-recordings/${REC}/share`,
      payload: { user_id: DANA }
    })
    expect(noRange.statusCode).toBe(400)
    setup({ rows: { nivaro_session_events: [] } })
    const empty = await app.inject({
      method: 'POST',
      url: `/session-recordings/${REC}/share`,
      payload: { from_ms: 0, to_ms: 5_000, user_id: DANA }
    })
    expect(empty.statusCode).toBe(404)
  })
})

describe('GET /session-replay-shares/view/:token[/events] (#1362)', () => {
  it('plays only the window for the person it names, and logs the open', async () => {
    const fake = setup()
    const app = buildApp()
    const head = await app.inject({ method: 'GET', url: `/session-replay-shares/view/${TOKEN}` })
    expect(head.statusCode).toBe(200)
    expect(head.json().data).toMatchObject({
      id: 'sh-1',
      from_ms: 10_000,
      to_ms: 30_000,
      duration_ms: 20_000,
      shared_by_name: 'Admin User'
    })
    expect(logActivity).not.toHaveBeenCalled()

    const res = await app.inject({
      method: 'GET',
      url: `/session-replay-shares/view/${TOKEN}/events`
    })
    expect(res.statusCode).toBe(200)
    const offsets = (res.json().data.events as Array<{ timestamp: number }>).map(
      (e) => e.timestamp - T0
    )
    // Snapshot + lead-in pinned to 10 s, then the window; nothing after 30 s.
    expect(offsets).toEqual([10_000, 10_000, 10_000, 20_000])
    expect(res.body).not.toContain('before')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'session-replay-share-open',
        collection: 'nivaro_replay_shares',
        item: 'sh-1',
        user: DANA.toLowerCase()
      })
    )
    const bump = fake.log.find(
      (l) => l.table === 'nivaro_replay_shares' && l.calls.some(([m]) => m === 'update')
    )
    expect(bump && whereValue(bump.calls, 'id')).toBe('sh-1')
  })

  it('403s anyone else (and logs the refusal), and a masquerade session', async () => {
    setup()
    const app = buildApp()
    viewer.id = 'someone-else'
    for (const url of [
      `/session-replay-shares/view/${TOKEN}`,
      `/session-replay-shares/view/${TOKEN}/events`
    ]) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(403)
    }
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session-replay-share-denied', item: 'sh-1' })
    )
    expect(logActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session-replay-share-open' })
    )
    viewer.id = DANA
    viewer.masquerade = 'test-admin'
    const masq = await app.inject({
      method: 'GET',
      url: `/session-replay-shares/view/${TOKEN}/events`
    })
    expect(masq.statusCode).toBe(403)
  })

  it('410s an expired link and 404s a revoked or unknown one', async () => {
    setup({
      first: { 'nivaro_replay_shares as s': share({ expires_at: new Date(Date.now() - 1_000) }) }
    })
    const app = buildApp()
    const expired = await app.inject({
      method: 'GET',
      url: `/session-replay-shares/view/${TOKEN}/events`
    })
    expect(expired.statusCode).toBe(410)
    setup()
    const unknown = await app.inject({ method: 'GET', url: '/session-replay-shares/view/nope' })
    expect(unknown.statusCode).toBe(404)
    expect(logActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session-replay-share-open' })
    )
  })

  it('404s when the recording behind it has been purged', async () => {
    setup({ first: { nivaro_session_recordings: undefined } })
    const res = await buildApp().inject({
      method: 'GET',
      url: `/session-replay-shares/view/${TOKEN}/events`
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('share list and revoke (#1362)', () => {
  it('lists who shared with whom and until when', async () => {
    const past = new Date(Date.now() - 1_000)
    setup({
      rows: {
        'nivaro_replay_shares as s': [
          { id: 'sh-1', user_name: 'Dana Ng', shared_by_name: 'Admin User', expires_at: past },
          {
            id: 'sh-2',
            user_name: 'Lee',
            shared_by_name: 'Admin User',
            expires_at: new Date(Date.now() + 60_000)
          }
        ]
      }
    })
    const res = await buildApp().inject({ method: 'GET', url: `/session-recordings/${REC}/shares` })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([
      expect.objectContaining({ id: 'sh-1', user_name: 'Dana Ng', expired: true }),
      expect.objectContaining({ id: 'sh-2', expired: false })
    ])
  })

  it('revoke deletes the row', async () => {
    const fake = setup({
      first: { nivaro_replay_shares: { id: 'sh-1', recording: REC, user_id: DANA } }
    })
    const res = await buildApp().inject({ method: 'DELETE', url: '/session-replay-shares/sh-1' })
    expect(res.statusCode).toBe(200)
    const del = fake.log.find(
      (l) => l.table === 'nivaro_replay_shares' && l.calls.some(([m]) => m === 'del')
    )!
    expect(whereValue(del.calls, 'id')).toBe('sh-1')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session-replay-share-revoke', item: 'sh-1' })
    )
    setup({ first: { nivaro_replay_shares: undefined } })
    const gone = await buildApp().inject({ method: 'DELETE', url: '/session-replay-shares/sh-1' })
    expect(gone.statusCode).toBe(404)
  })
})

describe('shareHours', () => {
  it('defaults and clamps', () => {
    expect(shareHours(undefined)).toBe(SHARE_DEFAULT_HOURS)
    expect(shareHours('x')).toBe(SHARE_DEFAULT_HOURS)
    expect(shareHours(0)).toBe(1)
    expect(shareHours(10_000)).toBe(SHARE_MAX_HOURS)
    expect(shareHours(4.4)).toBe(4)
  })
})
