import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  }),
  requireAuth: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: 'test-user' }
  })
}))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn() as unknown as { transaction: unknown }
  db.transaction = vi.fn()
  return { db }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))

import { db } from '../../../db/index.js'
import { decodeChunk, encodeChunk } from '../../../routes/session-recordings.js'
import { sessionReplayClipRoutes } from '../../../routes/session-replay-clips.js'
import { logActivity } from '../../../services/activity.js'
import { type FakeTables, fakeDb } from '../../fixtures/replay-db.js'

const REC = '264bee7b-87d3-4452-81c9-ce6fbf672de5'
const USER = '7A0411F3-C687-40E5-ADF5-614157CF88EC'
const T0 = Date.parse('2026-10-01T12:00:00.000Z')

const events = [
  {
    type: 4,
    timestamp: T0,
    data: { href: 'https://app.example.com/environments', width: 1280, height: 720 }
  },
  { type: 2, timestamp: T0, data: { node: { id: 1 } } },
  { type: 5, timestamp: T0 + 100, data: { tag: 'route', payload: { path: '/environments' } } },
  { type: 3, timestamp: T0 + 5_000, data: { source: 2 } },
  {
    type: 5,
    timestamp: T0 + 12_000,
    data: { tag: 'console', payload: { level: 'error', msg: 'Invalid time value' } }
  },
  { type: 3, timestamp: T0 + 15_000, data: { source: 2 } },
  { type: 3, timestamp: T0 + 30_000, data: { source: 2 } }
]

const source = {
  id: REC,
  user: USER,
  app: null,
  origin: 'https://app.example.com',
  meta: '{"platform":"Win32"}',
  masquerade_admin: null
}

