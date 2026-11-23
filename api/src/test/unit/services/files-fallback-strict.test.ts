import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub phase 6 parked R7-M-1 (final review rest): a move reads a file the source no longer holds
// itself through FILES_FALLBACK_DIR. existingFallback() swallowed every stat error as "missing",
// so EACCES / EIO / ESTALE on an NFS fallback mount (prod had that EACCES on 2026-11-18) made the
// move log the file "missing at the source" and skip it for good once the source retired. In
// strict mode (the move's chain) only ENOENT / ENOTDIR mean missing; anything else is thrown.

const h = vi.hoisted(() => ({ own: '' }))
vi.mock('../../../services/storage/index.js', async () => {
  const { LocalStorage } = await import('../../../services/storage/local.js')
  const s = Object.create(LocalStorage.prototype) as InstanceType<typeof LocalStorage>
  ;(s as unknown as { resolveKey: (k: string) => string }).resolveKey = (k: string) =>
    join(h.own, k)
  return { getStorage: () => s }
})
vi.mock('../../../services/storage-drivers.js', () => ({
  getActiveStorageDriver: async () => ({ name: 'local' }),
  readOwnStoredObject: async () => {
    throw new Error('not used')
  }
}))
vi.mock('../../../services/storage/fallback-url.js', () => ({
  openFallbackUrl: async () => null,
  peekFallbackUrl: async () => null
}))

const { existingFallback } = await import('../../../services/storage/fallback.js')
const { openTransferObject } = await import('../../../services/stored-object-stream.js')
const { isStoredObjectMissing } = await import('../../../services/storage/missing.js')

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
let root = ''
const saved = { dir: process.env.FILES_FALLBACK_DIR, cloud: process.env.CLOUD_META_DB_URL }
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nvr-fallback-strict-'))
  h.own = mkdtempSync(join(tmpdir(), 'nvr-own-'))
  mkdirSync(join(root, 'ok'))
  writeFileSync(join(root, 'ok', 'a.bin'), 'bytes')
  writeFileSync(join(root, 'file.txt'), 'x')
  mkdirSync(join(root, 'locked'))
  writeFileSync(join(root, 'locked', 'b.bin'), 'hidden')
  chmodSync(join(root, 'locked'), 0o000)
  process.env.FILES_FALLBACK_DIR = root
  delete process.env.CLOUD_META_DB_URL
})
afterAll(() => {
  chmodSync(join(root, 'locked'), 0o755)
  if (saved.dir === undefined) delete process.env.FILES_FALLBACK_DIR
  else process.env.FILES_FALLBACK_DIR = saved.dir
  if (saved.cloud !== undefined) process.env.CLOUD_META_DB_URL = saved.cloud
})

describe('existingFallback strict', () => {
  it('missing (ENOENT, ENOTDIR) and a folder are null in both modes', async () => {
    for (const strict of [false, true]) {
      expect(await existingFallback('nope.bin', { strict })).toBeNull()
      expect(await existingFallback('file.txt/inner', { strict })).toBeNull()
      expect(await existingFallback('ok', { strict })).toBeNull()
      expect((await existingFallback('ok/a.bin', { strict }))?.size).toBe(5)
    }
  })

  it.skipIf(isRoot)('an unreadable path: null by default, thrown in strict mode', async () => {
    expect(await existingFallback('locked/b.bin')).toBeNull()
    await expect(existingFallback('locked/b.bin', { strict: true })).rejects.toMatchObject({
      code: 'EACCES'
    })
  })
})

describe('the move file chain (openTransferObject)', () => {
  it('reads a file only the fallback folder holds', async () => {
    const o = await openTransferObject('ok/a.bin', 'local')
    expect(o.size).toBe(5)
    o.stream.destroy()
  })

  it('a file nowhere is StoredObjectMissing', async () => {
    const err = await openTransferObject('nope.bin', 'local').catch((e) => e)
    expect(isStoredObjectMissing(err)).toBe(true)
  })

  it.skipIf(isRoot)('an unreadable fallback is a read error, never "missing"', async () => {
    const err = await openTransferObject('locked/b.bin', 'local').catch((e) => e)
    expect(isStoredObjectMissing(err)).toBe(false)
    expect((err as { code?: string }).code).toBe('EACCES')
  })
})

// Hub phase 6 untested path 1: a fallback folder that is gone (an unmounted NFS volume answers
// ENOENT for every key) made every file of a move "missing", so the move released without them.
describe('a fallback folder that is not there', () => {
  it('strict: thrown as FALLBACK_FOLDER_UNAVAILABLE (never "missing"); default: no copy', async () => {
    process.env.FILES_FALLBACK_DIR = join(root, 'not-mounted')
    try {
      expect(await existingFallback('ok/a.bin')).toBeNull()
      const err = await existingFallback('ok/a.bin', { strict: true }).catch((e) => e)
      expect(err).toMatchObject({ code: 'FALLBACK_FOLDER_UNAVAILABLE' })
      expect(String((err as Error).message)).not.toContain(root)
      const opened = await openTransferObject('ok/a.bin', 'local').catch((e) => e)
      expect(isStoredObjectMissing(opened)).toBe(false)
      // A file, not a folder, is not there either.
      process.env.FILES_FALLBACK_DIR = join(root, 'file.txt')
      await expect(existingFallback('x.bin', { strict: true })).rejects.toMatchObject({
        code: 'FALLBACK_FOLDER_UNAVAILABLE'
      })
    } finally {
      process.env.FILES_FALLBACK_DIR = root
    }
  })
})
