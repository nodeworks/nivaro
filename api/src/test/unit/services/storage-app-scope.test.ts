import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6, Task 11: on a Hub shared deployment the env-driven storage provider keys every
// object under apps/<tenantId>/, so two apps in one process (dev and prod copies of one
// database, same file keys) never read, list or delete each other's objects. Self-hosted and
// Nivaro Cloud stay exactly as they were.

const { root } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-app-scope-')) }
})
vi.mock('../../../config.js', async (orig) => {
  const real = (await orig()) as { config: Record<string, unknown> }
  return { ...real, config: { ...real.config, STORAGE_LOCAL_ROOT: root } }
})
// nivaro_settings reads, by the app they ran in ('' = none): the storage-driver cache test.
const settings = vi.hoisted(() => ({
  reads: [] as string[],
  row: { storage_driver: 'local', storage_config: null } as {
    storage_driver: string
    storage_config: string | null
  }
}))
vi.mock('../../../db/index.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  return {
    db: () => ({
      where: () => ({
        first: async () => {
          settings.reads.push(getTenantId() ?? '')
          return settings.row
        }
      })
    })
  }
})

import { runWithTenantDb } from '../../../db/tenant-context.js'
import { storageAdapterRegistry } from '../../../extensions/storage-adapters.js'
import { buildDiskName, getFilePath } from '../../../services/files.js'
import { AppScopeError, scopedStorage } from '../../../services/storage/app-scope.js'
import { getStorage, type StorageProvider } from '../../../services/storage/index.js'
import { instrumentStorage } from '../../../services/storage/instrument.js'
import { LocalStorage } from '../../../services/storage/local.js'
import {
  bustStorageDriverCache,
  deleteStoredObject,
  getActiveStorageDriver,
  readOwnStoredObject,
  testStorageDriver
} from '../../../services/storage-drivers.js'
import { openStoredObject } from '../../../services/stored-object-stream.js'

const SAVED = {
  HUB_SHARED_DEPLOYMENT: process.env.HUB_SHARED_DEPLOYMENT,
  CLOUD_META_DB_URL: process.env.CLOUD_META_DB_URL,
  STORAGE_PROVIDER: process.env.STORAGE_PROVIDER
}
function useEnv(mode: 'self' | 'cloud' | 'hub'): void {
  delete process.env.HUB_SHARED_DEPLOYMENT
  delete process.env.CLOUD_META_DB_URL
  delete process.env.STORAGE_PROVIDER
  if (mode === 'cloud') process.env.CLOUD_META_DB_URL = 'mssql://meta'
  if (mode === 'hub') process.env.HUB_SHARED_DEPLOYMENT = 'shared-one'
}
afterEach(() => useEnv('self'))
afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

/** Run `fn` inside a tenant's context, as the tenant middleware / withTenant do. */
function inTenant<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb({} as Knex, id, () => void fn().then(resolve, reject), id)
  })
}

async function readAll(s: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of s) chunks.push(Buffer.from(c as Buffer))
  return Buffer.concat(chunks).toString()
}

const A = 'efp-e1'
const B = 'efp-e2'

