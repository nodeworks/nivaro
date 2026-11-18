import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportAborted, NdjsonSpool } from '../../../services/export-files.js'
import { setStoredExportLimitsForTests } from '../../../services/export-limits.js'

// GET /items/:collection/export used to ask readItems for 10,000 rows and get
// the 1,000-row list cap back without a word. It pages with offset now, ties
// on id, and says when more rows matched than one export holds.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'ADMIN-1', role: 'ADMIN-ROLE' }
    req.isAdmin = true
  }
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
// Keyset paging (services/export-paging.ts): the next page is `id > <last id>`.
const afterIdOf = vi.hoisted(() => {
  const fn = (f: unknown): number | null => {
    if (!f || typeof f !== 'object') return null
    const o = f as Record<string, any>
    if (o.id?._gt != null) return Number(o.id._gt)
    if (Array.isArray(o._and))
      for (const x of o._and) {
        const n = fn(x)
        if (n != null) return n
      }
    return null
  }
  return fn
})
const state = vi.hoisted(() => ({ total: 0 }))
const svc = vi.hoisted(() => ({
  readItems: vi.fn(
    async (
      _u: unknown,
      _c: string,
      q: { limit?: number; offset?: number; sort?: string[]; filter?: unknown }
    ) => {
      const from = (afterIdOf(q.filter) ?? 0) + (q.offset ?? 0)
      const n = Math.max(0, Math.min(q.limit ?? 25, 1000, state.total - from))
      return { data: Array.from({ length: n }, (_, i) => ({ id: from + i + 1 })), total: null }
    }
  ),
  getActualColumns: vi.fn(async () => new Set(['id', 'name']))
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  ...svc
}))

const bg = vi.hoisted(() => ({
  uploads: [] as Array<{ user: string; buffer: Buffer; private: boolean }>,
  notices: [] as string[],
  progress: [] as Array<Record<string, unknown>>
}))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: vi.fn(async () => ({
    id: 77,
    progress: (p: Record<string, unknown>) => bg.progress.push(p),
    log: () => {},
    complete: async () => {},
    fail: async () => {}
  }))
}))
vi.mock('../../../services/live-progress.js', async (orig) => ({
  ...(await orig<object>()),
  emitJobProgress: vi.fn()
}))
vi.mock('../../../services/files.js', () => ({
  // The background job uploads the finished temp file from disk (streamed).
  uploadFileFromPath: vi.fn(
    async (
      u: { id: string },
      path: string,
      _n: string,
      _t: string,
      _f: unknown,
      o: { private?: boolean }
    ) => {
      const { readFile } = await import('node:fs/promises')
      bg.uploads.push({ user: u.id, buffer: await readFile(path), private: !!o?.private })
      return { id: 'f1234567-0000-0000-0000-000000000000' }
    }
  ),
  uploadFileBuffer: vi.fn(
    async (
      u: { id: string },
      buffer: Buffer,
      _n: string,
      _t: string,
      _f: unknown,
      o: { private?: boolean }
    ) => {
      bg.uploads.push({ user: u.id, buffer, private: !!o?.private })
      return { id: 'f1234567-0000-0000-0000-000000000000' }
    }
  )
}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_a: unknown, user: string) => {
    bg.notices.push(user)
    return { id: 1 }
  })
}))
vi.mock('../../../services/mail-builders.js', () => ({
  buildExportReadyMail: async () => null
}))

import { buildItemsExport, itemsRoutes } from '../../../routes/items.js'
import { __waitForExportRun } from '../../../services/export-runs.js'

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

beforeEach(() => {
  process.env.EXPORT_FILE_MAX_ROWS = '10000'
  // A synchronous answer holds the request cap (fix round 1, decision B).
  process.env.EXPORT_REQUEST_MAX_ROWS = '10000'
  setStoredExportLimitsForTests({})
  svc.readItems.mockClear()
})

