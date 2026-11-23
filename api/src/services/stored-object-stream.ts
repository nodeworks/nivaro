import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { FastifyReply } from 'fastify'
import { storageChaos } from './chaos/faults/storage.js'
import { dispositionMode, storedFileSecurityHeaders } from './file-serving-safety.js'
import { existingFallback } from './storage/fallback.js'
import { openFallbackUrl, peekFallbackUrl } from './storage/fallback-url.js'
import { getStorage } from './storage/index.js'
import { LocalStorage } from './storage/local.js'
import { isStoredObjectMissing, StoredObjectMissing } from './storage/missing.js'
import { getActiveStorageDriver, readOwnStoredObject } from './storage-drivers.js'

// Streaming reads and byte ranges for stored objects. Local disk streams from
// the file; remote drivers (S3/Azure settings drivers) fall back to reading the
// object into memory and slicing — correct, just not memory-light. Video served
// from local/NFS storage (EFP) never buffers.

export interface ByteRange {
  start: number
  end: number // inclusive
}

export interface OpenedObject {
  size: number
  range: ByteRange | null
  unsatisfiable: boolean
  stream: Readable
}

export function parseRange(
  header: string | undefined,
  size: number
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(.+)$/.exec(header.trim())
  if (!m) return null
  const spec = m[1].trim()
  if (spec.includes(',')) return null
  const parts = /^(\d*)-(\d*)$/.exec(spec)
  if (!parts) return null
  const [, a, b] = parts
  if (size <= 0) return 'unsatisfiable'
  if (a === '' && b === '') return null
  if (a === '') {
    const suffix = Number(b)
    if (!suffix) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(a)
  if (start >= size) return 'unsatisfiable'
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

async function localPath(key: string): Promise<string | null> {
  const active = await getActiveStorageDriver()
  if (active.name !== 'local') return null
  const storage = getStorage()
  if (!(storage instanceof LocalStorage)) return null
  const path = storage.resolveKey(key)
  try {
    await stat(path)
    return path
  } catch {
    // After an environment refresh: the source's copy, streamed read-only (FILES_FALLBACK_DIR).
    return (await existingFallback(key))?.path ?? null
  }
}

export interface OpenOptions {
  /** false = this environment's own copy only, never FILES_FALLBACK_URL (the source route). */
  remote?: boolean
}

export async function openStoredObject(
  key: string,
  rangeHeader?: string,
  opts: OpenOptions = {}
): Promise<OpenedObject> {
  const path = await localPath(key)
  if (path) {
    const hit = storageChaos('read')
    if (hit) await hit
    const { size } = await stat(path)
    const r = parseRange(rangeHeader, size)
    if (r === 'unsatisfiable')
      return { size, range: null, unsatisfiable: true, stream: Readable.from([]) }
    const stream = r
      ? createReadStream(path, { start: r.start, end: r.end })
      : createReadStream(path)
    return { size, range: r, unsatisfiable: false, stream }
  }
  let buf: Buffer
  try {
    buf = await readOwnStoredObject(key)
  } catch (err) {
    // After an environment refresh: the source API's copy, streamed read-only with the range
    // passed through (FILES_FALLBACK_URL). Its miss is this environment's miss.
    const remote = opts.remote === false ? null : await openFallbackUrl(key, rangeHeader)
    if (remote) return remote
    throw err
  }
  const size = buf.length
  const r = parseRange(rangeHeader, size)
  if (r === 'unsatisfiable')
    return { size, range: null, unsatisfiable: true, stream: Readable.from([]) }
  const slice = r ? buf.subarray(r.start, r.end + 1) : buf
  return { size, range: r, unsatisfiable: false, stream: Readable.from([slice]) }
}

/**
 * Hub phase 6 move file route (R6-I-1): this environment's own copy of the object a files row
 * names, read by the row's provider. `local` (or none): the env provider's file (or the
 * FILES_FALLBACK_DIR copy). A saved-settings provider (s3 / azure-blob): the active saved-settings
 * driver. Throws StoredObjectMissing only when the object is really not there; every other read
 * error is thrown as it is (the route answers 5xx, never "missing"). Never FILES_FALLBACK_URL.
 */
export async function openTransferObject(
  key: string,
  storage: string | null | undefined,
  rangeHeader?: string
): Promise<OpenedObject> {
  const provider = String(storage ?? 'local').toLowerCase() || 'local'
  if (provider === 'local') {
    const env = getStorage()
    if (env instanceof LocalStorage) {
      let path = env.resolveKey(key)
      let size: number
      try {
        size = (await stat(path)).size
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err
        const copy = await existingFallback(key)
        if (!copy) throw new StoredObjectMissing()
        path = copy.path
        size = (await stat(path)).size
      }
      return openedFromFile(path, size, rangeHeader)
    }
    // An env provider that is not local disk (a move refuses it: ENV_OBJECT_STORAGE).
    try {
      return await openStoredObject(key, rangeHeader, { remote: false })
    } catch (err) {
      throw isStoredObjectMissing(err) ? new StoredObjectMissing() : err
    }
  }
  const active = await getActiveStorageDriver()
  // The row's driver is no longer the active one: this environment cannot read it at all.
  if (active.name === 'local') throw new StoredObjectMissing()
  const buf = await active.get(key)
  return openedFromBuffer(buf, rangeHeader)
}

function openedFromFile(path: string, size: number, rangeHeader?: string): OpenedObject {
  const r = parseRange(rangeHeader, size)
  if (r === 'unsatisfiable')
    return { size, range: null, unsatisfiable: true, stream: Readable.from([]) }
  const stream = r ? createReadStream(path, { start: r.start, end: r.end }) : createReadStream(path)
  return { size, range: r, unsatisfiable: false, stream }
}

function openedFromBuffer(buf: Buffer, rangeHeader?: string): OpenedObject {
  const size = buf.length
  const r = parseRange(rangeHeader, size)
  if (r === 'unsatisfiable')
    return { size, range: null, unsatisfiable: true, stream: Readable.from([]) }
  const slice = r ? buf.subarray(r.start, r.end + 1) : buf
  return { size, range: r, unsatisfiable: false, stream: Readable.from([slice]) }
}

/** The first `bytes` of a stored object (type sniffing before serving it), or null
 *  when it cannot be read. Local disk reads only those bytes; remote drivers read
 *  the object (callers ask only for files stored under a text type). */
export async function peekStoredObject(
  key: string,
  bytes = 1024,
  opts: OpenOptions = {}
): Promise<Buffer | null> {
  try {
    const path = await localPath(key)
    if (path) {
      const fh = await open(path, 'r')
      try {
        const buf = Buffer.alloc(bytes)
        const { bytesRead } = await fh.read(buf, 0, bytes, 0)
        return buf.subarray(0, bytesRead)
      } finally {
        await fh.close().catch(() => {})
      }
    }
    try {
      return (await readOwnStoredObject(key)).subarray(0, bytes)
    } catch {
      // The source API's first bytes only (one ranged request), never the whole file.
      return opts.remote === false ? null : await peekFallbackUrl(key, bytes)
    }
  } catch {
    return null
  }
}

/** Copy a file on disk into the active storage driver, streamed (every driver has putFile:
 *  local disk copies the file, S3 uploads in parts or one streamed PUT, Azure in blocks or one
 *  streamed Put Blob) — the file is never read whole into memory. */
export async function putStoredObjectFromFile(
  key: string,
  path: string,
  mime: string,
  opts: { signal?: AbortSignal } = {}
): Promise<number> {
  const active = await getActiveStorageDriver()
  return active.putFile(key, path, mime, opts)
}

export async function sendStoredObject(
  reply: FastifyReply,
  key: string,
  opts: { rangeHeader?: string; contentType: string; disposition?: string; remote?: boolean }
): Promise<FastifyReply> {
  const o = await openStoredObject(key, opts.rangeHeader, { remote: opts.remote })
  return sendOpenedObject(reply, o, opts)
}

/** Sends an opened object: the security headers, 416 / 206 / 200 and the stream. */
export function sendOpenedObject(
  reply: FastifyReply,
  o: OpenedObject,
  opts: { contentType: string; disposition?: string }
): FastifyReply {
  // Stored bytes are user content: the browser keeps the declared type and
  // anything it renders as a document gets an opaque origin with no script (H1).
  reply
    .headers(storedFileSecurityHeaders(opts.contentType, dispositionMode(opts.disposition)))
    .header('Accept-Ranges', 'bytes')
    .header('Content-Type', opts.contentType)
  if (opts.disposition) reply.header('Content-Disposition', opts.disposition)
  if (o.unsatisfiable) {
    return reply.code(416).header('Content-Range', `bytes */${o.size}`).send()
  }
  if (o.range) {
    reply
      .code(206)
      .header('Content-Range', `bytes ${o.range.start}-${o.range.end}/${o.size}`)
      .header('Content-Length', String(o.range.end - o.range.start + 1))
  } else {
    reply.header('Content-Length', String(o.size))
  }
  return reply.send(o.stream)
}