describe('scopedStorage (local disk)', () => {
  let current: string | null = null
  let s: LocalStorage
  beforeEach(() => {
    current = null
    s = scopedStorage(instrumentStorage(new LocalStorage(), 'local'), () => current)
  })
  const as = <T>(t: string | null, fn: () => Promise<T>): Promise<T> => {
    current = t
    return fn()
  }

  it('two tenants, same key, separate objects: each reads its own bytes', async () => {
    await as(A, () => s.put('same.txt', Buffer.from('prod'), 'text/plain'))
    await as(B, () => s.put('same.txt', Buffer.from('dev'), 'text/plain'))
    expect(readFileSync(join(root, 'apps', A, 'same.txt'), 'utf8')).toBe('prod')
    expect(readFileSync(join(root, 'apps', B, 'same.txt'), 'utf8')).toBe('dev')
    expect(existsSync(join(root, 'same.txt'))).toBe(false)
    expect((await as(A, () => s.get('same.txt'))).toString()).toBe('prod')
    expect((await as(B, () => s.get('same.txt'))).toString()).toBe('dev')
  })

  it('a delete in A leaves B’s object', async () => {
    await as(A, () => s.put('gone.txt', Buffer.from('a'), 'text/plain'))
    await as(B, () => s.put('gone.txt', Buffer.from('b'), 'text/plain'))
    await as(A, () => s.delete('gone.txt'))
    expect(await as(A, () => s.exists!('gone.txt'))).toBe(false)
    expect(await as(B, () => s.exists!('gone.txt'))).toBe(true)
    expect((await as(B, () => s.get('gone.txt'))).toString()).toBe('b')
  })

  it('list in A returns only A’s keys, without the prefix', async () => {
    await as(A, () => s.put('transforms/f1/x.webp', Buffer.from('1'), 'image/webp'))
    await as(A, () => s.put('transforms/f2/y.webp', Buffer.from('2'), 'image/webp'))
    await as(B, () => s.put('transforms/f9/z.webp', Buffer.from('9'), 'image/webp'))
    const keys = await as(A, () => s.list!('transforms/'))
    expect(keys.sort()).toEqual(['transforms/f1/x.webp', 'transforms/f2/y.webp'])
    expect(await as(B, () => s.list!('transforms/'))).toEqual(['transforms/f9/z.webp'])
  })

  it('putFile streams into the tenant’s scope', async () => {
    const src = join(root, 'src.bin')
    writeFileSync(src, 'streamed')
    const n = await as(A, () => s.putFile('exports/one.bin', src, 'application/octet-stream'))
    expect(n).toBe(8)
    expect(readFileSync(join(root, 'apps', A, 'exports', 'one.bin'), 'utf8')).toBe('streamed')
  })

  it('refuses a bad key with BAD_KEY (as a rejection for async calls)', async () => {
    current = A
    for (const key of [
      '../x',
      'a/../../x',
      'a/..',
      '..',
      './x',
      'a/./b',
      '/etc/passwd',
      'a\\b',
      'a\0b',
      ''
    ]) {
      const err = await s.get(key).then(
        () => null,
        (e: unknown) => e
      )
      expect(err, JSON.stringify(key)).toBeInstanceOf(AppScopeError)
      expect((err as AppScopeError).code).toBe('BAD_KEY')
    }
    // `.catch()` chains keep working: the refusal is a rejection, never a synchronous throw.
    await expect(s.delete('../x').catch(() => 'caught')).resolves.toBe('caught')
    expect(() => s.resolveKey('../x')).toThrow(AppScopeError)
  })

  it('a key that only contains two dots inside a name is fine', async () => {
    current = A
    await s.put('a..b.pdf', Buffer.from('dots'), 'application/pdf')
    expect(readFileSync(join(root, 'apps', A, 'a..b.pdf'), 'utf8')).toBe('dots')
  })

  it('with no tenant every call refuses with NO_APP_CONTEXT', async () => {
    current = null
    const err = await s.get('same.txt').then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(AppScopeError)
    expect((err as AppScopeError).code).toBe('NO_APP_CONTEXT')
    await expect(s.list!('')).rejects.toMatchObject({ code: 'NO_APP_CONTEXT' })
    expect(() => s.resolveKey('same.txt')).toThrow(/app/i)
    expect(() => s.getUrl('same.txt')).toThrow(AppScopeError)
  })

  it('refuses a tenant id that could leave its folder', async () => {
    for (const bad of ['..', 'a/b', 'a\\b', '.hidden', 'x'.repeat(200)]) {
      current = bad
      await expect(s.get('k.txt'), bad).rejects.toMatchObject({ code: 'NO_APP_CONTEXT' })
    }
  })

  it('resolveKey is scoped and instanceof LocalStorage still holds', () => {
    current = A
    expect(s).toBeInstanceOf(LocalStorage)
    expect(s.resolveKey('k/v.bin')).toBe(join(root, 'apps', A, 'k', 'v.bin'))
  })

  it('getUrl keeps the /api/files/raw/<key> shape, so the raw route resolves in scope', () => {
    current = A
    expect(s.getUrl('abc def.pdf')).toBe('/api/files/raw/abc%20def.pdf')
  })

  it('a method it does not know is refused, not passed through unscoped', () => {
    const base = Object.assign(new LocalStorage(), {
      somethingNew: (key: string) => key
    })
    const wrapped = scopedStorage(base, () => A) as unknown as {
      somethingNew: (k: string) => string
    }
    expect(() => wrapped.somethingNew('k')).toThrow(AppScopeError)
  })

  it('passes a provider `size(key)` through, scoped (preflight M9)', async () => {
    const seen: string[] = []
    const base = Object.assign(new LocalStorage(), {
      size: async (key: string) => {
        seen.push(key)
        return 3
      }
    })
    const wrapped = scopedStorage(base, () => A) as unknown as {
      size: (k: string) => Promise<number>
    }
    expect(await wrapped.size('a.bin')).toBe(3)
    expect(seen).toEqual([`apps/${A}/a.bin`])
  })
})

