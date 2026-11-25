import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createStorageProbe,
  STATFS_TTL_MS,
  type StatfsLike,
  storageOptionsFrom,
  walkTree
} from '../src/storage.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const fs1 = (over: Partial<StatfsLike> = {}): StatfsLike => ({
  bsize: 1000,
  blocks: 100,
  bfree: 20,
  bavail: 10,
  ...over
})

describe('storageOptionsFrom', () => {
  it('reads an absolute path and the nfs kind from the volume options', () => {
    expect(storageOptionsFrom({ HUB_AGENT_STORAGE_PATH: '/mnt/vols/' }, { type: 'nfs4' })).toEqual({
      path: '/mnt/vols/',
      walk: true,
      kind: 'nfs'
    })
  })
  it('refuses a relative path or one with ..', () => {
    expect(storageOptionsFrom({ HUB_AGENT_STORAGE_PATH: 'vols' }).path).toBeNull()
    expect(storageOptionsFrom({ HUB_AGENT_STORAGE_PATH: '/mnt/../etc' }).path).toBeNull()
    expect(storageOptionsFrom({}).path).toBeNull()
  })
  it('HUB_AGENT_STORAGE_WALK=off skips the tree walk; local by default', () => {
    const o = storageOptionsFrom({ HUB_AGENT_STORAGE_PATH: '/v', HUB_AGENT_STORAGE_WALK: 'off' })
    expect(o.walk).toBe(false)
    expect(o.kind).toBe('local')
  })
})

describe('createStorageProbe', () => {
  it('not configured: reads nothing', async () => {
    let called = 0
    const p = createStorageProbe(
      { path: null, walk: true, kind: 'local' },
      {
        statfs: async () => {
          called++
          return fs1()
        }
      }
    )
    const r = await p.report()
    expect(r).toMatchObject({ configured: false, state: 'not_configured', used_pct: null })
    expect(called).toBe(0)
  })

  it('statfs figures: used against used + available, like df', async () => {
    const p = createStorageProbe(
      { path: '/v', walk: false, kind: 'nfs' },
      { statfs: async () => fs1() }
    )
    const r = await p.report()
    expect(r).toMatchObject({
      configured: true,
      kind: 'nfs',
      state: 'ok',
      total_bytes: 100_000,
      free_bytes: 10_000,
      used_bytes: 80_000,
      used_pct: 88.9,
      tree: null
    })
  })

  it('caches statfs for its TTL', async () => {
    let t = 0
    let calls = 0
    const p = createStorageProbe(
      { path: '/v', walk: false, kind: 'local' },
      {
        now: () => t,
        statfs: async () => {
          calls++
          return fs1()
        }
      }
    )
    await p.report()
    await p.report()
    expect(calls).toBe(1)
    t += STATFS_TTL_MS + 1
    await p.report()
    expect(calls).toBe(2)
  })

  it('a hung statfs reports timeout and never stacks a second call', async () => {
    let calls = 0
    const p = createStorageProbe(
      { path: '/v', walk: false, kind: 'nfs' },
      {
        statfsTimeoutMs: 10,
        statfs: () => {
          calls++
          return new Promise<StatfsLike>(() => {})
        }
      }
    )
    expect((await p.report()).state).toBe('timeout')
    expect((await p.report()).state).toBe('timeout')
    expect(calls).toBe(1)
  })

  it('an unreadable path is a fixed word, never the error text', async () => {
    const p = createStorageProbe(
      { path: '/v', walk: false, kind: 'local' },
      {
        statfs: async () => {
          throw new Error('ENOENT /secret/path')
        }
      }
    )
    const r = await p.report()
    expect(r.state).toBe('unreadable')
    expect(JSON.stringify(r)).not.toContain('secret')
  })

  it('walks the tree in the background and reports it on the next read', async () => {
    let release: (() => void) | undefined
    const p = createStorageProbe(
      { path: '/v', walk: true, kind: 'local' },
      {
        statfs: async () => fs1(),
        walk: () =>
          new Promise((resolve) => {
            release = () => resolve({ bytes: 42, files: 3, complete: true })
          })
      }
    )
    expect((await p.report()).tree).toBeNull()
    release?.()
    await new Promise((r) => setTimeout(r, 0))
    expect((await p.report()).tree).toMatchObject({ bytes: 42, files: 3, complete: true })
  })
})

describe('walkTree', () => {
  it('counts files and bytes; links are not followed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-storage-'))
    const outside = mkdtempSync(path.join(tmpdir(), 'agent-outside-'))
    dirs.push(root, outside)
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    writeFileSync(path.join(root, 'one'), 'x'.repeat(10))
    writeFileSync(path.join(root, 'a', 'two'), 'x'.repeat(20))
    writeFileSync(path.join(root, 'a', 'b', 'three'), 'x'.repeat(30))
    writeFileSync(path.join(outside, 'big'), 'x'.repeat(1000))
    symlinkSync(outside, path.join(root, 'link'))
    const r = await walkTree(root, { maxEntries: 1000, budgetMs: 10_000, now: Date.now })
    expect(r).toEqual({ bytes: 60, files: 3, complete: true })
  })

  it('stops at the entry limit and says the figures are a floor', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-storage-'))
    dirs.push(root)
    for (let i = 0; i < 10; i++) writeFileSync(path.join(root, `f${i}`), 'x')
    const r = await walkTree(root, { maxEntries: 4, budgetMs: 10_000, now: Date.now })
    expect(r.complete).toBe(false)
    expect(r.files).toBeLessThanOrEqual(4)
  })
})
