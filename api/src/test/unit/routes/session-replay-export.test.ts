import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryKnex } from '../../fixtures/memory-knex.js'

/**
 * #1375 — export a recording: the self-contained HTML (rrweb inlined, events
 * inlined as stored with </script> neutralised, the window cut at a full
 * snapshot) and the WebM job (queued, captured, stored, notified, logged).
 */

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('../../fixtures/memory-knex.js').memoryKnex>,
  activity: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../db/index.js', () => ({
  db: new Proxy(() => {}, {
    apply: (_t, _this, args: [string]) => h.db(args[0]),
    get: (_t, k) => (h.db as unknown as Record<string | symbol, unknown>)[k]
  })
}))
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (row: Record<string, unknown>) => {
    h.activity.push(row)
    return 1
  }
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (
    req: { headers: Record<string, string>; user?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    if (req.headers['x-test-user'] !== 'admin') return reply.code(403).send({ error: 'Admin only' })
    req.user = { id: ADMIN }
  }
}))

import { sessionReplayExportRoutes } from '../../../routes/session-replay-export.js'
import { cutReplayWindow, type RrwebEvent } from '../../../services/session-replay-events.js'
import {
  runWebmExport,
  setWebmDepsForTests,
  type WebmDeps,
  whenExportsIdle
} from '../../../services/session-replay-export.js'

const REC = '6f1c2b3a-1234-4abc-9def-0123456789ab'
const ADMIN = 'aaaaaaaa-1111-4111-8111-111111111111'
const T0 = 1_700_000_000_000
const EVIL = '</script><script>alert(1)</script>'

const meta = (t: number) => ({
  type: 4,
  timestamp: T0 + t,
  data: { href: 'https://app.test/x', width: 1280, height: 800 }
})
const snap = (t: number, text: string) => ({
  type: 2,
  timestamp: T0 + t,
  data: { node: { id: 1, type: 0, childNodes: [{ id: 2, type: 3, textContent: text }] } }
})
const move = (t: number) => ({ type: 3, timestamp: T0 + t, data: { source: 1, positions: [] } })

const EVENTS: RrwebEvent[] = [
  meta(0),
  snap(0, 'first page'),
  move(4000),
  meta(10_000),
  snap(10_000, `second page ${EVIL}`),
  move(13_000),
  move(20_000)
]

const gz = (events: unknown[]) =>
  `gz:${gzipSync(Buffer.from(JSON.stringify(events))).toString('base64')}`

async function post(body: unknown, user = 'admin') {
  const app = Fastify()
  await app.register(sessionReplayExportRoutes, { prefix: '/api/session-recordings' })
  return app.inject({
    method: 'POST',
    url: `/api/session-recordings/${REC}/export`,
    payload: body as Record<string, unknown>,
    headers: { 'x-test-user': user }
  })
}

function inlined(html: string, id: string): unknown {
  const m = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(
    html
  )
  if (!m) throw new Error(`no ${id}`)
  return JSON.parse(m[1])
}

beforeEach(() => {
  h.db = memoryKnex({
    nivaro_session_recordings: [{ id: REC, user: ADMIN, started_at: new Date(T0) }],
    nivaro_users: [{ id: ADMIN, first_name: 'Ada', last_name: 'Admin', email: 'ada@x.test' }],
    // Two chunks, the second still in the pre-gzip plain-JSON shape.
    nivaro_session_events: [
      { recording: REC, seq: 0, events: gz(EVENTS.slice(0, 3)) },
      { recording: REC, seq: 1, events: JSON.stringify(EVENTS.slice(3)) }
    ]
  })
  h.activity = []
  setWebmDepsForTests(null)
})

describe('cutReplayWindow', () => {
  it('opens at the latest full snapshot (and its Meta) at or before from, and stops at to', () => {
    const w = cutReplayWindow(EVENTS, 12_000, 15_000)
    expect(w?.events.map((e) => e.timestamp - T0)).toEqual([10_000, 10_000, 13_000])
    expect(w?.events[0].type).toBe(4)
    expect(w).toMatchObject({
      startOffsetMs: 2000,
      endOffsetMs: 5000,
      fromMs: 12_000,
      toMs: 15_000
    })
  })

  it('keeps the whole recording without a window', () => {
    const w = cutReplayWindow(EVENTS)
    expect(w?.events).toHaveLength(EVENTS.length)
    expect(w).toMatchObject({ startOffsetMs: 0, endOffsetMs: 20_000 })
  })

  it('has nothing to replay without a full snapshot', () => {
    expect(cutReplayWindow([meta(0), move(10)])).toBeNull()
  })
})

