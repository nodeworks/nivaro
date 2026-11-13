/**
 * Stored replay chunks on their way out (2026-11-12).
 *
 * A recording is rows of nivaro_session_events: each row one JSON array of rrweb events,
 * gzip-stored (`gz:` + base64) or, from before gzip storage, plain text. Opening a recording
 * used to gunzip, parse and re-stringify every row in one synchronous pass: a 15 MB recording
 * is 75–100 MB of JSON, and for about a second (several, on a busy server) nothing else on
 * the process ran. Unrelated small reads waited behind it, and the events sat in memory three
 * times over (decoded text, parsed objects, the answer).
 *
 * The events answer needs none of that. A stored chunk is already the JSON text of an array,
 * so the answer is those arrays joined: `{"data":{"events":[` + each chunk's text without its
 * outer brackets, comma-separated + `],"last_seq":N}}`. Each chunk is inflated off the event
 * loop (zlib's thread pool), handed to the response as bytes, and the read runs only a
 * little ahead of what the response has taken — so memory holds a chunk or two, and a
 * caller who stops reading or leaves stops the read.
 *
 * What makes joining text safe: a gzip chunk carries its own checksum, so what inflates is
 * byte for byte what the server's JSON.stringify wrote when it stored the chunk; only its
 * outer brackets are checked here. A plain chunk has no checksum, so it is still parsed (they
 * are small: the old cap was 1.5 MB) and skipped when it is not a JSON array, as before.
 *
 * Callers that must look inside the events (a window cut by time, a script built from them)
 * cannot skip the parse: `parsedChunks` gives them one chunk at a time, inflated off the
 * event loop, with a turn of the loop between chunks.
 *
 * No database here: ./session-recording-chain.ts reads the rows (chunkPlan,
 * readPlannedChunks).
 */
import { AsyncResource } from 'node:async_hooks'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

const gunzipAsync = promisify(gunzip)

/**
 * zlib's output buffer for one chunk. Its default (16 KB) costs a trip to the thread pool
 * and back per 16 KB inflated — dozens for one chunk; at 256 KB most chunks take one, and
 * inflating a recording off the loop takes about what the synchronous call did.
 */
const INFLATE_BUFFER_BYTES = 256 * 1024

const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09

/**
 * One stored chunk as its JSON text: bytes for a gzip chunk, inflated on zlib's thread pool
 * rather than on the event loop; the stored string itself for a chunk from before gzip
 * storage. Rejects when a gzip chunk cannot be read.
 */
export async function inflateChunk(stored: string): Promise<Buffer | string> {
  if (!stored.startsWith('gz:')) return stored
  const out = await gunzipAsync(Buffer.from(stored.slice(3), 'base64'), {
    chunkSize: INFLATE_BUFFER_BYTES
  })
  // A chunk that fits zlib's output buffer comes back as a view of that whole buffer. Small
  // chunks wait in the response's read-ahead by the hundred: each takes its own bytes with
  // it, not a quarter of a megabyte.
  return out.buffer.byteLength > out.length * 2 ? Buffer.from(out) : out
}

/** One turn of the event loop: waiting requests, timers and I/O run before the caller goes on. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * What sits between a decoded chunk's outer brackets, ready to be joined with other chunks'
 * events; null when there is nothing to add (an empty array) or the chunk is not an array.
 *
 * Bytes (an inflated gzip chunk) are only checked for their outer brackets and returned as a
 * view, never copied or turned into a string. Text (a plain chunk) is parsed to make sure.
 */
export function arrayInner(decoded: Buffer | string): Buffer | string | null {
  if (typeof decoded === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(decoded)
    } catch {
      return null
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    return decoded.slice(decoded.indexOf('[') + 1, decoded.lastIndexOf(']'))
  }
  let start = 0
  let end = decoded.length - 1
  while (start <= end && isSpace(decoded[start])) start++
  while (end >= start && isSpace(decoded[end])) end--
  if (end <= start || decoded[start] !== OPEN_BRACKET || decoded[end] !== CLOSE_BRACKET) return null
  let first = start + 1
  while (first < end && isSpace(decoded[first])) first++
  if (first === end) return null
  return decoded.subarray(start + 1, end)
}

