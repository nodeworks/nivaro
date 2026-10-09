import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// vi.mock factories are hoisted above every import, and config.ts parses the
// environment at import time — so the temp root must be created inside
// vi.hoisted and handed to the config mock, never set on process.env here.
const { root } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-stream-')) }
})
vi.mock('../../../config.js', () => ({ config: { STORAGE_LOCAL_ROOT: root } }))
vi.mock('../../../services/storage-drivers.js', () => ({
  getActiveStorageDriver: async () => ({ name: 'local' }),
  readStoredObject: async () => Buffer.from('fallback')
}))

import { openStoredObject, parseRange } from '../../../services/stored-object-stream.js'

async function readAll(s: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of s) chunks.push(Buffer.from(c as Buffer))
  return Buffer.concat(chunks).toString()
}

describe('parseRange', () => {
  it('returns null without a header', () => expect(parseRange(undefined, 100)).toBeNull())
  it('reads a closed range', () =>
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 }))
  it('reads an open range to the end', () =>
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 }))
  it('reads a suffix range', () =>
    expect(parseRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 }))
  it('clamps an end past the object', () =>
    expect(parseRange('bytes=95-500', 100)).toEqual({ start: 95, end: 99 }))
  it('refuses a start past the end', () =>
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable'))
  it('refuses any range on an empty object', () =>
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable'))
  it('serves the whole object for several ranges', () =>
    expect(parseRange('bytes=0-1,5-9', 100)).toBeNull())
  it('ignores a malformed header', () => expect(parseRange('chunks=1-2', 100)).toBeNull())
})

describe('openStoredObject (local disk)', () => {
  writeFileSync(join(root, 'clip.bin'), '0123456789')
  it('streams the whole object with its size', async () => {
    const o = await openStoredObject('clip.bin')
    expect(o.size).toBe(10)
    expect(await readAll(o.stream)).toBe('0123456789')
  })
  it('streams only the requested bytes', async () => {
    const o = await openStoredObject('clip.bin', 'bytes=2-4')
    expect(o.range).toEqual({ start: 2, end: 4 })
    expect(await readAll(o.stream)).toBe('234')
  })
  it('marks an unsatisfiable range', async () => {
    const o = await openStoredObject('clip.bin', 'bytes=50-')
    expect(o.unsatisfiable).toBe(true)
  })
})