function setup(over: FakeTables = {}) {
  const fake = fakeDb({
    first: {
      nivaro_session_recordings: source,
      nivaro_users: { first_name: 'Dana', last_name: 'Ng', email: 'dana@example.com' },
      ...over.first
    },
    rows: {
      // Two chunks, the second out of order inside: the cut sorts.
      nivaro_session_events: [
        { events: encodeChunk(JSON.stringify(events.slice(0, 4))) },
        { events: JSON.stringify(events.slice(4)) }
      ],
      nivaro_api_logs: [
        {
          method: 'get',
          path: '/api/items/environments?access_token=secret',
          status: 503,
          latency_ms: 812,
          created_at: new Date(T0 + 11_000)
        }
      ],
      ...over.rows
    },
    inserted: { nivaro_issues: [{ id: 42 }], ...over.inserted }
  })
  vi.mocked(db).mockImplementation(fake.dbFn as never)
  ;(db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction.mockImplementation(
    fake.transaction as never
  )
  return fake
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(sessionReplayClipRoutes)
  return app
}

afterEach(() => vi.clearAllMocks())

describe('POST /session-recordings/:id/clip-issue (#1366)', () => {
  it('cuts the range into an app=clip recording and raises an issue on it', async () => {
    const fake = setup()
    const res = await buildApp().inject({
      method: 'POST',
      url: `/session-recordings/${REC}/clip-issue`,
      payload: { from_ms: 10_000, to_ms: 20_000, note: 'Saving the environment fails' }
    })
    expect(res.statusCode).toBe(201)
    const d = res.json().data
    expect(d).toMatchObject({
      issue_id: 42,
      from_ms: 10_000,
      to_ms: 20_000,
      route: '/environments',
      console_errors: 1,
      requests: 1
    })

    // The clip recording: the person's, same environment, its own clock.
    const [[recRow]] = fake.callsOf('nivaro_session_recordings', 'insert') as [
      [Record<string, unknown>]
    ]
    expect(recRow).toMatchObject({
      id: d.recording_id,
      user: USER,
      app: 'clip',
      origin: 'https://app.example.com',
      meta: '{"platform":"Win32"}',
      started_at: new Date(T0 + 10_000),
      ended_at: new Date(T0 + 20_000),
      truncated: false
    })
    const chunks = fake.callsOf('nivaro_session_events', 'insert') as Array<
      [{ recording: string; seq: number; events: string }]
    >
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every(([c]) => c.recording === d.recording_id)).toBe(true)
    expect(chunks[0][0].events.startsWith('gz:')).toBe(true)
    const cut = chunks.flatMap(
      ([c]) => JSON.parse(decodeChunk(c.events)) as Array<{ timestamp: number; type: number }>
    )
    expect(cut.map((e) => e.timestamp - T0)).toEqual([
      10_000, 10_000, 10_000, 10_000, 12_000, 15_000
    ])
    expect(recRow.event_count).toBe(cut.length)

    // The issue: linked to the clip at 0, route + console error + request in its text.
    const [[issue]] = fake.callsOf('nivaro_issues', 'insert') as [[Record<string, unknown>]]
    expect(issue).toMatchObject({
      title: 'Replay clip: /environments (1 console error)',
      severity: 'medium',
      status: 'open',
      source: 'manual',
      raised_by: 'test-admin',
      recording_id: d.recording_id,
      recording_offset_ms: 0
    })
    const details = String(issue.details)
    expect(details).toContain(`0:10–0:20 of recording ${REC} (Dana Ng)`)
    expect(details).toContain('Route: /environments')
    expect(details).toContain('Saving the environment fails')
    expect(details).toContain('0:02 Invalid time value')
    expect(details).toContain('0:01 GET /api/items/environments → 503')
    expect(details).not.toContain('access_token')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session-replay-clip-issue', item: '42' })
    )
  })

  it('takes a title and severity', async () => {
    const fake = setup()
    const res = await buildApp().inject({
      method: 'POST',
      url: `/session-recordings/${REC}/clip-issue`,
      payload: { from_ms: 0, to_ms: 30_000, title: 'Save button dead', severity: 'high' }
    })
    expect(res.statusCode).toBe(201)
    const [[issue]] = fake.callsOf('nivaro_issues', 'insert') as [[Record<string, unknown>]]
    expect(issue).toMatchObject({ title: 'Save button dead', severity: 'high' })
  })

  it('refuses a missing or too-short range and a bad severity', async () => {
    setup()
    const app = buildApp()
    for (const payload of [{}, { from_ms: 1_000, to_ms: 1_500 }, { from_ms: 'x', to_ms: 9 }]) {
      const res = await app.inject({
        method: 'POST',
        url: `/session-recordings/${REC}/clip-issue`,
        payload
      })
      expect(res.statusCode).toBe(400)
    }
    const res = await app.inject({
      method: 'POST',
      url: `/session-recordings/${REC}/clip-issue`,
      payload: { from_ms: 0, to_ms: 5_000, severity: 'urgent' }
    })
    expect(res.statusCode).toBe(400)
  })

  it('404s a missing recording and 422s a range with nothing to replay', async () => {
    setup({ first: { nivaro_session_recordings: undefined } })
    const app = buildApp()
    const missing = await app.inject({
      method: 'POST',
      url: `/session-recordings/${REC}/clip-issue`,
      payload: { from_ms: 0, to_ms: 5_000 }
    })
    expect(missing.statusCode).toBe(404)

    const fake = setup({
      rows: {
        nivaro_session_events: [
          {
            events: JSON.stringify([
              { type: 3, timestamp: T0 },
              { type: 3, timestamp: T0 + 9_000 }
            ])
          }
        ]
      }
    })
    const empty = await app.inject({
      method: 'POST',
      url: `/session-recordings/${REC}/clip-issue`,
      payload: { from_ms: 0, to_ms: 5_000 }
    })
    expect(empty.statusCode).toBe(422)
    expect(fake.callsOf('nivaro_issues', 'insert')).toHaveLength(0)
    expect(fake.callsOf('nivaro_session_recordings', 'insert')).toHaveLength(0)
  })
})
