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
  const db = vi.fn() as unknown as { transaction: unknown; raw: unknown }
  db.transaction = vi.fn()
  db.raw = vi.fn((sql: string) => ({ sql }))
  return { db }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))

import { db } from '../../../db/index.js'
import { purgeExpiredRecordings } from '../../../routes/session-recordings.js'
import { sessionReplayClipRoutes } from '../../../routes/session-replay-clips.js'
import { logActivity } from '../../../services/activity.js'
import { parseTags } from '../../../services/session-replay-clips.js'
import { type FakeTables, fakeDb, whereValue } from '../../fixtures/replay-db.js'

const REC = '264bee7b-87d3-4452-81c9-ce6fbf672de5'
const T0 = Date.parse('2026-10-01T12:00:00.000Z')
const events = [
  { type: 4, timestamp: T0, data: { href: 'https://app.example.com/queues' } },
  { type: 2, timestamp: T0, data: { node: { id: 1 } } },
  { type: 3, timestamp: T0 + 5_000, data: { source: 5, text: '*****' } },
  { type: 3, timestamp: T0 + 20_000, data: { source: 2 } }
]

function setup(over: FakeTables = {}) {
  const fake = fakeDb({
    first: {
      nivaro_session_recordings: {
        id: REC,
        user: 'u-1',
        app: null,
        origin: null,
        meta: null,
        masquerade_admin: null
      },
      ...over.first
    },
    rows: {
      nivaro_session_events: [{ events: JSON.stringify(events) }],
      ...over.rows
    },
    inserted: over.inserted
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

describe('POST /session-recordings/:id/clips (#1415)', () => {
  it('cuts the range into its own recording and saves a named, tagged library row', async () => {
    const fake = setup()
    const res = await buildApp().inject({
      method: 'POST',
      url: `/session-recordings/${REC}/clips`,
      payload: {
        from_ms: 2_000,
        to_ms: 15_000,
        name: '  Queue freeze  ',
        description: 'Spinner never stops',
        tags: 'Queues, freeze, queues'
      }
    })
    expect(res.statusCode).toBe(201)
    const clip = res.json().data
    const [[rec]] = fake.callsOf('nivaro_session_recordings', 'insert') as [
      [Record<string, unknown>]
    ]
    expect(rec).toMatchObject({ app: 'clip', user: 'u-1' })
    expect(clip).toMatchObject({
      name: 'Queue freeze',
      description: 'Spinner never stops',
      tags: ['queues', 'freeze'],
      recording: rec.id,
      source_recording: REC,
      from_ms: 2_000,
      to_ms: 15_000,
      duration_ms: 13_000,
      saved_by: 'test-admin'
    })
    const [[row]] = fake.callsOf('nivaro_replay_clips', 'insert') as [[Record<string, unknown>]]
    expect(row).toMatchObject({ id: clip.id, tags: '["queues","freeze"]', recording: rec.id })
    // Masking is whatever was stored: the masked text is copied, not re-read.
    const chunks = fake.callsOf('nivaro_session_events', 'insert') as Array<[{ events: string }]>
    expect(chunks.length).toBe(1)
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session-replay-clip-save', item: clip.id })
    )
  })

  it('needs a name and a usable range', async () => {
    setup()
    const app = buildApp()
    const noName = await app.inject({
      method: 'POST',
      url: `/session-recordings/${REC}/clips`,
      payload: { from_ms: 0, to_ms: 5_000, name: '  ' }
    })
    expect(noName.statusCode).toBe(400)
    const noRange = await app.inject({
      method: 'POST',
      url: `/session-recordings/${REC}/clips`,
      payload: { name: 'x' }
    })
    expect(noRange.statusCode).toBe(400)
  })
})

describe('GET /session-replay-clips (#1415)', () => {
  it('lists newest first with tags as arrays and searches name, description and tags', async () => {
    const fake = setup({
      rows: {
        'nivaro_replay_clips as c': [
          {
            id: 'c1',
            name: 'Queue freeze',
            description: null,
            tags: '["queues"]',
            recording: 'r1',
            source_recording: REC,
            from_ms: 1_000,
            to_ms: 9_000,
            saved_by: 'test-admin',
            created_at: new Date(T0),
            user_name: 'Dana Ng',
            saved_by_name: 'Admin User'
          }
        ]
      }
    })
    const res = await buildApp().inject({
      method: 'GET',
      url: '/session-replay-clips?q=Fre%25eze&tag=Queues'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([
      expect.objectContaining({
        id: 'c1',
        tags: ['queues'],
        duration_ms: 8_000,
        user_name: 'Dana Ng'
      })
    ])
    const chain = fake.log.find((l) => l.table === 'nivaro_replay_clips as c')!
    expect(chain.calls.find(([m]) => m === 'orderBy')?.[1]).toEqual(['c.created_at', 'desc'])
    // The search runs inside a grouped where; the tag filter matches the JSON element.
    const modify = chain.calls.find(([m]) => m === 'modify')?.[1][0] as (qb: unknown) => void
    const seen: Array<[string, unknown[]]> = []
    const qb: Record<string, unknown> = {}
    for (const m of ['where', 'whereRaw', 'orWhereRaw']) {
      qb[m] = (...a: unknown[]) => {
        seen.push([m, a])
        if (typeof a[0] === 'function') (a[0] as (w: unknown) => void)(qb)
        return qb
      }
    }
    modify(qb)
    const raws = seen.filter(([m]) => m !== 'where').map(([, a]) => a)
    expect(raws).toEqual([
      ['LOWER(c.name) LIKE ?', ['%freeze%']],
      ["LOWER(COALESCE(c.description, '')) LIKE ?", ['%freeze%']],
      ["LOWER(COALESCE(c.tags, '')) LIKE ?", ['%freeze%']],
      ["LOWER(COALESCE(c.tags, '')) LIKE ?", ['%"queues"%']]
    ])
  })
})

describe('DELETE /session-replay-clips/:id (#1415)', () => {
  it('deletes the clip by deleting its cut recording', async () => {
    const fake = setup({
      first: { nivaro_replay_clips: { id: 'c1', name: 'Queue freeze', recording: 'r1' } }
    })
    const res = await buildApp().inject({ method: 'DELETE', url: '/session-replay-clips/c1' })
    expect(res.statusCode).toBe(200)
    const del = fake.log.find(
      (l) => l.table === 'nivaro_session_recordings' && l.calls.some(([m]) => m === 'del')
    )!
    expect(whereValue(del.calls, 'id')).toBe('r1')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session-replay-clip-delete', item: 'c1' })
    )
  })

  it('404s an unknown clip', async () => {
    setup({ first: { nivaro_replay_clips: undefined } })
    const res = await buildApp().inject({ method: 'DELETE', url: '/session-replay-clips/nope' })
    expect(res.statusCode).toBe(404)
  })
})

describe('retention purge (#1415)', () => {
  it('skips recordings a library clip points at', async () => {
    const fake = setup({ first: { nivaro_settings: { session_recording_retention_days: 7 } } })
    await purgeExpiredRecordings()
    const purge = fake.log.find(
      (l) => l.table === 'nivaro_session_recordings' && l.calls.some(([m]) => m === 'del')
    )!
    expect(purge.calls.find(([m]) => m === 'where')?.[1][0]).toBe('started_at')
    const notIn = purge.calls.find(([m]) => m === 'whereNotIn')?.[1]
    expect(notIn?.[0]).toBe('id')
    const sub = fake.log.find((l) => l.table === 'nivaro_replay_clips')!
    expect(sub.calls).toEqual([['select', ['recording']]])
  })
})

describe('parseTags', () => {
  it('trims, lower-cases, dedupes and caps', () => {
    expect(parseTags([' A ', 'a', 'b  c'])).toEqual(['a', 'b c'])
    expect(parseTags('x,,y')).toEqual(['x', 'y'])
    expect(parseTags(null)).toEqual([])
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(10)
    expect(
      JSON.stringify(parseTags(Array.from({ length: 10 }, (_, i) => `${i}${'x'.repeat(60)}`)))
        .length
    ).toBeLessThanOrEqual(500)
  })
})
