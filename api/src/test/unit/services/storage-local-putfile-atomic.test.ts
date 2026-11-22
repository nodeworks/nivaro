import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 10 fix M-4: LocalStorage.putFile never leaves a truncated object at the live
// key. It copies to a sibling part file, checks the byte count, then renames over the key; a copy
// that fails leaves the object that was there untouched and no part file behind.

const { root } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-local-putfile-')) }
})
vi.mock('../../../config.js', () => ({ config: { STORAGE_LOCAL_ROOT: root } }))

import { LocalStorage } from '../../../services/storage/local.js'

const parts = () => readdirSync(join(root, 'ab')).filter((f) => f !== 'live.bin')

describe('LocalStorage.putFile', () => {
  const storage = new LocalStorage()

  it('replaces the object whole and leaves no part file', async () => {
    await storage.put('ab/live.bin', Buffer.from('good old bytes'), 'application/octet-stream')
    const src = join(root, 'source-new.bin')
    writeFileSync(src, 'new bytes')
    expect(await storage.putFile('ab/live.bin', src, 'application/octet-stream')).toBe(9)
    expect(readFileSync(join(root, 'ab/live.bin'), 'utf8')).toBe('new bytes')
    expect(parts()).toEqual([])
  })

  it('a copy that fails (source gone) keeps the object that was there', async () => {
    await storage.put('ab/live.bin', Buffer.from('good old bytes'), 'application/octet-stream')
    await expect(
      storage.putFile('ab/live.bin', join(root, 'no-such-file'), 'application/octet-stream')
    ).rejects.toThrow()
    expect(readFileSync(join(root, 'ab/live.bin'), 'utf8')).toBe('good old bytes')
    expect(parts()).toEqual([])
  })

  it('an aborted copy keeps the object that was there', async () => {
    await storage.put('ab/live.bin', Buffer.from('good old bytes'), 'application/octet-stream')
    const src = join(root, 'source-big.bin')
    writeFileSync(src, Buffer.alloc(4 * 1024 * 1024, 7))
    await expect(
      storage.putFile('ab/live.bin', src, 'application/octet-stream', {
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow()
    expect(readFileSync(join(root, 'ab/live.bin'), 'utf8')).toBe('good old bytes')
    expect(parts()).toEqual([])
  })
})
