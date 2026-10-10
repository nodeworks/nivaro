import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKOFF_MAX_MS,
  backoffDelay,
  classifyUploadError,
  idbChunkStore,
  isResumable,
  KEEPALIVE_BUDGET,
  memoryChunkStore,
  packKeepalive,
  type QueuedChunk,
  RESUME_WINDOW_MS,
  ReplayUploader,
  readResume,
  splitBySize,
  writeResume
} from './replayUploadQueue'

type Send = (id: string, seq: number, events: unknown[], keepalive: boolean) => Promise<void>

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })
const axiosError = (status: number) => Object.assign(new Error('x'), { response: { status } })
const networkError = () => new TypeError('Failed to fetch')

function setup(send: Send, opts: { online?: () => boolean; maxBytes?: number } = {}) {
  const store = memoryChunkStore()
  const calls: Array<{ id: string; seq: number; keepalive: boolean }> = []
  const uploader = new ReplayUploader({
    store,
    send: async (id, seq, events, keepalive) => {
      calls.push({ id, seq, keepalive })
      await send(id, seq, events, keepalive)
    },
    online: opts.online,
    maxBytes: opts.maxBytes
  })
  return { store, calls, uploader }
}

const ev = (n: number) => ({ type: 3, timestamp: n, data: { n } })

afterEach(() => vi.restoreAllMocks())

describe('backoffDelay', () => {
  it('doubles from 2s and caps at 60s, jittered within the upper half', () => {
    const top = () => 1
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((a) => backoffDelay(a, top))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000
    ])
    expect(backoffDelay(1, () => 0)).toBe(1_000)
    expect(backoffDelay(10, () => 0)).toBe(BACKOFF_MAX_MS / 2)
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(3)
      expect(d).toBeGreaterThanOrEqual(4_000)
      expect(d).toBeLessThanOrEqual(8_000)
    }
  })
})

describe('classifyUploadError', () => {
  it('sorts statuses into retry / drop-chunk / closed / abandon', () => {
    expect(classifyUploadError(undefined)).toBe('retry')
    expect(classifyUploadError(500)).toBe('retry')
    expect(classifyUploadError(503)).toBe('retry')
    expect(classifyUploadError(429)).toBe('retry')
    expect(classifyUploadError(413)).toBe('drop-chunk')
    expect(classifyUploadError(409)).toBe('closed')
    expect(classifyUploadError(403)).toBe('abandon')
    expect(classifyUploadError(404)).toBe('abandon')
  })
})

describe('ReplayUploader', () => {
  it('assigns seq once at enqueue and drains in order', async () => {
    const { uploader, calls, store } = setup(async () => {})
    uploader.begin('R1')
    uploader.enqueue([ev(1)])
    uploader.enqueue([ev(2)])
    uploader.enqueue([ev(3)])
    expect(uploader.seqs()).toEqual([0, 1, 2])
    expect((await store.list('R1')).map((c) => c.seq)).toEqual([0, 1, 2])
    expect(await uploader.drain()).toBe('ok')
    expect(calls.map((c) => c.seq)).toEqual([0, 1, 2])
    expect(uploader.hasPending()).toBe(false)
    expect(await store.list('R1')).toEqual([])
  })

  it('keeps a chunk on a network error / 5xx and re-sends the SAME seq', async () => {
    let fail = 2
    const { uploader, calls } = setup(async () => {
      if (fail-- > 0) throw fail === 1 ? networkError() : axiosError(502)
    })
    uploader.begin('R1')
    uploader.enqueue([ev(1)])
    uploader.enqueue([ev(2)])
    expect(await uploader.drain()).toBe('retry')
    expect(uploader.attempt).toBe(1)
    expect(await uploader.drain()).toBe('retry')
    expect(uploader.attempt).toBe(2)
    uploader.enqueue([ev(3)])
    expect(await uploader.drain()).toBe('ok')
    expect(uploader.attempt).toBe(0)
    expect(calls.map((c) => c.seq)).toEqual([0, 0, 0, 1, 2])
  })

  it('does not try while offline', async () => {
    let online = false
    const { uploader, calls } = setup(async () => {}, { online: () => online })
    uploader.begin('R1')
    uploader.enqueue([ev(1)])
    expect(await uploader.drain()).toBe('offline')
    expect(calls).toEqual([])
    online = true
    expect(await uploader.drain()).toBe('ok')
    expect(calls.map((c) => c.seq)).toEqual([0])
  })

  it('drops only the chunk on 413 and keeps going', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { uploader, calls } = setup(async (_id, seq) => {
      if (seq === 1) throw httpError(413)
    })
    uploader.begin('R1')
    for (const n of [1, 2, 3]) uploader.enqueue([ev(n)])
    expect(await uploader.drain()).toBe('ok')
    expect(calls.map((c) => c.seq)).toEqual([0, 1, 2])
    expect(uploader.hasPending()).toBe(false)
  })

  it('409 ends the recording: queue cleared, memory and store', async () => {
    const { uploader, store } = setup(async (_id, seq) => {
      if (seq === 1) throw axiosError(409)
    })
    uploader.begin('R1')
    for (const n of [1, 2, 3]) uploader.enqueue([ev(n)])
    expect(await uploader.drain()).toBe('closed')
    expect(uploader.hasPending()).toBe(false)
    expect(await store.list('R1')).toEqual([])
  })

  it('403 / 404 abandon the recording: it will never take a chunk', async () => {
    for (const status of [403, 404]) {
      const { uploader, store } = setup(async () => {
        throw httpError(status)
      })
      uploader.begin('R1')
      uploader.enqueue([ev(1)])
      uploader.enqueue([ev(2)])
      expect(await uploader.drain()).toBe('abandoned')
      expect(uploader.hasPending()).toBe(false)
      expect(await store.list('R1')).toEqual([])
    }
  })

  it('bounds the queue by bytes, dropping the oldest', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const big = 'x'.repeat(400)
    const { uploader } = setup(async () => {}, { maxBytes: 1_000 })
    uploader.begin('R1')
    for (let i = 0; i < 5; i++) uploader.enqueue([{ big, i }])
    expect(uploader.bytes).toBeLessThanOrEqual(1_000)
    expect(uploader.seqs()).toEqual([3, 4])
    // A single chunk over the cap still stays — never drop the last one.
    uploader.enqueue([{ big: 'y'.repeat(5_000) }])
    expect(uploader.seqs()).toEqual([5])
  })

  it('sends small chunks with keepalive only when asked', async () => {
    const { uploader, calls } = setup(async () => {})
    uploader.begin('R1')
    uploader.enqueue([ev(1)])
    uploader.enqueue([{ big: 'x'.repeat(70_000) }])
    await uploader.drain(true)
    expect(calls.map((c) => c.keepalive)).toEqual([true, false])
    uploader.enqueue([ev(2)])
    await uploader.drain(false)
    expect(calls[2].keepalive).toBe(false)
  })
})

