import type { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { get as httpGet, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /session-recordings/:id/events as a stream (2026-11-12): the answer is the stored
 * chunks' JSON joined on the way out, read from the database a bounded batch at a time,
 * never one array of every event. It must read back as exactly what the route sent before.
 */

interface Row {
  recording: string
  seq: number
  events: string
}

const h = vi.hoisted(() => ({
  rows: [] as Array<{ recording: string; seq: number; events: string }>,
  parts: [] as Array<{ id: string }>,
  /** Every read of the events table: which columns, how many rows came back, for whom. */
  reads: [] as Array<{ text: boolean; rows: number; chars: number; context?: string }>,
  /** Fail the n-th read that asks for chunk text (1-based); 0 = never. */
  failTextRead: 0,
  /** Delete this many of the newest chunks right after the list of chunks was read. */
  dropAfterPlan: 0,
  /** Delete the newest chunk just before the n-th read of chunk text is answered. */
  dropAtTextRead: 0,
  /** Hold the read of the list of chunks this long (a caller can leave meanwhile). */
  planDelayMs: 0,
  /** The async context a read ran in (set by the test's own request hook). */
  context: null as unknown as AsyncLocalStorage<string>
}))

vi.mock('../../../services/session-replay-storage.js', () => ({
  ensureRecordingHot: vi.fn(async () => ({ state: 'hot' })),
  deleteColdObject: vi.fn(async () => {}),
  purgeColdObjects: vi.fn(async () => 0)
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/session-recording-chain.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/session-recording-chain.js')>()),
  chainParts: vi.fn(async () => h.parts)
}))
vi.mock('../../../db/index.js', async () => {
  const hooks = await import('node:async_hooks')
  h.context = new hooks.AsyncLocalStorage<string>()
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()
  const db = vi.fn((_table: string) => {
    const tests: Array<(r: { recording: string; seq: number }) => boolean> = []
    const chain: Record<string, unknown> = {}
    chain.where = vi.fn((a: unknown, b?: unknown, c?: unknown) => {
      if (a && typeof a === 'object') {
        const want = (a as { recording?: string }).recording
        if (want !== undefined) tests.push((r) => same(r.recording, want))
      } else if (a === 'seq' && c !== undefined) {
        const n = Number(c)
        if (b === '>') tests.push((r) => r.seq > n)
        else if (b === '>=') tests.push((r) => r.seq >= n)
        else if (b === '<=') tests.push((r) => r.seq <= n)
        else throw new Error(`unexpected operator ${String(b)}`)
      } else throw new Error('unexpected where')
      return chain
    })
    chain.whereIn = vi.fn((_col: string, ids: string[]) => {
      tests.push((r) => ids.some((id) => same(id, r.recording)))
      return chain
    })
    chain.modify = vi.fn((fn: (qb: unknown) => void) => {
      fn(chain)
      return chain
    })
    chain.orderBy = vi.fn(() => chain)
    chain.select = vi.fn(async (...cols: unknown[]) => {
      const text = cols.includes('events')
      const nth = h.reads.filter((r) => r.text).length + 1
      if (text && h.dropAtTextRead === nth) h.rows = h.rows.slice(0, -1)
      const found = h.rows.filter((r) => tests.every((t) => t(r))).sort((a, b) => a.seq - b.seq)
      const chars = found.reduce((n, r) => n + r.events.length, 0)
      h.reads.push({
        text,
        rows: found.length,
        chars: text ? chars : 0,
        context: h.context.getStore()
      })
      if (text && h.failTextRead === nth) throw new Error('database went away')
      if (!text && h.dropAfterPlan > 0) h.rows = h.rows.slice(0, -h.dropAfterPlan)
      if (!text && h.planDelayMs > 0) await new Promise((r) => setTimeout(r, h.planDelayMs))
      return found.map((r) =>
        text
          ? { recording: r.recording, seq: r.seq, events: r.events }
          : { recording: r.recording, seq: r.seq, size: r.events.length }
      )
    })
    return chain
  })
  ;(db as unknown as Record<string, unknown>).raw = vi.fn((sql: string) => ({ sql }))
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async () => undefined,
  requireAuth: async () => undefined,
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { id: 'ADMIN' }
  }
}))

