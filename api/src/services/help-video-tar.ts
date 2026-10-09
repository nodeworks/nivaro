import { createReadStream } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { Readable } from 'node:stream'

// A minimal POSIX ustar writer and a random-access reader, enough for help
// video packages. Entry names are short and chosen by the writer (`f1`,
// `manifest.json`); the reader treats every name as untrusted data and never
// uses one as a path. No dependency: a package can be several GB, so the
// writer streams and the reader seeks instead of loading anything whole.

const BLOCK = 512
/** Largest entry an 11-digit octal size field can describe (8 GiB - 1). */
export const TAR_MAX_ENTRY = 0o77777777777

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`
}

/** One 512-byte ustar header for a regular file. */
export function tarHeader(name: string, size: number, mtimeSec: number): Buffer {
  if (!/^[A-Za-z0-9._-]{1,99}$/.test(name)) throw new Error(`Bad tar entry name: ${name}`)
  if (!Number.isInteger(size) || size < 0 || size > TAR_MAX_ENTRY) {
    throw new Error(`Bad tar entry size: ${size}`)
  }
  const h = Buffer.alloc(BLOCK, 0)
  h.write(name, 0, 100, 'ascii')
  h.write(octal(0o644, 8), 100, 8, 'ascii')
  h.write(octal(0, 8), 108, 8, 'ascii')
  h.write(octal(0, 8), 116, 8, 'ascii')
  h.write(octal(size, 12), 124, 12, 'ascii')
  h.write(octal(Math.max(0, Math.floor(mtimeSec)), 12), 136, 12, 'ascii')
  h.write('        ', 148, 8, 'ascii') // checksum placeholder
  h.write('0', 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return h
}

export function tarPadding(size: number): Buffer {
  const r = size % BLOCK
  return Buffer.alloc(r === 0 ? 0 : BLOCK - r, 0)
}

/** Two zero blocks end an archive. */
export const TAR_END = Buffer.alloc(BLOCK * 2, 0)

export interface TarEntry {
  name: string
  size: number
  /** Byte offset of the entry's data in the archive. */
  offset: number
  type: string
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const raw = buf
    .subarray(start, start + len)
    .toString('ascii')
    .replace(/[\0 ]+$/g, '')
    .trim()
  if (!raw) return 0
  if (!/^[0-7]+$/.test(raw)) return Number.NaN
  return Number.parseInt(raw, 8)
}

function checksumOk(h: Buffer): boolean {
  const want = readOctal(h, 148, 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]
  return want === sum
}

/** Lists the regular-file entries of a ustar archive on disk by reading only
 *  the headers. Refuses a damaged header, an entry running past the end of
 *  the file, and more than `maxEntries` entries. */
export async function listTar(path: string, maxEntries = 1000): Promise<TarEntry[]> {
  const fh: FileHandle = await open(path, 'r')
  try {
    const { size: total } = await fh.stat()
    const entries: TarEntry[] = []
    const h = Buffer.alloc(BLOCK)
    let at = 0
    while (at + BLOCK <= total) {
      const { bytesRead } = await fh.read(h, 0, BLOCK, at)
      if (bytesRead < BLOCK) break
      if (h.every((b) => b === 0)) break
      if (!checksumOk(h)) throw new Error('The package is damaged (bad tar header)')
      const nameRaw = h.subarray(0, 100)
      const nul = nameRaw.indexOf(0)
      const name = nameRaw.subarray(0, nul < 0 ? 100 : nul).toString('utf8')
      const size = readOctal(h, 124, 12)
      const type = String.fromCharCode(h[156] || 0x30)
      if (!Number.isFinite(size) || size < 0) throw new Error('The package is damaged (bad size)')
      const offset = at + BLOCK
      if (offset + size > total) throw new Error('The package is incomplete')
      if (type === '0' || type === '\0') entries.push({ name, size, offset, type: '0' })
      if (entries.length > maxEntries) throw new Error('The package has too many files')
      at = offset + size + ((BLOCK - (size % BLOCK)) % BLOCK)
    }
    return entries
  } finally {
    await fh.close()
  }
}

/** Reads one entry into memory (small entries only: the manifest). */
export async function readTarEntry(path: string, e: TarEntry, maxBytes: number): Promise<Buffer> {
  if (e.size > maxBytes) throw new Error(`${e.name} is too large`)
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(e.size)
    if (e.size) await fh.read(buf, 0, e.size, e.offset)
    return buf
  } finally {
    await fh.close()
  }
}

/** A stream over one entry's bytes (no copy into memory). */
export function tarEntryStream(path: string, e: TarEntry): Readable {
  if (e.size === 0) return Readable.from([])
  return createReadStream(path, { start: e.offset, end: e.offset + e.size - 1 })
}