describe('POST /session-recordings/:id/export — html', () => {
  it('refuses non-admins', async () => {
    expect((await post({ format: 'html' }, 'user')).statusCode).toBe(403)
    expect(h.activity).toHaveLength(0)
  })

  it('validates the format and the window', async () => {
    expect((await post({ format: 'gif' })).statusCode).toBe(400)
    expect((await post({ format: 'html', from_ms: 5000, to_ms: 1000 })).statusCode).toBe(400)
    expect((await post({ format: 'html', from_ms: -1 })).statusCode).toBe(400)
    expect((await post({ format: 'webm', from_ms: 0, to_ms: 31 * 60_000 })).statusCode).toBe(400)
  })

  it('answers a self-contained page: rrweb and the events inlined, </script> neutralised', async () => {
    const res = await post({ format: 'html' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers['content-disposition']).toBe('attachment; filename="replay-6f1c2b3a.html"')
    const html = res.body
    // rrweb's replayer is in the file, nothing is fetched.
    expect(html).toContain('Replayer')
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toContain('//# sourceMappingURL=rrweb')
    // The masked/stored text survives as data but cannot close the script element.
    expect(html).not.toContain(EVIL)
    expect(html).toContain('\\u003c/script>')
    const events = inlined(html, 'nvr-events') as RrwebEvent[]
    expect(events).toEqual(EVENTS)
    expect(inlined(html, 'nvr-config')).toEqual({ start: 0, end: 20_000, capture: false })
    expect(h.activity).toEqual([
      expect.objectContaining({
        action: 'session-recording-export',
        item: REC,
        user: ADMIN,
        comment: 'html: 7 event(s), 0:00–0:20'
      })
    ])
  })

  it('cuts the window', async () => {
    const res = await post({ format: 'html', from_ms: 12_000, to_ms: 15_000 })
    expect(res.statusCode).toBe(200)
    const events = inlined(res.body, 'nvr-events') as RrwebEvent[]
    expect(events.map((e) => e.timestamp - T0)).toEqual([10_000, 10_000, 13_000])
    expect(inlined(res.body, 'nvr-config')).toEqual({ start: 2000, end: 5000, capture: false })
  })

  it('answers 404 for an unknown recording and 422 when nothing can be replayed', async () => {
    h.db.tables.nivaro_session_recordings = []
    expect((await post({ format: 'html' })).statusCode).toBe(404)
    h.db.tables.nivaro_session_recordings = [{ id: REC, user: ADMIN }]
    h.db.tables.nivaro_session_events = [{ recording: REC, seq: 0, events: gz([meta(0), move(1)]) }]
    expect((await post({ format: 'html' })).statusCode).toBe(422)
  })
})

function fakeDeps(over: Partial<WebmDeps> = {}) {
  const calls = {
    capture: [] as Array<Record<string, unknown>>,
    stored: [] as string[],
    notified: [] as Array<Record<string, unknown>>,
    activity: [] as Array<Record<string, unknown>>,
    run: [] as string[]
  }
  const deps: WebmDeps = {
    loadEvents: async () => EVENTS,
    loadHeader: async (id) => ({ id, user_name: 'Ada Admin', started_at: new Date(T0) }),
    capture: async (o) => {
      calls.capture.push({ viewport: o.viewport, durationMs: o.durationMs, html: o.html })
      await writeFile(o.outPath, Buffer.from('webm-bytes'))
    },
    hasFfmpeg: async () => true,
    storeFile: async (_u, _p, name) => {
      calls.stored.push(name)
      return { id: 'file-1' }
    },
    notify: async (userId, n) => {
      calls.notified.push({ userId, ...n })
    },
    logActivity: async (row) => {
      calls.activity.push(row)
    },
    jobRun: async () => ({
      progress: () => {},
      complete: async (o) => {
        calls.run.push(`complete ${o}`)
      },
      fail: async (e) => {
        calls.run.push(`fail ${String(e)}`)
      }
    }),
    workDir: () => join(tmpdir(), 'nvr-replay-export-test'),
    heavySlot: async (_l, work) => work(),
    ...over
  }
  return { deps, calls }
}

describe('POST /session-recordings/:id/export — webm', () => {
  it('queues a job, logs it, and the job captures, stores and notifies', async () => {
    const { deps, calls } = fakeDeps()
    setWebmDepsForTests(deps)
    const res = await post({ format: 'webm', from_ms: 12_000, to_ms: 15_000 })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ data: { format: 'webm', status: 'queued' } })
    expect(h.activity).toEqual([
      expect.objectContaining({
        action: 'session-recording-export',
        item: REC,
        comment: 'webm queued: 0:12–0:15'
      })
    ])
    await whenExportsIdle()
    expect(calls.capture).toHaveLength(1)
    expect(calls.capture[0]).toMatchObject({
      viewport: { width: 1280, height: 800 },
      durationMs: 3000
    })
    expect(String(calls.capture[0].html)).toContain('"capture":true')
    expect(calls.stored).toEqual(['replay-6f1c2b3a.webm'])
    expect(calls.notified).toEqual([
      expect.objectContaining({ userId: ADMIN, ok: true, fileId: 'file-1', recordingId: REC })
    ])
    expect(calls.activity[0]).toMatchObject({
      action: 'session-recording-export',
      comment: expect.stringContaining('webm ready: 0:12–0:15')
    })
    expect(calls.run[0]).toMatch(/^complete webm/)
  })

  it('fails the job and tells the requester why when ffmpeg is missing', async () => {
    const { deps, calls } = fakeDeps({ hasFfmpeg: async () => false })
    const out = await runWebmExport(
      { recordingId: REC, fromMs: null, toMs: null, userId: ADMIN },
      deps
    )
    expect(out).toEqual({ ok: false, error: 'ffmpeg is not available on this server' })
    expect(calls.capture).toHaveLength(0)
    expect(calls.notified[0]).toMatchObject({ ok: false, subject: 'Recording export failed' })
    expect(calls.run[0]).toMatch(/^fail/)
  })

  it('caps the frame width and keeps dimensions even', async () => {
    const wide = [{ ...meta(0), data: { width: 3841, height: 2161 } }, snap(0, 'x'), move(500)]
    const { deps, calls } = fakeDeps({ loadEvents: async () => wide })
    await runWebmExport({ recordingId: REC, fromMs: null, toMs: null, userId: ADMIN }, deps)
    expect(calls.capture[0].viewport).toEqual({ width: 1920, height: 1080 })
  })
})
