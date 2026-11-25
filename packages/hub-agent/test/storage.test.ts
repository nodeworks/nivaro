import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startAgent } from '../src/main.js'
import {
  createStorageProbe,
  STATFS_TTL_MS,
  type StatfsLike,
  storageOptionsFrom,
  walkTree
} from '../src/storage.js'
import { isNfsOpts } from '../src/volume-kind.js'

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
const NFS = { type: 'nfs4', o: 'addr=10.0.0.5', device: ':/exports/vols' }
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('isNfsOpts', () => {
  it('nfs and nfs4 only', () => {
    expect(isNfsOpts({ type: 'NFS' })).toBe(true)
    expect(isNfsOpts({ type: 'nfs4' })).toBe(true)
    expect(isNfsOpts({ type: 'cifs' })).toBe(false)
    expect(isNfsOpts({})).toBe(false)
  })
})

describe('storageOptionsFrom: one mount setting per kind', () => {
  it('NFS reads HUB_AGENT_VOLUME_EXPORT_MOUNT; the walk is off by default there', () => {
    expect(storageOptionsFrom({ HUB_AGENT_VOLUME_EXPORT_MOUNT: '/export/' }, NFS)).toEqual({
      ok: true,
      value: { path: '/export/', walk: false, kind: 'nfs' }
    })
  })
  it('NFS refuses HUB_AGENT_STORAGE_PATH (two settings for one mount)', () => {
    expect(storageOptionsFrom({ HUB_AGENT_STORAGE_PATH: '/x' }, NFS)).toEqual({
      ok: false,
      code: 'STORAGE_PATH_BAD'
    })
  })
  it('local reads HUB_AGENT_STORAGE_PATH; the walk is on by default', () => {
    expect(storageOptionsFrom({ HUB_AGENT_STORAGE_PATH: '/var/vols' })).toEqual({
      ok: true,
      value: { path: '/var/vols', walk: true, kind: 'local' }
    })
    expect(storageOptionsFrom({}).ok).toBe(true)
  })
  it('a relative path, a .. segment or a bad walk word refuses', () => {
    expect(storageOptionsFrom({ HUB_AGENT_STORAGE_PATH: 'vols' })).toMatchObject({ ok: false })
    expect(storageOptionsFrom({ HUB_AGENT_STORAGE_PATH: '/a/../etc' })).toMatchObject({
      ok: false
    })
    expect(storageOptionsFrom({ HUB_AGENT_VOLUME_EXPORT_MOUNT: 'export' }, NFS)).toMatchObject({
      ok: false,
      code: 'STORAGE_PATH_BAD'
    })
    expect(storageOptionsFrom({ HUB_AGENT_STORAGE_WALK: 'yes' })).toEqual({
      ok: false,
      code: 'STORAGE_WALK_BAD'
    })
  })
  it('the agent refuses to start on a bad setting, with its code only', async () => {
    const r = await startAgent({
      env: {
        HUB_AGENT_TOKEN_FILE: '/t',
        HUB_AGENT_EDGE: 'publish',
        HUB_AGENT_PUBLISH_PORTS: '3110-3119',
        HUB_AGENT_LISTEN: '127.0.0.1:0',
        HUB_AGENT_STORAGE_PATH: 'relative/path'
      },
      readFile: () => 'Server-Token-0123456789-ABCDEFGHIJ-xyz',
      log: () => {}
    })
    expect(r).toEqual({ ok: false, code: 'STORAGE_PATH_BAD' })
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
    expect(await p.report()).toMatchObject({ configured: false, state: 'not_configured' })
    expect(called).toBe(0)
  })

  it('never waits: the first read is pending, the next one has the figures', async () => {
    const p = createStorageProbe(
      { path: '/v', walk: false, kind: 'nfs' },
      { statfs: async () => fs1() }
    )
    expect((await p.report()).state).toBe('pending')
    await tick()
    expect(await p.report()).toMatchObject({
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

  it('refreshes in the background after its TTL, answering the last reading meanwhile', async () => {
    let t = 0
    let calls = 0
    const p = createStorageProbe(
      { path: '/v', walk: false, kind: 'local' },
      {
        now: () => t,
        statfs: async () => {
          calls++
          return fs1({ bavail: calls * 10 })
        }
      }
    )
    await p.report()
    await tick()
    await p.report()
    expect(calls).toBe(1)
    t += STATFS_TTL_MS + 1
    expect((await p.report()).free_bytes).toBe(10_000)
    await tick()
    expect(calls).toBe(2)
    expect((await p.report()).free_bytes).toBe(20_000)
  })

  it('a hung statfs: the health call answers at once, timeout with the last good figures, one call', async () => {
    let t = 0
    let calls = 0
    let hang = false
    const p = createStorageProbe(
      { path: '/v', walk: false, kind: 'nfs' },
      {
        now: () => t,
        statfsTimeoutMs: 5_000,
        statfs: () => {
          calls++
          return hang ? new Promise<StatfsLike>(() => {}) : Promise.resolve(fs1())
        }
      }
    )
    await p.report()
    await tick()
    hang = true
    t += STATFS_TTL_MS + 1
    const started = Date.now()
    await p.report()
    t += 6_000
    const r = await p.report()
    expect(Date.now() - started).toBeLessThan(500)
    expect(r).toMatchObject({ state: 'timeout', used_bytes: 80_000 })
    t += STATFS_TTL_MS
    await p.report()
    expect(calls).toBe(2)
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
    await p.report()
    await tick()
    const r = await p.report()
    expect(r.state).toBe('unreadable')
    expect(JSON.stringify(r)).not.toContain('secret')
  })

  it('walks the tree in the background and reports it on a later read', async () => {
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
    await p.report()
    await tick()
    expect((await p.report()).tree).toBeNull()
    release?.()
    await tick()
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
