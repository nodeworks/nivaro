import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyReply } from 'fastify'
import { getStorage } from './storage/index.js'
import { LocalStorage } from './storage/local.js'
import { getActiveStorageDriver, readStoredObject } from './storage-drivers.js'

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
    return null
  }
}

export async function openStoredObject(key: string, rangeHeader?: string): Promise<OpenedObject> {
  const path = await localPath(key)
  if (path) {
    const { size } = await stat(path)
    const r = parseRange(rangeHeader, size)
    if (r === 'unsatisfiable')
      return { size, range: null, unsatisfiable: true, stream: Readable.from([]) }
    const stream = r
      ? createReadStream(path, { start: r.start, end: r.end })
      : createReadStream(path)
    return { size, range: r, unsatisfiable: false, stream }
  }
  const buf = await readStoredObject(key)
  const size = buf.length
  const r = parseRange(rangeHeader, size)
  if (r === 'unsatisfiable')
    return { size, range: null, unsatisfiable: true, stream: Readable.from([]) }
  const slice = r ? buf.subarray(r.start, r.end + 1) : buf
  return { size, range: r, unsatisfiable: false, stream: Readable.from([slice]) }
}

/** Copy a file on disk into the active storage driver. Local disk streams;
 *  remote drivers read the file into memory (no multipart upload in v1). */
export async function putStoredObjectFromFile(
  key: string,
  path: string,
  mime: string
): Promise<number> {
  const active = await getActiveStorageDriver()
  const storage = getStorage()
  if (active.name === 'local' && storage instanceof LocalStorage) {
    const dest = storage.resolveKey(key)
    await mkdir(dirname(dest), { recursive: true })
    await pipeline(createReadStream(path), createWriteStream(dest))
    return (await stat(dest)).size
  }
  const buf = await readFile(path)
  await active.put(key, buf, mime)
  return buf.length
}

export async function sendStoredObject(
  reply: FastifyReply,
  key: string,
  opts: { rangeHeader?: string; contentType: string; disposition?: string }
): Promise<FastifyReply> {
  const o = await openStoredObject(key, opts.rangeHeader)
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', opts.contentType)
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