describe('resume', () => {
  it('restores the previous page’s chunks first and continues seq', async () => {
    const { uploader, calls, store } = setup(async () => {})
    const left: QueuedChunk[] = [5, 6].map((seq) => ({
      recordingId: 'R1',
      seq,
      events: [ev(seq)],
      bytes: 30,
      at: Date.now()
    }))
    for (const c of left) await store.put(c)
    uploader.begin('R1', 6, { trusted: false, restored: await store.list('R1') })
    expect(uploader.nextSeq).toBe(7)
    uploader.enqueue([ev(7)])
    expect(await uploader.drain()).toBe('ok')
    expect(calls.map((c) => c.seq)).toEqual([5, 6, 7])
    expect(uploader.trusted).toBe(true)
  })

  it('a resumed id refused before any chunk landed is stale: rebase onto a fresh one', async () => {
    const { uploader, calls, store } = setup(async (id) => {
      if (id === 'OLD') throw httpError(409)
    })
    const left: QueuedChunk = { recordingId: 'OLD', seq: 4, events: [ev(4)], bytes: 30, at: 1 }
    await store.put(left)
    uploader.begin('OLD', 5, { trusted: false, restored: [left] })
    uploader.enqueue([ev(5)]) // this page's opening snapshot
    uploader.enqueue([ev(6)])
    expect(await uploader.drain()).toBe('stale')
    // The previous page's leftover is gone; this page's chunks wait.
    expect(uploader.seqs()).toEqual([5, 6])
    uploader.rebase('NEW')
    expect(uploader.seqs()).toEqual([0, 1])
    expect(await store.list('OLD')).toEqual([])
    expect((await store.list('NEW')).map((c) => c.events)).toEqual([[ev(5)], [ev(6)]])
    expect(await uploader.drain()).toBe('ok')
    expect(calls.filter((c) => c.id === 'NEW').map((c) => c.seq)).toEqual([0, 1])
  })

  it('once trusted, a 409 on a resumed id ends it instead', async () => {
    const { uploader } = setup(async (_id, seq) => {
      if (seq === 6) throw httpError(409)
    })
    uploader.begin('R1', 5, { trusted: false })
    uploader.enqueue([ev(5)])
    uploader.enqueue([ev(6)])
    expect(await uploader.drain()).toBe('closed')
  })

  it('is only resumable within the window and for the same user', () => {
    const rec = {
      recordingId: 'R1',
      nextSeq: 3,
      startedAt: 0,
      lastActivityAt: 1_000_000,
      userId: 'U1'
    }
    expect(isResumable(rec, 1_000_000 + RESUME_WINDOW_MS, 'U1')).toBe(true)
    expect(isResumable(rec, 1_000_000 + RESUME_WINDOW_MS + 1, 'U1')).toBe(false)
    expect(isResumable(rec, 1_000_000 + 5_000, 'U2')).toBe(false)
    expect(isResumable(rec, 1_000_000 - 1, 'U1')).toBe(false)
    expect(isResumable(null, 1_000_000, 'U1')).toBe(false)
  })

  it('round-trips the record through storage and ignores junk', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k)
    }
    const rec = { recordingId: 'R1', nextSeq: 3, startedAt: 10, lastActivityAt: 20, userId: 'U1' }
    writeResume(storage, 'k', rec)
    expect(readResume(storage, 'k')).toEqual(rec)
    data.set('k', '{"recordingId":5}')
    expect(readResume(storage, 'k')).toBeNull()
    data.set('k', 'not json')
    expect(readResume(storage, 'k')).toBeNull()
    expect(readResume(null, 'k')).toBeNull()
  })
})