describe('scopedStorage over a presigning provider', () => {
  it('getUrl / getUploadUrl presign the scoped key', async () => {
    const urls: string[] = []
    const fake: StorageProvider = {
      put: async () => undefined,
      putFile: async () => 0,
      get: async () => Buffer.from(''),
      delete: async () => undefined,
      getUrl: (k) => {
        urls.push(k)
        return `https://bucket/${k}`
      },
      getUploadUrl: async (k) => `https://bucket/${k}?put`
    }
    const s = scopedStorage(fake, () => A)
    expect(s.getUrl('f.pdf')).toBe(`https://bucket/apps/${A}/f.pdf`)
    expect(await s.getUploadUrl?.('f.pdf', 'application/pdf')).toBe(
      `https://bucket/apps/${A}/f.pdf?put`
    )
  })
})

describe('getStorage() and buildDiskName by deployment mode', () => {
  it('self-hosted: the provider is unwrapped and keys are flat', async () => {
    useEnv('self')
    const s = getStorage()
    expect(s).toBeInstanceOf(LocalStorage)
    await s.put('self-flat.txt', Buffer.from('x'), 'text/plain')
    expect(existsSync(join(root, 'self-flat.txt'))).toBe(true)
    expect(buildDiskName('id1', '.pdf')).toBe('id1.pdf')
    expect(getFilePath({ filename_disk: 'id1.pdf' } as never)).toBe(join(root, 'id1.pdf'))
  })

  it('cloud: unwrapped, and buildDiskName keeps <tenantId>/files/…', async () => {
    useEnv('cloud')
    await inTenant('cloud-tenant', async () => {
      const s = getStorage()
      await s.put('cloud-flat.txt', Buffer.from('x'), 'text/plain')
      expect(existsSync(join(root, 'cloud-flat.txt'))).toBe(true)
      expect(buildDiskName('id2', '.png')).toBe('cloud-tenant/files/id2.png')
    })
  })

  it('hub: getStorage() is scoped to the current app and buildDiskName is flat', async () => {
    useEnv('hub')
    await inTenant(A, async () => {
      expect(buildDiskName('id3', '.png')).toBe('id3.png')
      const s = getStorage()
      expect(s).toBeInstanceOf(LocalStorage)
      await s.put('id3.png', Buffer.from('png-a'), 'image/png')
      expect(getFilePath({ filename_disk: 'id3.png' } as never)).toBe(
        join(root, 'apps', A, 'id3.png')
      )
    })
    expect(readFileSync(join(root, 'apps', A, 'id3.png'), 'utf8')).toBe('png-a')
    await inTenant(B, async () => {
      await expect(getStorage().get('id3.png')).rejects.toBeTruthy()
    })
    // Outside any app (a process job, a boot pass) nothing is reachable.
    await expect(getStorage().get('id3.png')).rejects.toMatchObject({ code: 'NO_APP_CONTEXT' })
  })

  it('hub: a range stream inside a tenant reads that tenant’s object only', async () => {
    useEnv('hub')
    await inTenant(A, () => getStorage().put('clip.bin', Buffer.from('0123456789'), 'video/mp4'))
    await inTenant(B, () => getStorage().put('clip.bin', Buffer.from('abcdefghij'), 'video/mp4'))
    const a = await inTenant(A, async () => {
      const o = await openStoredObject('clip.bin', 'bytes=2-4')
      return { size: o.size, range: o.range, body: await readAll(o.stream) }
    })
    expect(a).toEqual({ size: 10, range: { start: 2, end: 4 }, body: '234' })
    const b = await inTenant(B, async () => readAll((await openStoredObject('clip.bin')).stream))
    expect(b).toBe('abcdefghij')
  })
})

describe('settings storage driver cache', () => {
  beforeEach(() => {
    bustStorageDriverCache()
    settings.reads = []
  })

  it('self-hosted: one cached driver for the process', async () => {
    useEnv('self')
    await getActiveStorageDriver()
    await getActiveStorageDriver()
    expect(settings.reads).toEqual([''])
  })

  it('hub: each app reads its own settings; one app’s driver never serves another', async () => {
    useEnv('hub')
    await inTenant(A, () => getActiveStorageDriver())
    await inTenant(B, () => getActiveStorageDriver())
    await inTenant(A, () => getActiveStorageDriver())
    expect(settings.reads).toEqual([A, B])
  })
})