describe('GET /items/:collection/export', () => {
  it('pages past the 1,000-row read cap', async () => {
    state.total = 2500
    const res = await (await app()).inject({ url: '/api/items/articles/export?format=json' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(2500)
    expect(res.headers['x-nivaro-export-truncated']).toBeUndefined()
    // Keyset on id (fix round 1): every read starts at offset 0 after the last id read.
    const reads = svc.readItems.mock.calls.map((c) => c[2] as { offset: number; filter?: unknown })
    expect(reads.map((r) => r.offset)).toEqual([0, 0, 0])
    expect(reads.map((r) => r.filter)).toEqual([
      undefined,
      { id: { _gt: 1000 } },
      { id: { _gt: 2000 } }
    ])
    // id breaks ties so offset pages neither repeat nor skip rows
    expect((svc.readItems.mock.calls[0][2] as { sort: string[] }).sort).toEqual(['id'])
  })

  it('keeps the caller sort and does not repeat id', async () => {
    state.total = 3
    await (await app()).inject({ url: '/api/items/articles/export?sort=-name,id' })
    expect((svc.readItems.mock.calls[0][2] as { sort: string[] }).sort).toEqual(['-name', 'id'])
  })

  it('stops at 10,000 rows and says so when more matched', async () => {
    state.total = 12000
    const res = await (await app()).inject({ url: '/api/items/articles/export?format=json' })
    expect(res.json().data).toHaveLength(10000)
    expect(res.headers['x-nivaro-export-truncated']).toBe('10000')
  })

  it('exactly 10,000 rows is not truncated', async () => {
    state.total = 10000
    const res = await (await app()).inject({ url: '/api/items/articles/export?format=json' })
    expect(res.json().data).toHaveLength(10000)
    expect(res.headers['x-nivaro-export-truncated']).toBeUndefined()
  })

  it('background=1 runs the same build as a job and saves the same file privately', async () => {
    state.total = 2500
    const a = await app()
    const sync = await a.inject({ url: '/api/items/articles/export' })
    const res = await a.inject({ url: '/api/items/articles/export?background=1' })
    expect(res.statusCode).toBe(202)
    expect(res.json().data).toMatchObject({ mode: 'background', run_id: 77, key: 'job:77' })
    await __waitForExportRun(77)
    expect(bg.uploads).toHaveLength(1)
    expect(bg.uploads[0].buffer.toString('utf8')).toBe(sync.body)
    expect(bg.uploads[0]).toMatchObject({ user: 'ADMIN-1', private: true })
    expect(bg.notices).toEqual(['ADMIN-1'])
    expect(bg.progress.at(-1)).toMatchObject({ phase: 'Saving the file', done: 2500 })
  }, 20_000)

  it('background=auto keeps a small export instant', async () => {
    state.total = 30
    const res = await (await app()).inject({ url: '/api/items/articles/export?background=auto' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('articles-export.csv')
  })
})

describe('fix round 1: request cap, client gone, temp files', () => {
  it('an answer made in the request holds request_rows; a background run holds every row', async () => {
    // Background files have no limit; the request cap is the smallest it may be.
    delete process.env.EXPORT_FILE_MAX_ROWS
    process.env.EXPORT_REQUEST_MAX_ROWS = '1000'
    state.total = 2500
    bg.uploads.length = 0
    const a = await app()
    const sync = await a.inject({ url: '/api/items/articles/export?format=json' })
    expect(sync.json().data).toHaveLength(1000)
    expect(sync.headers['x-nivaro-export-truncated']).toBe('1000')
    const res = await a.inject({ url: '/api/items/articles/export?format=json&background=1' })
    expect(res.statusCode).toBe(202)
    await __waitForExportRun(77)
    expect(JSON.parse(bg.uploads[0].buffer.toString('utf8')).data).toHaveLength(2500)
  }, 20_000)

  it('a synchronous build stops between pages once the caller left, leaving no temp file', async () => {
    const work = await mkdtemp(join(tmpdir(), 'nvr-items-gone-'))
    process.env.EXPORT_WORK_DIR = work
    try {
      state.total = 2500
      const gone = new AbortController()
      // The caller leaves while the first page is read.
      svc.readItems.mockImplementationOnce(async () => {
        gone.abort()
        return { data: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 })), total: null }
      })
      await expect(
        buildItemsExport({ id: 'U' } as never, 'articles', {}, undefined, undefined, undefined, {
          signal: gone.signal
        })
      ).rejects.toBeInstanceOf(ExportAborted)
      expect(svc.readItems).toHaveBeenCalledTimes(1)
      expect(await readdir(work)).toEqual([])
    } finally {
      delete process.env.EXPORT_WORK_DIR
    }
  })

  it('when the second temp file cannot be opened the first one is removed', async () => {
    const work = await mkdtemp(join(tmpdir(), 'nvr-items-open-'))
    process.env.EXPORT_WORK_DIR = work
    const spy = vi.spyOn(NdjsonSpool, 'open').mockRejectedValueOnce(new Error('EMFILE'))
    try {
      state.total = 3
      await expect(
        buildItemsExport({ id: 'U' } as never, 'articles', {}, undefined, undefined, undefined)
      ).rejects.toThrow('EMFILE')
      expect(await readdir(work)).toEqual([])
    } finally {
      spy.mockRestore()
      delete process.env.EXPORT_WORK_DIR
    }
  })
})