describe('keepalive packing', () => {
  const chunk = (seq: number, size: number): QueuedChunk => ({
    recordingId: 'R1',
    seq,
    events: [{ s: 'x'.repeat(size) }],
    bytes: size,
    at: 0
  })

  it('takes chunks in order until the budget is spent, never skipping ahead', () => {
    const packed = packKeepalive(
      [chunk(0, 20_000), chunk(1, 20_000), chunk(2, 30_000), chunk(3, 10)],
      60_000
    )
    expect(packed.map((p) => p.chunk.seq)).toEqual([0, 1])
    expect(JSON.parse(packed[0].body)).toEqual({ seq: 0, events: [{ s: 'x'.repeat(20_000) }] })
    const total = packed.reduce((n, p) => n + new TextEncoder().encode(p.body).length, 0)
    expect(total).toBeLessThanOrEqual(60_000)
  })

  it('counts UTF-8 bytes, not characters', () => {
    const wide: QueuedChunk = { ...chunk(0, 0), events: [{ s: 'é'.repeat(20_000) }] }
    expect(packKeepalive([wide], 30_000)).toEqual([])
  })

  it('skips the chunk already on the wire and charges its keepalive bytes', async () => {
    let release: () => void = () => {}
    const { uploader } = setup(
      (_id, seq) =>
        new Promise<void>((resolve) => {
          if (seq === 0) release = resolve
          else resolve()
        })
    )
    uploader.begin('R1')
    uploader.enqueue([{ s: 'x'.repeat(40_000) }])
    uploader.enqueue([{ s: 'y'.repeat(15_000) }])
    uploader.enqueue([{ s: 'z'.repeat(15_000) }])
    const draining = uploader.drain(true)
    // seq 0 (≈40KB, keepalive) is in flight: only ~20KB of budget is left.
    expect(uploader.keepaliveBatch(KEEPALIVE_BUDGET).map((p) => p.chunk.seq)).toEqual([1])
    release()
    await draining
  })

  it('splitBySize honours the keepalive chunk size', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ i, s: 'x'.repeat(10_000) }))
    const parts = splitBySize(events, 60_000)
    expect(parts.length).toBe(2)
    for (const p of parts) expect(JSON.stringify(p).length).toBeLessThanOrEqual(60_000)
    expect(parts.flat()).toEqual(events)
  })
})

describe('idbChunkStore', () => {
  it('falls back to memory without IndexedDB', async () => {
    const store = idbChunkStore(null)
    await store.put({ recordingId: 'R1', seq: 0, events: [1], bytes: 3, at: 5 })
    await store.put({ recordingId: 'R2', seq: 0, events: [2], bytes: 3, at: 50 })
    expect((await store.list('R1')).length).toBe(1)
    await store.prune(10)
    expect(await store.list('R1')).toEqual([])
    expect((await store.list('R2')).length).toBe(1)
  })
})

describe('route, build and retries (#1368)', () => {
  it('sends each chunk with the route and build it was queued with', async () => {
    const extras: unknown[] = []
    const uploader = new ReplayUploader({
      store: memoryChunkStore(),
      send: async (_id, _seq, _events, _keepalive, extra) => {
        extras.push(extra)
      }
    })
    uploader.begin('R1')
    uploader.enqueue([ev(1)], { route: '/content/orders/:id', build: '0.2.35' })
    uploader.enqueue([ev(2)])
    expect(await uploader.drain()).toBe('ok')
    expect(extras).toEqual([{ route: '/content/orders/:id', build: '0.2.35' }, {}])
  })

  it('reports the failed attempts on the next successful upload, then stops', async () => {
    const extras: Array<{ retries?: number }> = []
    let fail = 2
    const uploader = new ReplayUploader({
      store: memoryChunkStore(),
      send: async (_id, _seq, _events, _keepalive, extra) => {
        extras.push(extra)
        if (fail-- > 0) throw networkError()
      }
    })
    uploader.begin('R1')
    uploader.enqueue([ev(1)], { route: '/home' })
    uploader.enqueue([ev(2)], { route: '/home' })
    expect(await uploader.drain()).toBe('retry')
    expect(await uploader.drain()).toBe('retry')
    expect(await uploader.drain()).toBe('ok')
    expect(extras.map((e) => e.retries)).toEqual([undefined, 1, 2, undefined])
  })

  it('puts route and build in the keepalive body', () => {
    const chunk: QueuedChunk = {
      recordingId: 'R1',
      seq: 4,
      events: [ev(1)],
      bytes: 10,
      at: 0,
      route: '/home',
      build: 'dev'
    }
    expect(JSON.parse(packKeepalive([chunk], 10_000)[0].body)).toEqual({
      seq: 4,
      events: [ev(1)],
      route: '/home',
      build: 'dev'
    })
  })
})