import { registerCompression } from '../../../plugins/compression.js'
import { sessionRecordingRoutes } from '../../../routes/session-recordings.js'

const REC = '6F1C2B3A-1234-4ABC-9DEF-0123456789AB'
const P2 = '7A2D3C4B-2345-4BCD-8EF0-123456789ABC'

const gz = (json: string) => `gz:${gzipSync(Buffer.from(json, 'utf8')).toString('base64')}`
const ev = (t: number, pad = '') => ({ type: 3, timestamp: t, data: { source: 1, pad } })

/** The route as it was: every chunk parsed into one array (corrupt ones skipped), then sent. */
function oldAnswer(rows: Row[]) {
  const events: unknown[] = []
  for (const c of rows) {
    try {
      const text = c.events.startsWith('gz:')
        ? gunzipSync(Buffer.from(c.events.slice(3), 'base64')).toString('utf8')
        : c.events
      events.push(...(JSON.parse(text) as unknown[]))
    } catch {
      /* skip corrupt chunk */
    }
  }
  return { data: { events, last_seq: rows[rows.length - 1].seq } }
}

let app: FastifyInstance | null = null

async function boot(opts: { compression?: boolean } = {}) {
  app = Fastify()
  if (opts.compression) await registerCompression(app)
  await app.register(sessionRecordingRoutes, { prefix: '/api/session-recordings' })
  return app
}

async function call(url: string, headers: Record<string, string> = {}) {
  const a = app ?? (await boot())
  return a.inject({ method: 'GET', url: `/api/session-recordings${url}`, headers })
}

/** The same read over a real socket, so a reader can stop reading or hang up. */
async function open(headers: Record<string, string> = {}) {
  const a = await boot({ compression: true })
  await a.listen({ port: 0, host: '127.0.0.1' })
  const port = (a.server.address() as AddressInfo).port
  return new Promise<{ req: ReturnType<typeof httpGet>; res: IncomingMessage }>(
    (resolve, reject) => {
      const req = httpGet(
        { host: '127.0.0.1', port, path: `/api/session-recordings/${REC}/events`, headers },
        (res) => resolve({ req, res })
      )
      req.on('error', reject)
    }
  )
}

beforeEach(() => {
  h.rows = []
  h.parts = [{ id: REC }]
  h.reads = []
  h.failTextRead = 0
  h.dropAfterPlan = 0
  h.dropAtTextRead = 0
  h.planDelayMs = 0
})

afterEach(async () => {
  await app?.close()
  app = null
})