/**
 * The events answer, piece by piece: `{"data":{"events":[…],"last_seq":N}}` with each
 * chunk's events as stored. A chunk that cannot be read is skipped (a partial replay beats
 * none). Nothing here is caught around a `yield`: when the reader goes away, the stream ends
 * this generator there, which closes `chunks` in turn.
 */
export async function* eventsBody(
  chunks: AsyncIterable<{ events: string }>,
  lastSeq: number
): AsyncGenerator<Buffer | string> {
  yield '{"data":{"events":['
  let any = false
  for await (const chunk of chunks) {
    let inner: Buffer | string | null
    try {
      const decoded = await inflateChunk(chunk.events)
      inner = arrayInner(decoded)
      // A plain chunk was parsed on the event loop just now: let others in before the next.
      if (typeof decoded === 'string') await yieldToEventLoop()
    } catch {
      inner = null
    }
    if (inner === null) continue
    if (any) yield ','
    any = true
    yield inner
  }
  // As JSON.stringify would write it: a seq that is not a number reads back as null.
  yield `],"last_seq":${Number.isFinite(lastSeq) ? String(lastSeq) : 'null'}}}`
}

/**
 * How far the stream reads ahead of the response: about one more chunk, so the next one
 * inflates while the compressor works on the current one. Past this the read waits.
 */
const READ_AHEAD_BYTES = 1024 * 1024

/**
 * The events answer as a byte stream for the response. The next chunk is read only when the
 * response has room, and destroying the stream (the caller left) ends the read.
 */
export function eventsBodyStream(
  chunks: AsyncIterable<{ events: string }>,
  lastSeq: number
): Readable {
  return Readable.from(eventsBody(chunks, lastSeq), {
    objectMode: false,
    highWaterMark: READ_AHEAD_BYTES
  })
}

/**
 * Read the first item now and hand back the same sequence. A failure reading it is thrown
 * here, while the route can still answer with an ordinary error; once a stream has started,
 * a failure can only cut the answer short.
 *
 * Every later read runs in the async context of this call (the request's), whoever asks for
 * it. The database handle is chosen per context — the tenant's database in cloud mode, the
 * pool — and an async generator otherwise runs in the context of whichever stream callback
 * asked for its next item, long after the handler returned.
 */
export async function primeFirst<T>(source: AsyncIterable<T>): Promise<AsyncIterable<T>> {
  const it = source[Symbol.asyncIterator]()
  const next = AsyncResource.bind(() => it.next())
  const end = AsyncResource.bind(
    (value?: unknown): Promise<IteratorResult<T>> =>
      it.return ? it.return(value) : Promise.resolve({ done: true, value } as IteratorResult<T>)
  )
  const fail = AsyncResource.bind(
    (err?: unknown): Promise<IteratorResult<T>> => (it.throw ? it.throw(err) : Promise.reject(err))
  )
  let first: IteratorResult<T> | null = await next()
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next() {
          if (first) {
            const head = first
            first = null
            return Promise.resolve(head)
          }
          return next()
        },
        return(value?: unknown) {
          first = null
          return end(value)
        },
        throw(err?: unknown) {
          first = null
          return fail(err)
        }
      }
    }
  }
}

/**
 * Each readable chunk parsed, one at a time, for callers that must look inside the events.
 * A chunk that cannot be read is skipped. Inflating runs off the event loop and every chunk
 * is followed by a turn of the loop, so the longest the process is held is one chunk's parse,
 * not the recording's.
 */
export async function* parsedChunks(
  chunks: Iterable<{ events: string }> | AsyncIterable<{ events: string }>
): AsyncGenerator<unknown> {
  for await (const chunk of chunks) {
    let parsed: unknown
    let ok = false
    try {
      const decoded = await inflateChunk(chunk.events)
      parsed = JSON.parse(typeof decoded === 'string' ? decoded : decoded.toString('utf8'))
      ok = true
    } catch {
      /* skip corrupt chunk */
    }
    await yieldToEventLoop()
    if (ok) yield parsed
  }
}
