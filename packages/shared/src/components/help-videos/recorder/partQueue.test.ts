import { describe, expect, it } from 'vitest'
import { isFatalStatus, MemoryPartStore, nextBackoff, PartUploader } from './partQueue'

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
})
