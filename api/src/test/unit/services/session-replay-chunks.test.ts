import { AsyncLocalStorage } from 'node:async_hooks'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  arrayInner,
  eventsBody,
  eventsBodyStream,
  inflateChunk,
  parsedChunks,
  primeFirst
} from '../../../services/session-replay-chunks.js'

/**
 * Stored replay chunks on their way out: the events answer is written by joining each chunk's
 * JSON text, never by parsing it, and must read back as exactly what the old path sent
 * (parse every chunk, skip the unreadable ones, stringify the lot).
 */

const gz = (json: string) => `gz:${gzipSync(Buffer.from(json, 'utf8')).toString('base64')}`

/** The route as it was before: one array built from every chunk, corrupt chunks skipped. */
function oldAnswer(chunks: Array<{ seq: number; events: string }>, lastSeq: number) {
  const events: unknown[] = []
  for (const c of chunks) {
    try {
      const text = c.events.startsWith('gz:')
        ? gunzipSync(Buffer.from(c.events.slice(3), 'base64')).toString('utf8')
        : c.events
      events.push(...(JSON.parse(text) as unknown[]))
    } catch {
      /* skip corrupt chunk */
    }
  }
  return JSON.parse(JSON.stringify({ data: { events, last_seq: lastSeq } }))
}

async function* rows<T>(list: T[]): AsyncGenerator<T> {
  for (const r of list) yield r
}

async function bodyText(chunks: Array<{ seq: number; events: string }>, lastSeq: number) {
  const parts: Buffer[] = []
  for await (const piece of eventsBody(rows(chunks), lastSeq)) {
    parts.push(typeof piece === 'string' ? Buffer.from(piece, 'utf8') : piece)
  }
  return Buffer.concat(parts).toString('utf8')
}

const snapshot = { type: 2, timestamp: 2, data: { node: { id: 1, childNodes: [{ id: 2 }] } } }
const meta = { type: 4, timestamp: 1, data: { href: 'https://app.test/a?b=[1,2]', width: 800 } }
const move = (t: number) => ({ type: 3, timestamp: t, data: { source: 1, positions: [{ x: t }] } })

