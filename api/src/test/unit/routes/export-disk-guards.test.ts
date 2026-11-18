import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Disk guards for streamed exports (fix round 1, decision C): one export stops past the
// `max_file_mb` limit with a clear error and its temp file goes; a new export is refused (409)
// while the work dir holds more than EXPORT_WORK_DIR_MAX_MB; stale temps are swept every hour.

const limits = vi.hoisted(() => ({ maxFileMb: 2048 }))
vi.mock('../../../services/export-limits.js', async (orig) => {
  const real = await orig<typeof import('../../../services/export-limits.js')>()
  return {
    ...real,
    exportLimit: (k: Parameters<typeof real.exportLimit>[0]) =>
      k === 'max_file_mb' ? limits.maxFileMb : real.exportLimit(k)
  }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean; authMethod?: string }) => {
    req.user = { id: 'U1', role: 'R1' }
    req.isAdmin = true
    req.authMethod = 'session'
  }
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: vi.fn(async () => ({
    id: 5,
    progress: () => {},
    log: () => {},
    complete: async () => {},
    fail: async () => {}
  }))
}))
vi.mock('../../../services/live-progress.js', async (orig) => ({
  ...(await orig<object>()),
  emitJobProgress: vi.fn()
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  // Wide rows, 1,000 a page, numeric ids: 3,000 rows ≈ 1 MB of CSV.
  readItems: vi.fn(async (_u: unknown, _c: string, q: { limit?: number; filter?: any }) => {
    const after = Number(q.filter?.id?._gt ?? 0)
    const n = Math.max(0, Math.min(q.limit ?? 25, 1000, 3000 - after))
    return {
      data: Array.from({ length: n }, (_, i) => ({ id: after + i + 1, text: 'x'.repeat(300) })),
      total: 3000
    }
  }),
  getActualColumns: vi.fn(async () => new Set(['id', 'text']))
}))

import { buildItemsExport, itemsRoutes } from '../../../routes/items.js'
import {
  assertExportDiskRoom,
  ExportDiskBusy,
  ExportFileTooBig,
  ExportTextWriter,
  startExportTempSweeper,
  XlsxStreamWriter
} from '../../../services/export-files.js'

let work: string
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'nvr-export-disk-'))
  process.env.EXPORT_WORK_DIR = work
  limits.maxFileMb = 2048
})
afterEach(() => {
  delete process.env.EXPORT_WORK_DIR
  delete process.env.EXPORT_WORK_DIR_MAX_MB
  vi.useRealTimers()
})

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

describe('max_file_mb: one export never fills the disk', () => {
  it('a text file stops past the limit', async () => {
    limits.maxFileMb = 0.001 // ~1 KB
    const w = await ExportTextWriter.open('.csv')
    await w.write('x'.repeat(1000))
    await expect(w.write('x'.repeat(100))).rejects.toBeInstanceOf(ExportFileTooBig)
    await w.discard()
  })

  it('an XLSX file stops past the limit', async () => {
    limits.maxFileMb = 0.001
    const x = await XlsxStreamWriter.open()
    x.sheet('Export', { header: ['t'] })
    for (let i = 0; i < 50; i++) await x.row(['y'.repeat(200)])
    await expect(x.close()).rejects.toBeInstanceOf(ExportFileTooBig)
    await x.discard()
    expect(await filesUnder(work)).toEqual([])
  })

  it('the export answers 413 with a sentence and leaves no temp file', async () => {
    limits.maxFileMb = 0.5
    await expect(
      buildItemsExport({ id: 'U1' } as never, 'articles', {}, undefined, undefined, undefined)
    ).rejects.toBeInstanceOf(ExportFileTooBig)
    const res = await (await app()).inject({ url: '/api/items/articles/export?fields=id,text' })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toMatchObject({ code: 'EXPORT_TOO_BIG' })
    expect(res.json().error).toMatch(/narrow the filter/)
    expect(await filesUnder(work)).toEqual([])
  })
})

describe('EXPORT_WORK_DIR_MAX_MB: the work dir’s quota', () => {
  it('refuses a new export (409) while the work dir is over it', async () => {
    process.env.EXPORT_WORK_DIR_MAX_MB = '1'
    await writeFile(join(work, 'other-export.csv'), Buffer.alloc(2 * 1024 * 1024))
    await expect(assertExportDiskRoom()).rejects.toBeInstanceOf(ExportDiskBusy)
    const a = await app()
    const sync = await a.inject({ url: '/api/items/articles/export' })
    expect(sync.statusCode).toBe(409)
    expect(sync.json()).toMatchObject({ code: 'EXPORT_DISK_BUSY' })
    const bg = await a.inject({ url: '/api/items/articles/export?background=1' })
    expect(bg.statusCode).toBe(409)
    expect(bg.json().error).toMatch(/try again shortly/)
  })
})

describe('cloud mode: one tenant’s share of the work dir', () => {
  it('refuses a tenant over EXPORT_TENANT_WORK_DIR_MAX_MB while the whole dir has room', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    process.env.EXPORT_TENANT_WORK_DIR_MAX_MB = '1'
    try {
      const { exportProcessDir } = await import('../../../services/export-files.js')
      const { mkdir } = await import('node:fs/promises')
      // Temp files of the current tenant (no tenant context in a test: 't--').
      const w = await ExportTextWriter.open('.csv')
      expect(w.path).toContain(join(exportProcessDir(), 't--'))
      await w.discard()
      await mkdir(join(exportProcessDir(), 't--'), { recursive: true })
      await writeFile(join(exportProcessDir(), 't--', 'big.csv'), Buffer.alloc(2 * 1024 * 1024))
      await expect(assertExportDiskRoom()).rejects.toBeInstanceOf(ExportDiskBusy)
      // Another tenant's files do not count against this one.
      await writeFile(join(exportProcessDir(), 't--', 'big.csv'), '')
      await mkdir(join(exportProcessDir(), 't-other'), { recursive: true })
      await writeFile(join(exportProcessDir(), 't-other', 'big.csv'), Buffer.alloc(2 * 1024 * 1024))
      await new Promise((r) => setTimeout(r, 5))
      await expect(assertExportDiskRoom()).resolves.toBeUndefined()
    } finally {
      delete process.env.CLOUD_META_DB_URL
      delete process.env.EXPORT_TENANT_WORK_DIR_MAX_MB
    }
  })
})

describe('stale temp files', () => {
  it('are swept every hour, not only at boot', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const stop = startExportTempSweeper(3_600_000)
    try {
      const old = join(work, 'left-behind.csv')
      await writeFile(old, 'x')
      const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
      await utimes(old, twoDaysAgo, twoDaysAgo)
      await vi.advanceTimersByTimeAsync(3_600_000)
      for (let i = 0; i < 50 && (await filesUnder(work)).length > 0; i++)
        await new Promise((r) => setTimeout(r, 5))
      expect(await filesUnder(work)).toEqual([])
    } finally {
      stop()
    }
  })
})

/** Every file under `d` (the export work dir has one sub-directory per process). */
async function filesUnder(d: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory())
      for (const f of await filesUnder(join(d, e.name))) out.push(join(e.name, f))
    else out.push(e.name)
  }
  return out
}
