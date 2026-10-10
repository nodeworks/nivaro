import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryKnex } from '../../fixtures/memory-knex.js'

/**
 * #1363 — timestamped notes on a recording: CRUD, admin-only, and the copy of
 * a note onto the linked issue (a comment) or an investigation notebook (its
 * notes), each with a deep link back to that second.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('../../fixtures/memory-knex.js').memoryKnex>,
  activity: [] as Array<Record<string, unknown>>,
  investigations: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../db/index.js', () => ({
  db: new Proxy(() => {}, {
    apply: (_t, _this, args: [string]) => h.db(args[0]),
    get: (_t, k) => (h.db as unknown as Record<string | symbol, unknown>)[k]
  })
}))
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => null }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (row: Record<string, unknown>) => {
    h.activity.push(row)
    return 1
  }
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (
    req: { headers: Record<string, string>; user?: unknown; isAdmin?: boolean },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    const who = req.headers['x-test-user']
    if (!who?.startsWith('admin')) return reply.code(403).send({ error: 'Admin only' })
    req.user = { id: who === 'admin2' ? ADMIN2 : ADMIN }
    req.isAdmin = true
  }
}))
vi.mock('../../../services/traffic-inspect/actions-store.js', () => ({
  INVESTIGATIONS_TABLE: 'nivaro_traffic_investigations',
  investigationsReady: async () => true,
  listInvestigations: async () => h.investigations,
  getInvestigation: async (id: string) =>
    h.investigations.find((i) => String(i.id).toLowerCase() === id.toLowerCase()) ?? null,
  updateInvestigation: async (id: string, patch: Record<string, unknown>) => {
    const row = h.investigations.find((i) => i.id === id)
    if (row) Object.assign(row, patch)
  }
}))
vi.mock('../../../services/traffic-inspect/actions-logic.js', () => ({ NOTES_MAX: 400 }))

import { sessionReplayNotesRoutes } from '../../../routes/session-replay-notes.js'

const REC = '6f1c2b3a-1234-4abc-9def-0123456789ab'
const OTHER_REC = '7f1c2b3a-1234-4abc-9def-0123456789ab'
const ADMIN = 'aaaaaaaa-1111-4111-8111-111111111111'
const ADMIN2 = 'bbbbbbbb-2222-4222-8222-222222222222'
const INV = 'cccccccc-3333-4333-8333-333333333333'

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  user = 'admin'
) {
  const app = Fastify()
  await app.register(sessionReplayNotesRoutes, { prefix: '/api/session-recordings' })
  return app.inject({
    method,
    url: `/api/session-recordings${url}`,
    payload: payload as Record<string, unknown>,
    headers: user ? { 'x-test-user': user } : {}
  })
}

beforeEach(() => {
  h.db = memoryKnex({
    nivaro_replay_notes: [],
    nivaro_session_recordings: [{ id: REC }, { id: OTHER_REC }],
    nivaro_users: [
      { id: ADMIN, first_name: 'Ada', last_name: 'Admin', email: 'ada@x.test' },
      { id: ADMIN2, first_name: 'Bo', last_name: '', email: 'bo@x.test' }
    ],
    // Linked by the error reporter in lower case; another issue on another recording.
    nivaro_issues: [
      { id: 12, title: 'Save fails', status: 'open', recording_id: REC, created_at: 2 },
      { id: 13, title: 'Other', status: 'open', recording_id: OTHER_REC, created_at: 1 }
    ],
    nivaro_comments: []
  })
  h.activity = []
  h.investigations = [
    { id: INV, title: 'Slow saves', notes: 'First lead', created_by_name: 'Ada', updated_at: 'x' }
  ]
})

async function addNote(at_ms: number, text: string, user = 'admin') {
  const res = await call('POST', `/${REC}/notes`, { at_ms, text }, user)
  expect(res.statusCode).toBe(201)
  return res.json().data as { id: string; at_ms: number; text: string; user_name: string }
}

describe('replay notes — admin gating', () => {
  it('refuses non-admins on every route', async () => {
    for (const [m, u] of [
      ['GET', `/${REC}/notes`],
      ['POST', `/${REC}/notes`],
      ['PATCH', `/${REC}/notes/${INV}`],
      ['DELETE', `/${REC}/notes/${INV}`],
      ['POST', `/${REC}/notes/${INV}/copy`]
    ] as const) {
      const res = await call(m, u, { at_ms: 1, text: 'x' }, 'user')
      expect(res.statusCode, `${m} ${u}`).toBe(403)
    }
    expect(h.db.tables.nivaro_replay_notes).toHaveLength(0)
  })
})

describe('replay notes — CRUD', () => {
  it('adds notes and lists them earliest moment first, with the author', async () => {
    await addNote(90_000, 'Second thing')
    const first = await addNote(5_250.7, 'Save greys out <b>here</b>')
    expect(first.at_ms).toBe(5250)
    expect(first.user_name).toBe('Ada Admin')
    const res = await call('GET', `/${REC}/notes`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.map((n: { text: string }) => n.text)).toEqual([
      'Save greys out <b>here</b>',
      'Second thing'
    ])
    // Text is data: stored and answered verbatim, never interpreted.
    expect(body.data[0].text).toContain('<b>')
    expect(body.targets.issues).toEqual([{ id: 12, title: 'Save fails', status: 'open' }])
    expect(body.targets.investigations).toEqual([
      { id: INV, title: 'Slow saves', updated_at: 'x', created_by_name: 'Ada' }
    ])
    expect(h.activity.filter((a) => a.action === 'session-replay-note')).toHaveLength(2)
  })

  it('rejects empty text, bad offsets and unknown recordings', async () => {
    expect((await call('POST', `/${REC}/notes`, { at_ms: 1, text: '   ' })).statusCode).toBe(400)
    expect((await call('POST', `/${REC}/notes`, { at_ms: -1, text: 'x' })).statusCode).toBe(400)
    expect((await call('POST', `/${REC}/notes`, { text: 'x' })).statusCode).toBe(400)
    const missing = 'dddddddd-4444-4444-8444-444444444444'
    expect((await call('POST', `/${missing}/notes`, { at_ms: 1, text: 'x' })).statusCode).toBe(404)
    expect((await call('GET', '/not-a-uuid/notes')).statusCode).toBe(404)
  })

  it('caps the text', async () => {
    const n = await addNote(1, 'x'.repeat(5000))
    expect(n.text).toHaveLength(2000)
  })

  it('lets only the author edit, any admin delete', async () => {
    const n = await addNote(1000, 'typo')
    const other = await call('PATCH', `/${REC}/notes/${n.id}`, { text: 'hijack' }, 'admin2')
    expect(other.statusCode).toBe(403)
    const mine = await call('PATCH', `/${REC}/notes/${n.id}`, { text: 'fixed', at_ms: 2000 })
    expect(mine.statusCode).toBe(200)
    expect(mine.json().data).toMatchObject({ text: 'fixed', at_ms: 2000 })
    // A note is reached only through its own recording.
    expect((await call('DELETE', `/${OTHER_REC}/notes/${n.id}`)).statusCode).toBe(404)
    const del = await call('DELETE', `/${REC}/notes/${n.id}`, undefined, 'admin2')
    expect(del.statusCode).toBe(200)
    expect(h.db.tables.nivaro_replay_notes).toHaveLength(0)
    expect(h.activity.some((a) => a.action === 'session-replay-note-delete')).toBe(true)
  })

  it('answers an empty list, not an error, before migration 423', async () => {
    delete h.db.tables.nivaro_replay_notes
    // notesReady caches per process for a minute; a fresh module sees the miss.
    vi.resetModules()
    const { sessionReplayNotesRoutes: fresh } = await import(
      '../../../routes/session-replay-notes.js'
    )
    const app = Fastify()
    await app.register(fresh, { prefix: '/api/session-recordings' })
    const res = await app.inject({
      method: 'GET',
      url: `/api/session-recordings/${REC}/notes`,
      headers: { 'x-test-user': 'admin' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: [], ready: false })
  })
})

describe('replay notes — copy', () => {
  it('copies onto the linked issue as a comment with a deep link to the second', async () => {
    const n = await addNote(83_400, 'Save greys out')
    const res = await call('POST', `/${REC}/notes/${n.id}/copy`, { issue_id: 12 })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ target: 'issue', id: 12 })
    const [c] = h.db.tables.nivaro_comments
    expect(c).toMatchObject({ collection: 'nivaro_issues', item: '12', user: ADMIN })
    expect(c.text).toBe(
      `Replay note at 1:23: Save greys out\nWatch: /session-replays?recording=${REC}&t=83400`
    )
    expect(h.activity.at(-1)).toMatchObject({
      action: 'session-replay-note-copy',
      collection: 'nivaro_issues',
      item: '12'
    })
  })

  it('refuses an issue that is not linked to this recording', async () => {
    const n = await addNote(1, 'x')
    const res = await call('POST', `/${REC}/notes/${n.id}/copy`, { issue_id: 13 })
    expect(res.statusCode).toBe(404)
    expect(h.db.tables.nivaro_comments).toHaveLength(0)
  })

  it('appends to an investigation notebook', async () => {
    const n = await addNote(65_000, 'Spinner never stops')
    const res = await call('POST', `/${REC}/notes/${n.id}/copy`, { investigation_id: INV })
    expect(res.statusCode).toBe(200)
    expect(h.investigations[0].notes).toBe(
      `First lead\n\n[Replay 1:05] Spinner never stops\n/session-replays?recording=${REC}&t=65000`
    )
  })

  it('says when the notebook is full instead of cutting it', async () => {
    h.investigations[0].notes = 'y'.repeat(390)
    const n = await addNote(1, 'Does not fit')
    const res = await call('POST', `/${REC}/notes/${n.id}/copy`, { investigation_id: INV })
    expect(res.statusCode).toBe(409)
    expect(h.investigations[0].notes).toBe('y'.repeat(390))
  })

  it('wants exactly one target', async () => {
    const n = await addNote(1, 'x')
    expect((await call('POST', `/${REC}/notes/${n.id}/copy`, {})).statusCode).toBe(400)
    expect(
      (await call('POST', `/${REC}/notes/${n.id}/copy`, { issue_id: 12, investigation_id: INV }))
        .statusCode
    ).toBe(400)
  })
})
