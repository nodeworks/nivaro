import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 2026-11-18 prod: after a host patch reboot the NFS share's parent folder (/app/uploads, owned by
// nobody, 755) refused mkdir with EACCES even for the EXISTING directus-uploads folder, so every
// file request — reads included — failed while constructing the storage. Simulate that server:
// mkdir of a path that already exists answers EACCES instead of EEXIST.
const fsCalls = vi.hoisted(() => ({ mkdir: [] as string[] }))
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    mkdirSync: (p: string, o?: unknown) => {
      fsCalls.mkdir.push(String(p))
      if (actual.existsSync(p))
        throw Object.assign(new Error(`EACCES: permission denied, mkdir '${p}'`), {
          code: 'EACCES'
        })
      return actual.mkdirSync(p, o as never)
    }
  }
})
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>()
  const { existsSync } = await import('node:fs')
  return {
    ...actual,
    mkdir: async (p: string, o?: unknown) => {
      fsCalls.mkdir.push(String(p))
      if (existsSync(p))
        throw Object.assign(new Error(`EACCES: permission denied, mkdir '${p}'`), {
          code: 'EACCES'
        })
      return actual.mkdir(p, o as never)
    }
  }
})

let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nvr-local-storage-'))
  fsCalls.mkdir.length = 0
  vi.resetModules()
  vi.doMock('../../config.js', () => ({ config: { STORAGE_LOCAL_ROOT: dir } }))
})
afterEach(() => {
  vi.doUnmock('../../config.js')
  rmSync(dir, { recursive: true, force: true })
})

describe('LocalStorage on a share that refuses mkdir of an existing folder', () => {
  it('starts without creating a root that already exists', async () => {
    const { LocalStorage } = await import('./local.js')
    expect(() => new LocalStorage()).not.toThrow()
    expect(fsCalls.mkdir).toEqual([])
  })

  it('reads and writes a top-level key without creating the root again', async () => {
    const { LocalStorage } = await import('./local.js')
    const s = new LocalStorage()
    await s.put('a.txt', Buffer.from('hi'), 'text/plain')
    expect((await s.get('a.txt')).toString()).toBe('hi')
    expect(await s.exists('a.txt')).toBe(true)
    expect(fsCalls.mkdir).toEqual([])
  })

  it('still creates a missing sub-folder for a nested key', async () => {
    const { LocalStorage } = await import('./local.js')
    const s = new LocalStorage()
    await s.put('transforms/1/x.webp', Buffer.from('w'), 'image/webp')
    expect((await s.get('transforms/1/x.webp')).toString()).toBe('w')
    expect(fsCalls.mkdir).toEqual([join(dir, 'transforms', '1')])
  })

  it('putFile streams a file on disk into place without creating the root again', async () => {
    const { writeFileSync } = await import('node:fs')
    const { LocalStorage } = await import('./local.js')
    const s = new LocalStorage()
    const src = join(dir, 'export-src.csv')
    writeFileSync(src, 'a,b\r\n1,2')
    expect(await s.putFile('exports/x.csv', src, 'text/csv')).toBe(8)
    expect((await s.get('exports/x.csv')).toString()).toBe('a,b\r\n1,2')
    expect(fsCalls.mkdir).toEqual([join(dir, 'exports')])
  })

  it('putFile stops when its signal is aborted (Cancel reaches the upload)', async () => {
    const { writeFileSync } = await import('node:fs')
    const { LocalStorage } = await import('./local.js')
    const s = new LocalStorage()
    const src = join(dir, 'export-src.csv')
    writeFileSync(src, 'a,b')
    const ac = new AbortController()
    ac.abort()
    await expect(
      s.putFile('exports/y.csv', src, 'text/csv', { signal: ac.signal })
    ).rejects.toThrow()
  })

  it('creates the root when it is missing', async () => {
    const root = join(dir, 'missing', 'root')
    vi.doMock('../../config.js', () => ({ config: { STORAGE_LOCAL_ROOT: root } }))
    const { LocalStorage } = await import('./local.js')
    new LocalStorage()
    expect(fsCalls.mkdir).toEqual([root])
  })
})
