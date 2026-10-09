import { describe, expect, it } from 'vitest'
import {
  isFatalStatus,
  MemoryPartStore,
  nextBackoff,
  type PartStore,
  PartUploader
} from './partQueue'

const blob = (s: string) => new Blob([s])
const noSleep = async () => {}

describe('nextBackoff / isFatalStatus', () => {
  it('doubles up to 30 s', () => {
    expect([0, 1, 2, 10].map(nextBackoff)).toEqual([1000, 2000, 4000, 30_000])
  })
  it('treats refusals as fatal and outages as retryable', () => {
    expect(isFatalStatus(413)).toBe(true)
    expect(isFatalStatus(409)).toBe(true)
    expect(isFatalStatus(503)).toBe(false)
    expect(isFatalStatus(undefined)).toBe(false)
  })
  it('treats 422 (not a video, too long) as fatal so it is never retried', () => {
    expect(isFatalStatus(422, 'UPLOAD_NOT_VIDEO')).toBe(true)
    expect(isFatalStatus(422, 'UPLOAD_TOO_LONG')).toBe(true)
    expect(isFatalStatus(422)).toBe(true)
  })
  it('retries an upload held by another server', () => {
    expect(isFatalStatus(409, 'UPLOAD_ELSEWHERE')).toBe(false)
    expect(isFatalStatus(409, 'UPLOAD_CLOSED')).toBe(true)
  })
})

describe('PartUploader', () => {
  it('sends parts in order and clears the store', async () => {
    const store = new MemoryPartStore()
    const sent: number[] = []
    const up = new PartUploader({
      uploadId: 'u',
      store,
      sleep: noSleep,
      send: async (n) => void sent.push(n)
    })
    up.enqueue(blob('a'))
    up.enqueue(blob('b'))
    up.enqueue(blob('c'))
    await up.drain()
    expect(sent).toEqual([0, 1, 2])
    expect(await store.list('u')).toEqual([])
  })
  it('retries an outage without losing or reordering parts', async () => {
    const store = new MemoryPartStore()
    const sent: number[] = []
    let failures = 2
    const up = new PartUploader({
      uploadId: 'u',
      store,
      sleep: noSleep,
      send: async (n) => {
        if (n === 1 && failures-- > 0) throw Object.assign(new Error('down'), { status: 503 })
        sent.push(n)
      }
    })
    up.enqueue(blob('a'))
    up.enqueue(blob('b'))
    up.enqueue(blob('c'))
    await up.drain()
    expect(sent).toEqual([0, 1, 2])
  })
  it('stops on a refusal and keeps the unsent parts', async () => {
    const store = new MemoryPartStore()
    const up = new PartUploader({
      uploadId: 'u',
      store,
      sleep: noSleep,
      send: async (n) => {
        if (n === 1) throw Object.assign(new Error('too big'), { status: 413 })
      }
    })
    up.enqueue(blob('a'))
    up.enqueue(blob('b'))
    await expect(up.drain()).rejects.toThrow('too big')
    expect((await store.list('u')).map((p) => p.n)).toEqual([1])
  })
  it('stops on a 422 refusal at once instead of retrying it', async () => {
    const store = new MemoryPartStore()
    let calls = 0
    const up = new PartUploader({
      uploadId: 'u',
      store,
      sleep: noSleep,
      send: async () => {
        calls++
        throw Object.assign(new Error('That does not look like a WebM or MP4 recording'), {
          status: 422,
          code: 'UPLOAD_NOT_VIDEO'
        })
      }
    })
    up.enqueue(blob('a'))
    await expect(up.drain()).rejects.toThrow('does not look like')
    expect(calls).toBe(1)
    expect((await store.list('u')).map((p) => p.n)).toEqual([0])
  })
  it('continues numbering from startAt when resuming', async () => {
    const sent: number[] = []
    const up = new PartUploader({
      uploadId: 'u',
      store: new MemoryPartStore(),
      sleep: noSleep,
      startAt: 7,
      send: async (n) => void sent.push(n)
    })
    up.enqueue(blob('x'))
    await up.drain()
    expect(sent).toEqual([7])
  })
  it('keeps each part in the store before sending it', async () => {
    const order: string[] = []
    const mem = new MemoryPartStore()
    let release: () => void = () => {}
    const slow: PartStore = {
      durable: true,
      put: (u, n, b) =>
        new Promise<void>((res) => {
          release = () => {
            order.push(`stored ${n}`)
            void mem.put(u, n, b).then(res)
          }
        }),
      remove: (u, n) => mem.remove(u, n),
      list: (u) => mem.list(u),
      clear: (u) => mem.clear(u),
      uploads: () => mem.uploads()
    }
    const up = new PartUploader({
      uploadId: 'u',
      store: slow,
      sleep: noSleep,
      send: async (n) => void order.push(`sent ${n}`)
    })
    up.enqueue(blob('a'))
    await new Promise((r) => setTimeout(r, 5))
    expect(order).toEqual([])
    release()
    await up.drain()
    expect(order).toEqual(['stored 0', 'sent 0'])
  })
  it('keeps trying through a long outage when attempts are unlimited', async () => {
    let failures = 20
    const sent: number[] = []
    const up = new PartUploader({
      uploadId: 'u',
      store: new MemoryPartStore(),
      sleep: noSleep,
      maxAttempts: Number.POSITIVE_INFINITY,
      send: async (n) => {
        if (failures-- > 0) throw new TypeError('Failed to fetch')
        sent.push(n)
      }
    })
    up.enqueue(blob('a'))
    up.enqueue(blob('b'))
    await up.drain()
    expect(sent).toEqual([0, 1])
  })
  it('gives up after the limit set once recording stops', async () => {
    let calls = 0
    const store = new MemoryPartStore()
    const up = new PartUploader({
      uploadId: 'u',
      store,
      sleep: noSleep,
      maxAttempts: Number.POSITIVE_INFINITY,
      send: async () => {
        calls++
        if (calls === 3) up.limitAttempts(5)
        throw new TypeError('Failed to fetch')
      }
    })
    up.enqueue(blob('a'))
    await expect(up.drain()).rejects.toThrow('Failed to fetch')
    expect(calls).toBe(5)
    expect((await store.list('u')).map((p) => p.n)).toEqual([0])
  })
  it('reports whether parts survive a closed tab', async () => {
    const states: boolean[] = []
    const up = new PartUploader({
      uploadId: 'u',
      store: new MemoryPartStore(),
      sleep: noSleep,
      send: async () => {},
      onChange: (s) => states.push(s.durable)
    })
    up.enqueue(blob('a'))
    await up.drain()
    expect(states.every((d) => d === false)).toBe(true)
  })
})

describe('MemoryPartStore.uploads', () => {
  it('lists each upload that has parts, once', async () => {
    const store = new MemoryPartStore()
    await store.put('a-1', 0, blob('x'))
    await store.put('a-1', 1, blob('y'))
    await store.put('b-2', 4, blob('z'))
    expect((await store.uploads()).sort()).toEqual(['a-1', 'b-2'])
    await store.clear('a-1')
    expect(await store.uploads()).toEqual(['b-2'])
  })
})