describe('GET /session-recordings/:id/events', () => {
  it('answers the same events as before, in the same shape', async () => {
    h.rows = [
      { recording: REC, seq: 0, events: gz(JSON.stringify([ev(1), ev(2)])) },
      { recording: REC, seq: 1, events: JSON.stringify([ev(3)]) },
      { recording: REC, seq: 2, events: gz(JSON.stringify([ev(4), ev(5), ev(6)])) }
    ]
    const res = await call(`/${REC}/events`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(res.json()).toEqual(oldAnswer(h.rows))
    expect(res.payload).toBe(JSON.stringify(oldAnswer(h.rows)))
  })

  it('finds the recording whatever the letter case of the id in the address', async () => {
    h.rows = [{ recording: REC, seq: 0, events: gz(JSON.stringify([ev(1)])) }]
    h.parts = [{ id: REC }]
    const res = await call(`/${REC.toLowerCase()}/events`)
    expect(res.statusCode).toBe(200)
    expect(res.json().data.events).toHaveLength(1)
  })

  it('skips a chunk it cannot read and still plays the rest', async () => {
    h.rows = [
      { recording: REC, seq: 0, events: gz(JSON.stringify([ev(1)])) },
      { recording: REC, seq: 1, events: 'gz:bm90IGd6aXA=' },
      { recording: REC, seq: 2, events: '[{"type":3,' },
      { recording: REC, seq: 3, events: gz(JSON.stringify([ev(4)])) }
    ]
    const res = await call(`/${REC}/events`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(oldAnswer(h.rows))
    expect(res.json().data.events).toHaveLength(2)
    expect(res.json().data.last_seq).toBe(3)
  })

  it('answers 404 for a recording with no chunks', async () => {
    const res = await call(`/${REC}/events`)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'No events' })
  })

  it('reads the list of chunks without their text, then the text a bounded batch at a time', async () => {
    // Five chunks of ~400k stored characters: no batch may hold them all.
    const big = JSON.stringify([ev(1, 'x'.repeat(400_000))])
    h.rows = [0, 1, 2, 3, 4].map((seq) => ({ recording: REC, seq, events: big }))
    const res = await call(`/${REC}/events`)
    expect(res.statusCode).toBe(200)
    expect(res.json().data.events).toHaveLength(5)
    expect(h.reads[0]).toMatchObject({ text: false, rows: 5 })
    const textReads = h.reads.filter((r) => r.text)
    expect(textReads.length).toBeGreaterThan(1)
    expect(textReads.reduce((n, r) => n + r.rows, 0)).toBe(5)
    for (const r of textReads) expect(r.chars).toBeLessThanOrEqual(1_300_000)
  })

  describe('live follow (?after_seq=)', () => {
    beforeEach(() => {
      h.rows = [0, 1, 2, 3, 4].map((seq) => ({
        recording: REC,
        seq,
        events: gz(JSON.stringify([ev(seq)]))
      }))
    })

    it('answers only the chunks newer than the one named', async () => {
      const res = await call(`/${REC}/events?after_seq=2`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(oldAnswer(h.rows.slice(3)))
      expect(res.json().data.last_seq).toBe(4)
      // The text of the older chunks is never read.
      expect(h.reads.filter((r) => r.text).reduce((n, r) => n + r.rows, 0)).toBe(2)
    })

    it('answers an empty list, not a 404, when nothing is newer', async () => {
      const res = await call(`/${REC}/events?after_seq=4`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ data: { events: [], last_seq: 4 } })
      expect(h.reads.filter((r) => r.text)).toHaveLength(0)
    })
  })

  describe('a session that rolled over into parts', () => {
    beforeEach(() => {
      h.parts = [{ id: REC }, { id: P2 }]
      h.rows = [
        { recording: P2, seq: 3, events: gz(JSON.stringify([ev(30)])) },
        { recording: REC, seq: 0, events: gz(JSON.stringify([ev(1)])) },
        // The second part's copied opening: skipped when the chain is read whole.
        { recording: P2, seq: -1, events: gz(JSON.stringify([ev(999)])) },
        { recording: REC, seq: 1, events: gz(JSON.stringify([ev(2)])) },
        { recording: P2, seq: 2, events: gz(JSON.stringify([ev(20)])) }
      ]
    })

    it('reads as one recording: parts in order, copied openings left out', async () => {
      const res = await call(`/${P2}/events`)
      expect(res.statusCode).toBe(200)
      expect(res.json().data.events.map((e: { timestamp: number }) => e.timestamp)).toEqual([
        1, 2, 20, 30
      ])
      expect(res.json().data.last_seq).toBe(3)
    })

    it('live follow continues across parts', async () => {
      const res = await call(`/${REC}/events?after_seq=1`)
      expect(res.json().data.events.map((e: { timestamp: number }) => e.timestamp)).toEqual([
        20, 30
      ])
      expect(res.json().data.last_seq).toBe(3)
    })
  })

  describe('on the wire', () => {
    beforeEach(() => {
      h.rows = [0, 1, 2].map((seq) => ({
        recording: REC,
        seq,
        events: gz(JSON.stringify([ev(seq, 'abc '.repeat(2_000))]))
      }))
    })

    it('stays compressed: brotli for a browser, and reads back the same', async () => {
      await boot({ compression: true })
      const res = await call(`/${REC}/events`, { 'accept-encoding': 'gzip, deflate, br' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-encoding']).toBe('br')
      expect(String(res.headers.vary)).toContain('accept-encoding')
      const text = brotliDecompressSync(res.rawPayload).toString('utf8')
      expect(JSON.parse(text)).toEqual(oldAnswer(h.rows))
      expect(res.rawPayload.length).toBeLessThan(text.length / 5)
    })

    it('gzip when that is all the caller takes, plain when it takes neither', async () => {
      await boot({ compression: true })
      const zipped = await call(`/${REC}/events`, { 'accept-encoding': 'gzip' })
      expect(zipped.headers['content-encoding']).toBe('gzip')
      expect(JSON.parse(gunzipSync(zipped.rawPayload).toString('utf8'))).toEqual(oldAnswer(h.rows))
      const plain = await call(`/${REC}/events`)
      expect(plain.headers['content-encoding']).toBeUndefined()
      expect(plain.json()).toEqual(oldAnswer(h.rows))
    })
  })

  describe('when the read fails', () => {
    it('a failure on the first batch is an ordinary error answer, nothing half-sent', async () => {
      h.rows = [{ recording: REC, seq: 0, events: gz(JSON.stringify([ev(1)])) }]
      h.failTextRead = 1
      await boot({ compression: true })
      const res = await call(`/${REC}/events`, { 'accept-encoding': 'br' })
      expect(res.statusCode).toBe(500)
      // Not marked compressed: the caller can read why it failed.
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.json().message).toBe('database went away')
    })
  })

  describe('a recording that changes while it is read', () => {
    // Its chunks can go between the list and a batch (the hot cache of a recording kept in
    // storage is dropped hourly; a recording can be deleted). The answer is the whole
    // recording or an error — never a quietly shorter replay.
    it('answers an error when chunks are gone before the first batch', async () => {
      h.rows = [0, 1, 2].map((seq) => ({
        recording: REC,
        seq,
        events: gz(JSON.stringify([ev(seq)]))
      }))
      h.dropAfterPlan = 2
      const res = await call(`/${REC}/events`)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('RECORDING_CHANGED')
    })

    it('cuts the answer short, as a failure, when chunks go part-way', async () => {
      const big = JSON.stringify([ev(1, 'x'.repeat(1_000_000))])
      h.rows = Array.from({ length: 6 }, (_, seq) => ({ recording: REC, seq, events: big }))
      h.dropAtTextRead = 3
      const { res } = await open()
      expect(res.statusCode).toBe(200)
      const bufs: Buffer[] = []
      res.on('data', (b: Buffer) => bufs.push(b))
      await new Promise<void>((resolve) => res.once('close', () => resolve()))
      // The connection was dropped before the end of the answer: a reader sees a failed
      // request, not a complete (shorter) list of events.
      expect(res.complete).toBe(false)
      expect(() => JSON.parse(Buffer.concat(bufs).toString('utf8'))).toThrow()
    })
  })

  describe('the request it belongs to', () => {
    it('reads every batch in the request’s own context, also the ones asked for later', async () => {
      // The database handle is picked per request context (a cloud tenant's database, the
      // pool); batches after the first are asked for by the response stream.
      const big = JSON.stringify([ev(1, 'x'.repeat(1_000_000))])
      h.rows = Array.from({ length: 8 }, (_, seq) => ({ recording: REC, seq, events: big }))
      const a = Fastify()
      app = a
      a.addHook('onRequest', (req, _reply, done) => {
        h.context.run(`request ${req.headers['x-tenant']}`, done)
      })
      await registerCompression(a)
      await a.register(sessionRecordingRoutes, { prefix: '/api/session-recordings' })
      const [one, two] = await Promise.all([
        a.inject({
          method: 'GET',
          url: `/api/session-recordings/${REC}/events`,
          headers: { 'x-tenant': 'A', 'accept-encoding': 'br' }
        }),
        a.inject({
          method: 'GET',
          url: `/api/session-recordings/${REC}/events`,
          headers: { 'x-tenant': 'B', 'accept-encoding': 'gzip' }
        })
      ])
      expect(one.statusCode).toBe(200)
      expect(two.statusCode).toBe(200)
      const text = h.reads.filter((r) => r.text)
      expect(text).toHaveLength(16)
      expect(text.filter((r) => r.context === 'request A')).toHaveLength(8)
      expect(text.filter((r) => r.context === 'request B')).toHaveLength(8)
    })
  })

  describe('a caller that stops reading or goes away', () => {
    /** Sixty chunks of ~1M characters, each its own batch: far more than any socket buffers. */
    function fillBig() {
      const big = JSON.stringify([ev(1, 'x'.repeat(1_000_000))])
      h.rows = Array.from({ length: 60 }, (_, seq) => ({ recording: REC, seq, events: big }))
    }
    const textReads = () => h.reads.filter((r) => r.text).length
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

    it('stops fetching chunks while the caller is not reading', async () => {
      fillBig()
      const { req, res } = await open()
      expect(res.statusCode).toBe(200)
      res.pause()
      await settle(300)
      const paused = textReads()
      // The socket's buffers fill and the read waits: most of the recording is still unread.
      expect(paused).toBeLessThan(40)
      await settle(200)
      expect(textReads()).toBe(paused)
      req.destroy()
    })

    it('ends the read when the caller leaves part-way', async () => {
      fillBig()
      const { req, res } = await open()
      await new Promise<void>((resolve) => res.once('data', () => resolve()))
      req.destroy()
      await settle(300)
      const left = textReads()
      expect(left).toBeLessThan(40)
      await settle(200)
      expect(textReads()).toBe(left)
    })

    it('reads no more than the first batch for a caller who left before the answer began', async () => {
      fillBig()
      h.planDelayMs = 150
      const a = await boot({ compression: true })
      await a.listen({ port: 0, host: '127.0.0.1' })
      const port = (a.server.address() as AddressInfo).port
      const req = httpGet({
        host: '127.0.0.1',
        port,
        path: `/api/session-recordings/${REC}/events`,
        headers: { 'accept-encoding': 'gzip' }
      })
      req.on('error', () => {})
      // Gone while the server is still listing the chunks.
      await settle(50)
      req.destroy()
      await settle(400)
      expect(textReads()).toBeLessThanOrEqual(1)
      // The process is fine: the next caller is answered.
      h.planDelayMs = 0
      const next = await a.inject({
        method: 'GET',
        url: `/api/session-recordings/${REC}/events?after_seq=59`
      })
      expect(next.statusCode).toBe(200)
      expect(next.json()).toEqual({ data: { events: [], last_seq: 59 } })
    })

    it('ends the read when the caller leaves a compressed answer part-way', async () => {
      // Text gzip cannot shrink much, so the compressed answer still fills the socket.
      const noise = randomBytes(750_000).toString('base64')
      const big = JSON.stringify([ev(1, noise)])
      h.rows = Array.from({ length: 60 }, (_, seq) => ({ recording: REC, seq, events: big }))
      const { req, res } = await open({ 'accept-encoding': 'gzip' })
      expect(res.headers['content-encoding']).toBe('gzip')
      await new Promise<void>((resolve) => res.once('data', () => resolve()))
      req.destroy()
      await settle(300)
      const left = textReads()
      expect(left).toBeLessThan(40)
      await settle(200)
      expect(textReads()).toBe(left)
    })
  })
})