// A saved-settings S3 bucket both apps name (a dev copy of prod carries prod's settings row):
// an in-memory bucket behind a fake fetch, keyed by the request path.
describe('settings storage driver (shared bucket)', () => {
  const bucket = new Map<string, Buffer>()
  const S3_ROW = {
    storage_driver: 's3',
    storage_config: JSON.stringify({
      bucket: 'shared',
      access_key_id: 'AKTEST',
      secret_access_key: 'sk-test',
      endpoint: 'http://bucket.test'
    })
  }
  beforeEach(() => {
    bucket.clear()
    bustStorageDriverCache()
    settings.row = S3_ROW
    vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: Buffer }) => {
      const path = decodeURIComponent(new URL(url).pathname)
      if (init.method === 'PUT') {
        bucket.set(path, Buffer.from(init.body ?? ''))
        return new Response(null, { status: 200 })
      }
      const hit = bucket.get(path)
      if (init.method === 'DELETE') {
        bucket.delete(path)
        return new Response(null, { status: 204 })
      }
      if (!hit) return new Response('NoSuchKey', { status: 404 })
      return new Response(init.method === 'HEAD' ? null : new Uint8Array(hit), { status: 200 })
    })
  })
  afterEach(() => {
    settings.row = { storage_driver: 'local', storage_config: null }
    bustStorageDriverCache()
    vi.unstubAllGlobals()
  })

  it('hub: two apps on one bucket write, read and delete only their own keys', async () => {
    useEnv('hub')
    await inTenant(A, async () =>
      (await getActiveStorageDriver()).put('f.pdf', Buffer.from('prod'), 'application/pdf')
    )
    await inTenant(B, async () =>
      (await getActiveStorageDriver()).put('f.pdf', Buffer.from('dev'), 'application/pdf')
    )
    expect([...bucket.keys()].sort()).toEqual([
      `/shared/apps/${A}/f.pdf`,
      `/shared/apps/${B}/f.pdf`
    ])
    expect((await inTenant(A, () => readOwnStoredObject('f.pdf'))).toString()).toBe('prod')
    expect((await inTenant(B, () => readOwnStoredObject('f.pdf'))).toString()).toBe('dev')
    // A user delete or file-cleanup in B (deleteStoredObject) never reaches A's object.
    await inTenant(B, () => deleteStoredObject('f.pdf'))
    expect([...bucket.keys()]).toEqual([`/shared/apps/${A}/f.pdf`])
    expect(await inTenant(B, async () => (await getActiveStorageDriver()).exists('f.pdf'))).toBe(
      false
    )
    expect(await inTenant(A, async () => (await getActiveStorageDriver()).exists('f.pdf'))).toBe(
      true
    )
  })

  it('hub: session-replay keys (same recording ids in a copy) stay apart', async () => {
    useEnv('hub')
    const key = 'session-replays/2026/11/rec-1.ndjson.gz'
    await inTenant(A, async () =>
      (await getActiveStorageDriver()).put(key, Buffer.from('a'), 'application/gzip')
    )
    await inTenant(B, async () =>
      (await getActiveStorageDriver()).put(key, Buffer.from('b'), 'application/gzip')
    )
    await inTenant(A, () => deleteStoredObject(key))
    expect([...bucket.keys()]).toEqual([`/shared/apps/${B}/${key}`])
  })

  it('hub: outside an app, or with a bad key, nothing is sent to the bucket', async () => {
    useEnv('hub')
    const d = await inTenant(A, () => getActiveStorageDriver())
    await expect(d.put('f.pdf', Buffer.from('x'), 'application/pdf')).rejects.toMatchObject({
      code: 'NO_APP_CONTEXT'
    })
    await expect(inTenant(A, () => d.get('../x'))).rejects.toMatchObject({ code: 'BAD_KEY' })
    expect(bucket.size).toBe(0)
  })

  it('hub: the settings Test connection probe stays inside the app', async () => {
    useEnv('hub')
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: Buffer }) => {
      seen.push(decodeURIComponent(new URL(url).pathname))
      const path = decodeURIComponent(new URL(url).pathname)
      if (init.method === 'PUT') bucket.set(path, Buffer.from(init.body ?? ''))
      if (init.method === 'DELETE') bucket.delete(path)
      const hit = bucket.get(path)
      return new Response(init.method === 'GET' && hit ? new Uint8Array(hit) : null, {
        status: 200
      })
    })
    const r = await inTenant(A, () => testStorageDriver('s3', JSON.parse(S3_ROW.storage_config)))
    expect(r).toEqual({ ok: true })
    expect(seen.length).toBeGreaterThan(0)
    for (const p of seen) expect(p.startsWith(`/shared/apps/${A}/storage-probe/`), p).toBe(true)
  })

  it('self-hosted and cloud: settings keys are sent as they are', async () => {
    useEnv('self')
    await (await getActiveStorageDriver()).put('f.pdf', Buffer.from('x'), 'application/pdf')
    expect([...bucket.keys()]).toEqual(['/shared/f.pdf'])
    bucket.clear()
    bustStorageDriverCache()
    useEnv('cloud')
    await inTenant('cloud-tenant', async () =>
      (await getActiveStorageDriver()).put(
        'cloud-tenant/files/f.pdf',
        Buffer.from('x'),
        'application/pdf'
      )
    )
    expect([...bucket.keys()]).toEqual(['/shared/cloud-tenant/files/f.pdf'])
  })
})

