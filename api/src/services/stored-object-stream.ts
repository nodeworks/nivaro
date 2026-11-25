import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { PassThrough, pipeline, Readable } from 'node:stream'
import type { FastifyReply } from 'fastify'
import { getTenantId } from '../db/tenant-context.js'
import { storageChaos } from './chaos/faults/storage.js'
import { tenantSource } from './deployment-mode.js'
import { dispositionMode, storedFileSecurityHeaders } from './file-serving-safety.js'
import { appScopedKey } from './storage/app-scope.js'
import { existingFallback } from './storage/fallback.js'
import { openFallbackUrl, peekFallbackUrl } from './storage/fallback-url.js'
import { getStorage } from './storage/index.js'
import { LocalStorage } from './storage/local.js'
import { isStoredObjectMissing, StoredObjectMissing } from './storage/missing.js'
import { parseByteRange } from './storage/range.js'
import { getActiveStorageDriver, readOwnStoredObject } from './storage-drivers.js'
import { isMissingObject } from './traffic-taps/storage.js'

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
  return parseByteRange(header, size)
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
 * A move's source object (0.3.215): the bytes, and where this app keeps them, so the target
 * writes them to the same kind of store (`settings` = the saved-settings driver, `env` = the env
 * provider; a FILES_FALLBACK_DIR / _URL copy belongs in `env`). `store_id` + `stored_key` only
 * when the env provider itself served it and can name its bucket (env S3/Azure): the target
 * copies server-side when it writes to the same bucket.
 */
export interface TransferObject extends OpenedObject {
  store: 'settings' | 'env'
  store_id?: string
  stored_key?: string
}

/**
 * Hub phase 6 move file route (R6-I-1, R6-M-3, P6-36): this environment's own copy of the
 * object a files row names. A saved-settings row (s3 / azure-blob) — or any `storage` other than
 * `local`, e.g. a cold session replay — is asked of the active saved-settings driver first
 * (streamed). When the driver says it is not there, or for a `local` row, the same chain the app
 * reads with: the env provider's object (streamed from S3/Azure too, 0.3.215), the
 * FILES_FALLBACK_DIR copy, then FILES_FALLBACK_URL. Throws StoredObjectMissing only when every
 * one of them says not-found; any other read error, on any of them, is thrown as it is (the
 * route answers 5xx, never "missing"), so a move never counts as missing bytes it can still read.
 */
export async function openTransferObject(
  key: string,
  storage: string | null | undefined,
  rangeHeader?: string
): Promise<TransferObject> {
  const provider = String(storage ?? 'local').toLowerCase() || 'local'
  if (askSettingsFirst(provider)) {
    const active = await getActiveStorageDriver()
    // A driver that is not the active one cannot be asked; the chain below still can.
    if (active.name !== 'local') {
      try {
        if (active.openStream) {
          const o = await active.openStream(key, rangeHeader)
          return { ...o, stream: piped(o.stream), store: 'settings' }
        }
        return { ...openedFromBuffer(await active.get(key), rangeHeader), store: 'settings' }
      } catch (err) {
        if (!isStoredObjectMissing(err)) throw err
      }
    }
  }
  return openLocalChain(key, rangeHeader)
}

/**
 * Whether the saved-settings driver may hold this row's object: not for `local`, nor for
 * `azure`, which only the env Azure provider writes (the saved Azure driver writes `azure-blob`).
 * `s3` is written by both, and a replay by whichever driver is active.
 */
function askSettingsFirst(provider: string): boolean {
  return provider !== 'local' && provider !== 'azure'
}

/**
 * 0.3.215, a move's header-only probe: where this app's env S3/Azure provider keeps the object
 * (its bucket hash, the full key, the size from a HEAD), without opening it. Null when the object
 * is not answered that way — local disk, a saved-settings driver that may hold it, not there, or
 * a provider that cannot say — and the target then asks for the bytes as usual.
 */
export async function probeTransferObject(
  key: string,
  storage: string | null | undefined
): Promise<{ store_id: string; stored_key: string; size: number } | null> {
  const provider = String(storage ?? 'local').toLowerCase() || 'local'
  if (askSettingsFirst(provider) && (await getActiveStorageDriver()).name !== 'local') return null
  const env = getStorage()
  if (env instanceof LocalStorage || typeof env.storeId !== 'function' || !env.size) return null
  const size = await env.size(key)
  if (size === null) return null
  return { store_id: env.storeId(), stored_key: envStoredKey(key), size }
}

/** pipeline: an error on either side destroys both (never .pipe(), see gotchas). */
function piped(stream: Readable): Readable {
  const out = new PassThrough()
  pipeline(stream, out, () => {})
  return out
}

/** The key as the env provider stores it: under apps/<tenantId>/ on a Hub shared deployment. */
function envStoredKey(key: string): string {
  return tenantSource() === 'hub' ? appScopedKey(key, getTenantId()) : key
}

/** The env provider's object, the FILES_FALLBACK_DIR copy, then FILES_FALLBACK_URL (P6-36). */
async function openLocalChain(key: string, rangeHeader?: string): Promise<TransferObject> {
  const env = getStorage()
  if (env instanceof LocalStorage) {
    const path = env.resolveKey(key)
    try {
      return { ...(await openedFromFile(path, rangeHeader)), store: 'env' }
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
    }
  } else {
    // An env provider that is not local disk (S3 / Azure): streamed, never read whole (0.3.215).
    try {
      const streamed = typeof env.openStream === 'function'
      const o = env.openStream
        ? await env.openStream(key, rangeHeader)
        : openedFromBuffer(await env.get(key), rangeHeader)
      const id = typeof env.storeId === 'function' ? env.storeId() : null
      return {
        ...o,
        stream: streamed ? piped(o.stream) : o.stream,
        store: 'env',
        ...(id ? { store_id: id, stored_key: envStoredKey(key) } : {})
      }
    } catch (err) {
      // The env S3/Azure providers report a miss their own way (NoSuchKey, BlobNotFound, 404).
      if (!isStoredObjectMissing(err) && !isMissingObject(err)) throw err
    }
  }
  // Strict (R7-M-1): an unreadable fallback folder (EACCES / EIO / ESTALE) is a read error, never
  // "missing".
  const copy = await existingFallback(key, { strict: true })
  if (copy) return { ...(await openedFromFile(copy.path, rangeHeader)), store: 'env' }
  const remote = await openFallbackUrl(key, rangeHeader, { throwOnTrouble: true })
  if (remote) return { ...remote, store: 'env' }
  throw new StoredObjectMissing()
}

/**
 * The file is OPENED before anything is answered: a file that stats but cannot be opened (mode
 * 000, EACCES / EIO on an NFS fallback mount) throws here, inside the route's own read-error
 * answer (503 SOURCE_READ_FAILED, no path), instead of failing the stream after the reply started
 * (a 500 whose message named the server path). The size is the open file's own.
 */
async function openedFromFile(path: string, rangeHeader?: string): Promise<OpenedObject> {
  const fh = await open(path, 'r')
  let size: number
  try {
    size = (await fh.stat()).size
  } catch (err) {
    await fh.close().catch(() => {})
    throw err
  }
  const r = parseRange(rangeHeader, size)
  if (r === 'unsatisfiable') {
    await fh.close().catch(() => {})
    return { size, range: null, unsatisfiable: true, stream: Readable.from([]) }
  }
  // autoClose (the default): the handle closes when the stream ends, fails or is destroyed.
  const stream = r ? fh.createReadStream({ start: r.start, end: r.end }) : fh.createReadStream()
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