describe('eventsBody', () => {
  it('one chunk reads back as the same events', async () => {
    const chunks = [{ seq: 0, events: gz(JSON.stringify([meta, snapshot])) }]
    const text = await bodyText(chunks, 0)
    expect(JSON.parse(text)).toEqual(oldAnswer(chunks, 0))
    expect(JSON.parse(text).data.events).toHaveLength(2)
  })

  it('many chunks, gzip and plain, join in order as one array', async () => {
    const chunks = [
      { seq: 0, events: gz(JSON.stringify([meta, snapshot])) },
      { seq: 1, events: JSON.stringify([move(3), move(4)]) },
      { seq: 2, events: gz(JSON.stringify([move(5)])) },
      { seq: 5, events: gz(JSON.stringify([move(6), move(7), move(8)])) }
    ]
    const text = await bodyText(chunks, 5)
    expect(JSON.parse(text)).toEqual(oldAnswer(chunks, 5))
    expect(JSON.parse(text).data.events.map((e: { timestamp: number }) => e.timestamp)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8
    ])
    expect(JSON.parse(text).data.last_seq).toBe(5)
  })

  it('no chunks at all is an empty list, still a whole answer', async () => {
    expect(JSON.parse(await bodyText([], 7))).toEqual({ data: { events: [], last_seq: 7 } })
  })

  it('an empty chunk adds nothing and leaves no stray comma', async () => {
    const chunks = [
      { seq: 0, events: gz('[]') },
      { seq: 1, events: gz(JSON.stringify([move(1)])) },
      { seq: 2, events: '[]' },
      { seq: 3, events: gz(' [ ] ') },
      { seq: 4, events: gz(JSON.stringify([move(2)])) },
      { seq: 5, events: gz('[]') }
    ]
    const text = await bodyText(chunks, 5)
    expect(JSON.parse(text)).toEqual(oldAnswer(chunks, 5))
    expect(JSON.parse(text).data.events).toHaveLength(2)
  })

  it('a chunk that fails to decode is skipped, the rest still plays', async () => {
    const good = gz(JSON.stringify([move(1)]))
    const chunks = [
      { seq: 0, events: gz(JSON.stringify([meta, snapshot])) },
      // gzip that is cut short
      { seq: 1, events: good.slice(0, good.length - 12) },
      // not gzip at all
      { seq: 2, events: 'gz:bm90IGd6aXA=' },
      // plain text that is not JSON
      { seq: 3, events: '[{"type":3,"timestamp":' },
      // JSON, but not a list of events
      { seq: 4, events: '{"type":3}' },
      { seq: 5, events: gz('{"type":3}') },
      { seq: 6, events: 'null' },
      { seq: 7, events: gz(JSON.stringify([move(9)])) }
    ]
    const text = await bodyText(chunks, 7)
    expect(JSON.parse(text)).toEqual(oldAnswer(chunks, 7))
    expect(JSON.parse(text).data.events.map((e: { timestamp: number }) => e.timestamp)).toEqual([
      1, 2, 9
    ])
  })

  it('every chunk unreadable is an empty list, not a broken answer', async () => {
    const chunks = [
      { seq: 0, events: 'gz:AAAA' },
      { seq: 1, events: 'nope' }
    ]
    expect(JSON.parse(await bodyText(chunks, 1))).toEqual({ data: { events: [], last_seq: 1 } })
  })

  it('carries text as stored: other alphabets, emoji, escapes, brackets inside strings', async () => {
    const tricky = [
      { type: 5, timestamp: 1, data: { tag: 'console', payload: 'naïve — 日本語 — 😀 — ]},[' } },
      { type: 5, timestamp: 2, data: { tag: 'x', payload: 'line\nbreak\ttab "quoted" \\  ' } }
    ]
    const chunks = [
      { seq: 0, events: gz(JSON.stringify(tricky)) },
      { seq: 1, events: JSON.stringify(tricky) }
    ]
    const text = await bodyText(chunks, 1)
    expect(JSON.parse(text)).toEqual(oldAnswer(chunks, 1))
    expect(JSON.parse(text).data.events).toEqual([...tricky, ...tricky])
  })

  it('never parses a gzip chunk: its text is joined as stored', async () => {
    const chunks = [
      { seq: 0, events: gz(JSON.stringify([meta, snapshot])) },
      { seq: 1, events: gz(JSON.stringify([move(3), move(4)])) }
    ]
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const text = await bodyText(chunks, 1)
      expect(parse).not.toHaveBeenCalled()
      parse.mockRestore()
      expect(JSON.parse(text).data.events).toHaveLength(4)
    } finally {
      parse.mockRestore()
    }
  })

  it('is byte for byte what stringifying the parsed events gave', async () => {
    const chunks = [
      { seq: 0, events: gz(JSON.stringify([meta, snapshot])) },
      { seq: 1, events: gz(JSON.stringify([move(3)])) }
    ]
    expect(await bodyText(chunks, 1)).toBe(JSON.stringify(oldAnswer(chunks, 1)))
  })
})

describe('arrayInner', () => {
  it('hands the bytes on as a view of what was inflated, not a copy', () => {
    const decoded = Buffer.from('[{"a":1}]')
    const inner = arrayInner(decoded) as Buffer
    expect(inner.buffer).toBe(decoded.buffer)
    expect(inner.length).toBe(decoded.length - 2)
  })

  it('answers what sits between the brackets, for bytes and for text', () => {
    expect(arrayInner(Buffer.from('[{"a":1},{"a":2}]'))?.toString()).toBe('{"a":1},{"a":2}')
    expect(arrayInner('[{"a":1}]')).toBe('{"a":1}')
    expect(arrayInner(Buffer.from(' \n[1, 2]\n'))?.toString()).toBe('1, 2')
  })

  it('answers null for an empty list and for anything that is not a list', () => {
    expect(arrayInner(Buffer.from('[]'))).toBeNull()
    expect(arrayInner(Buffer.from('[ \n ]'))).toBeNull()
    expect(arrayInner(Buffer.from('{"a":[1]}'))).toBeNull()
    expect(arrayInner(Buffer.from('"[1]"'))).toBeNull()
    expect(arrayInner(Buffer.from(''))).toBeNull()
    expect(arrayInner('[]')).toBeNull()
    expect(arrayInner('{"a":[1]}')).toBeNull()
    expect(arrayInner('[1,')).toBeNull()
    expect(arrayInner('')).toBeNull()
  })
})

