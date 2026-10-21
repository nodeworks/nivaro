import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({
  previewMerge: vi.fn(async () => ({ keep: { id: 1 }, fold: { id: 2 }, changes: [] })),
  applyMerge: vi.fn(async () => ({
    keep: { layout_id: 1, name: 'A', version_id: 7, rev: 'k' },
    fold: { layout_id: 2, name: 'B (merged into A)', version_id: 8, rev: 'f' }
  })),
  undoMerge: vi.fn(async () => [
    { layout_id: 1, status: 'restored', reason: null },
    { layout_id: 2, status: 'restored', reason: null }
  ]),
  buildChangeLog: vi.fn(async () => ({
    truncated: false,
    rows: [
      {
        at: '2026-10-20T10:00:00.000Z',
        collection: 'po',
        layout_id: 1,
        layout: 'A',
        version: 2,
        version_name: null,
        who: 'Ana',
        who_email: null,
        note: null,
        summary: 'New: Hours',
        sections_added: 0,
        sections_removed: 0,
        fields_added: 1,
        fields_removed: 0,
        fields_moved: 0,
        settings_changed: []
      }
    ]
  })),
  logActivity: vi.fn(async () => {})
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: 'admin-1' }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: svc.logActivity }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/layout-merge.js', () => ({
  previewMerge: svc.previewMerge,
  applyMerge: svc.applyMerge,
  undoMerge: svc.undoMerge
}))
vi.mock('../../../services/layout-change-log.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/layout-change-log.js')>()
  return { ...real, buildChangeLog: svc.buildChangeLog }
})

import { layoutMergeRoutes } from '../../../routes/layout-merge.js'

async function call(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  const app = Fastify({ logger: false })
  const marks: unknown[] = []
  app.addHook('onResponse', async (req) => {
    marks.push((req as { nvrConfigRead?: unknown }).nvrConfigRead)
  })
  app.register(layoutMergeRoutes, { prefix: '/collection-layouts' })
  await app.ready()
  const res = await app.inject({ method, url: `/collection-layouts${url}`, payload })
  await app.close()
  return { res, configRead: marks[0] === true }
}

beforeEach(() => vi.clearAllMocks())

describe('layout merge routes', () => {
  it('previews as a read and refuses a missing form', async () => {
    const ok = await call('POST', '/merge/preview', { collection: 'po', keep_id: 1, fold_id: 2 })
    expect(ok.res.statusCode).toBe(200)
    expect(ok.configRead).toBe(true)
    expect(svc.previewMerge).toHaveBeenCalledWith('po', 1, 2, 'admin-1')
    const bad = await call('POST', '/merge/preview', { collection: 'po', keep_id: 1 })
    expect(bad.res.statusCode).toBe(400)
  })

  it('applies only with the revs the preview read, logging both forms', async () => {
    const none = await call('POST', '/merge/apply', { collection: 'po', keep_id: 1, fold_id: 2 })
    expect(none.res.statusCode).toBe(400)
    const r = await call('POST', '/merge/apply', {
      collection: 'po',
      keep_id: 1,
      fold_id: 2,
      revs: { keep: 'a', fold: 'b' },
      reason: 'Consolidate'
    })
    expect(r.res.statusCode).toBe(200)
    expect(svc.applyMerge).toHaveBeenCalledWith(
      expect.objectContaining({ revs: { keep: 'a', fold: 'b' }, reason: 'Consolidate' })
    )
    expect(svc.logActivity).toHaveBeenCalledTimes(2)
  })

  it('passes a refusal through with its status', async () => {
    svc.applyMerge.mockResolvedValueOnce({ status: 409, error: 'stale' } as never)
    const r = await call('POST', '/merge/apply', {
      collection: 'po',
      keep_id: 1,
      fold_id: 2,
      revs: { keep: 'a', fold: 'b' }
    })
    expect(r.res.statusCode).toBe(409)
    expect(svc.logActivity).not.toHaveBeenCalled()
  })

  it('undoes both forms', async () => {
    const r = await call('POST', '/merge/undo', {
      collection: 'po',
      keep: { layout_id: 1, version_id: 7, rev: 'k' },
      fold: { layout_id: 2, version_id: 8, rev: 'f' }
    })
    expect(r.res.statusCode).toBe(200)
    expect(svc.undoMerge).toHaveBeenCalledWith(
      'po',
      {
        keep: { layout_id: 1, version_id: 7, rev: 'k' },
        fold: { layout_id: 2, version_id: 8, rev: 'f' }
      },
      'admin-1'
    )
  })

  it('serves the change log as JSON or a CSV download', async () => {
    const json = await call('GET', '/change-log?from=2026-10-01&to=2026-10-21&collection=po')
    expect(json.res.statusCode).toBe(200)
    expect(json.res.json().data.rows).toHaveLength(1)
    const csv = await call('GET', '/change-log?from=2026-10-01&to=2026-10-21&format=csv')
    expect(csv.res.headers['content-type']).toMatch(/text\/csv/)
    expect(csv.res.headers['content-disposition']).toContain(
      'layout-changes-all-2026-10-01-to-2026-10-21.csv'
    )
    expect(csv.res.body).toContain('"New: Hours"')
    const bad = await call('GET', '/change-log?from=2026-10-21&to=2026-10-01')
    expect(bad.res.statusCode).toBe(400)
  })
})