describe('help-video upload scratch files', () => {
  const work = join(root, 'video-work')
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100'
  beforeEach(() => {
    process.env.VIDEO_WORK_DIR = work
  })
  afterEach(() => {
    delete process.env.VIDEO_WORK_DIR
    rmSync(work, { recursive: true, force: true })
  })
  const stale = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.part`), 'x')
    return join(dir, `${id}.part`)
  }

  it('hub: each app keeps its own scratch folder; a sweep in A never touches B', async () => {
    useEnv('hub')
    const { purgeTempFiles, uploadsWorkDir } = await import(
      '../../../services/help-video-uploads.js'
    )
    expect(await inTenant(A, async () => uploadsWorkDir())).toBe(join(work, 'uploads', 'apps', A))
    const a = stale(join(work, 'uploads', 'apps', A))
    const b = stale(join(work, 'uploads', 'apps', B))
    const later = Date.now() + 30 * 86_400_000
    expect(await inTenant(A, () => purgeTempFiles(later))).toBe(1)
    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(true)
    expect(() => uploadsWorkDir()).toThrow(AppScopeError)
  })

  it('self-hosted: the scratch folder is unchanged', async () => {
    useEnv('self')
    const { purgeTempFiles, uploadsWorkDir } = await import(
      '../../../services/help-video-uploads.js'
    )
    expect(uploadsWorkDir()).toBe(join(work, 'uploads'))
    const f = stale(join(work, 'uploads'))
    expect(await purgeTempFiles(Date.now() + 30 * 86_400_000)).toBe(1)
    expect(existsSync(f)).toBe(false)
  })
})

describe('extension local storage adapter', () => {
  const uploads = new URL('../../../../../uploads', import.meta.url).pathname
  const tenant = 'hub6-t11-adapter-test'
  // The adapter's folder is fixed (<repo>/uploads, gitignored): remove what this test made,
  // before (a run killed mid-test) and after.
  const clean = () => {
    rmSync(join(uploads, 'apps', tenant), { recursive: true, force: true })
    // Folders this test created, only when nothing else is in them.
    for (const dir of [join(uploads, 'apps'), uploads]) {
      try {
        rmdirSync(dir)
      } catch {
        // not empty, or already gone
      }
    }
  }
  beforeAll(clean)
  afterAll(clean)

  it('hub: keys are scoped to the app; a bad key or no app is refused', async () => {
    useEnv('hub')
    const adapter = storageAdapterRegistry.active
    await inTenant(tenant, () =>
      adapter.put('ext/a.txt', Readable.from([Buffer.from('ext')]), {
        filename: 'a.txt',
        mimetype: 'text/plain',
        size: 3
      })
    )
    expect(readFileSync(join(uploads, 'apps', tenant, 'ext', 'a.txt'), 'utf8')).toBe('ext')
    const back = await inTenant(tenant, () => adapter.get('ext/a.txt'))
    expect(await readAll(back)).toBe('ext')
    await expect(inTenant(tenant, () => adapter.get('../../package.json'))).rejects.toMatchObject({
      code: 'BAD_KEY'
    })
    await expect(adapter.get('ext/a.txt')).rejects.toMatchObject({ code: 'NO_APP_CONTEXT' })
    await inTenant(tenant, () => adapter.delete('ext/a.txt'))
    expect(existsSync(join(uploads, 'apps', tenant, 'ext', 'a.txt'))).toBe(false)
  })
})