describe('inflateChunk', () => {
  it('reads both storage shapes', async () => {
    expect((await inflateChunk(gz('[1,2]'))).toString()).toBe('[1,2]')
    expect(await inflateChunk('[3]')).toBe('[3]')
  })

  it('a small chunk does not hold on to the whole buffer it was inflated into', async () => {
    // Chunks wait in the response stream's read-ahead: hundreds of small ones must not each
    // pin a quarter of a megabyte.
    const small = (await inflateChunk(gz(JSON.stringify([move(1)])))) as Buffer
    expect(small.buffer.byteLength).toBeLessThan(16 * 1024)
    const large = (await inflateChunk(gz(JSON.stringify([move(1), 'x'.repeat(200_000)])))) as Buffer
    expect(large.length).toBeGreaterThan(200_000)
    expect(large.buffer.byteLength).toBeLessThan(large.length * 2)
  })

  it('rejects a gzip chunk it cannot read', async () => {
    await expect(inflateChunk('gz:bm90IGd6aXA=')).rejects.toThrow()
  })
})

describe('parsedChunks', () => {
  it('gives each readable chunk parsed, in order, skipping the unreadable', async () => {
    const out: unknown[] = []
    const source = [
      { events: gz('[1,2]') },
      { events: 'gz:bm90IGd6aXA=' },
      { events: '[3]' },
      { events: 'nope' },
      { events: gz('{"not":"a list"}') }
    ]
    for await (const parsed of parsedChunks(source)) out.push(parsed)
    expect(out).toEqual([[1, 2], [3], { not: 'a list' }])
  })

  it('lets other work run between two chunks', async () => {
    // Plain chunks have no off-thread step of their own: the turn between them is explicit.
    // Something already waiting on the event loop must get in before the last chunk.
    const order: string[] = []
    setImmediate(() => order.push('other work'))
    const source = Array.from({ length: 6 }, (_, i) => ({ events: `[${i}]` }))
    for await (const parsed of parsedChunks(source)) order.push(`chunk ${(parsed as number[])[0]}`)
    expect(order.filter((o) => o.startsWith('chunk'))).toHaveLength(6)
    expect(order.indexOf('other work')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('other work')).toBeLessThan(order.indexOf('chunk 5'))
  })
})

describe('eventsBodyStream', () => {
  /**
   * A source that counts what was asked of it and says when it was closed. Each chunk is
   * ~300 KB decoded, so a few of them pass the stream's read-ahead.
   */
  function countingSource(total: number, size = 300_000) {
    const state = { pulled: 0, closed: false }
    const payload = gz(JSON.stringify([{ type: 3, timestamp: 1, pad: 'x'.repeat(size) }]))
    async function* gen() {
      try {
        for (let seq = 0; seq < total; seq++) {
          state.pulled++
          yield { seq, events: payload }
        }
      } finally {
        state.closed = true
      }
    }
    return { state, source: gen() }
  }
  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms))

  it('streams the same answer the pieces make', async () => {
    const chunks = [
      { seq: 0, events: gz(JSON.stringify([meta, snapshot])) },
      { seq: 1, events: JSON.stringify([move(3)]) }
    ]
    const bufs: Buffer[] = []
    for await (const b of eventsBodyStream(rows(chunks), 1)) bufs.push(b as Buffer)
    expect(JSON.parse(Buffer.concat(bufs).toString('utf8'))).toEqual(oldAnswer(chunks, 1))
  })

  it('a reader that stops reading stops the read: no more chunks are fetched', async () => {
    const { state, source } = countingSource(500)
    const stream = eventsBodyStream(source, 499)
    // Read a little, then stop asking.
    await new Promise<void>((resolve) => stream.once('readable', () => resolve()))
    stream.read()
    await settle()
    const after = state.pulled
    expect(after).toBeLessThan(20)
    await settle(80)
    expect(state.pulled).toBe(after)
    expect(state.closed).toBe(false)
    stream.destroy()
    await settle()
    expect(state.closed).toBe(true)
  })

  it('a reader that goes away ends the read and closes the source', async () => {
    const { state, source } = countingSource(500)
    const stream = eventsBodyStream(source, 499)
    let seen = 0
    stream.on('data', () => {
      seen++
      if (seen === 3) stream.destroy()
    })
    await new Promise<void>((resolve) => stream.once('close', () => resolve()))
    await settle()
    expect(state.closed).toBe(true)
    expect(state.pulled).toBeLessThan(20)
    const after = state.pulled
    await settle(80)
    expect(state.pulled).toBe(after)
  })

  it('a reader that goes away with an error (an early close) ends the read too', async () => {
    const { state, source } = countingSource(500)
    const stream = eventsBodyStream(source, 499)
    stream.on('error', () => {})
    let seen = 0
    stream.on('data', () => {
      seen++
      // The third piece: the source has been opened by then (the first is the opening text).
      if (seen !== 3) return
      stream.destroy(
        Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })
      )
    })
    await new Promise<void>((resolve) => stream.once('close', () => resolve()))
    await settle()
    expect(state.closed).toBe(true)
    expect(state.pulled).toBeLessThan(20)
    const after = state.pulled
    await settle(80)
    expect(state.pulled).toBe(after)
  })

  it('a reader that goes away before the first chunk never opens the source', async () => {
    const { state, source } = countingSource(500)
    const stream = eventsBodyStream(source, 499)
    stream.once('data', () => stream.destroy())
    await new Promise<void>((resolve) => stream.once('close', () => resolve()))
    await settle()
    expect(state.pulled).toBeLessThanOrEqual(1)
    const after = state.pulled
    await settle(80)
    expect(state.pulled).toBe(after)
  })

  it('a source that fails part-way errors the stream instead of hanging or ending clean', async () => {
    async function* failing() {
      yield { seq: 0, events: gz('[1]') }
      throw new Error('database went away')
    }
    const stream = eventsBodyStream(failing(), 3)
    const seen: Buffer[] = []
    const err = await new Promise<Error | null>((resolve) => {
      stream.on('data', (b: Buffer) => seen.push(b))
      stream.on('error', (e) => resolve(e))
      stream.on('end', () => resolve(null))
    })
    expect(err?.message).toBe('database went away')
    // What was written is not a whole answer: a reader can tell it was cut short.
    expect(() => JSON.parse(Buffer.concat(seen).toString('utf8'))).toThrow()
  })
})

describe('primeFirst', () => {
  it('throws the first read failure before anything is handed over', async () => {
    const failing: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('no connection'))
      })
    }
    await expect(primeFirst(failing)).rejects.toThrow('no connection')
  })

  it('hands back the same sequence, first item included, and closes the source with it', async () => {
    let closed = false
    async function* gen() {
      try {
        yield 1
        yield 2
        yield 3
      } finally {
        closed = true
      }
    }
    const all: number[] = []
    for await (const n of await primeFirst(gen())) all.push(n)
    expect(all).toEqual([1, 2, 3])

    closed = false
    const primed = await primeFirst(gen())
    for await (const n of primed) {
      if (n === 1) break
    }
    expect(closed).toBe(true)
  })

  it('an empty sequence stays empty', async () => {
    const all: number[] = []
    for await (const n of await primeFirst(rows<number>([]))) all.push(n)
    expect(all).toEqual([])
  })

  it('keeps reading in the context it was started in, whoever asks for the next item', async () => {
    // The database handle is chosen per request context (the tenant's database, the pool).
    // Later batches are asked for by the response stream, long after the handler returned:
    // they must still read as the request that started them.
    const context = new AsyncLocalStorage<string>()
    const seen: Array<string | undefined> = []
    let closedIn: string | undefined
    async function* gen() {
      try {
        for (let i = 0; i < 3; i++) {
          await Promise.resolve()
          seen.push(context.getStore())
          yield i
        }
      } finally {
        closedIn = context.getStore()
      }
    }
    const primed = await context.run('the request', () => primeFirst(gen()))
    const it = primed[Symbol.asyncIterator]()
    await context.run('someone else', async () => {
      await it.next()
      await it.next()
    })
    await it.next()
    await context.run('someone else', async () => {
      await it.return?.()
    })
    expect(seen).toEqual(['the request', 'the request', 'the request'])
    expect(closedIn).toBe('the request')
  })
})
