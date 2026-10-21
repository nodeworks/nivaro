import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({
  previewBulk: vi.fn(async () => [{ layout_id: 1, status: 'change' }]),
  countFieldValues: vi.fn(async () => ({ populated: 3, total: 10, note: null })),
  applyBulk: vi.fn(async () => [
    { layout_id: 1, name: 'A', status: 'applied', reason: null, version_id: 9, rev: 'x' },
    { layout_id: 2, name: 'B', status: 'skipped', reason: 'no', version_id: null, rev: null }
  ]),
  undoBulk: vi.fn(async () => [{ layout_id: 1, status: 'restored', reason: null }]),
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
vi.mock('../../../services/layout-bulk.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/layout-bulk.js')>()
  return {
    ...real,
    previewBulk: svc.previewBulk,
    countFieldValues: svc.countFieldValues,
    applyBulk: svc.applyBulk,
    undoBulk: svc.undoBulk
  }
})

import { layoutBulkRoutes } from '../../../routes/layout-bulk.js'

async function call(url: string, payload: Record<string, unknown>) {
  const app = Fastify({ logger: false })
  const marks: unknown[] = []
  app.addHook('onResponse', async (req) => {
    marks.push((req as { nvrConfigRead?: unknown }).nvrConfigRead)
  })
  app.register(layoutBulkRoutes, { prefix: '/collection-layouts' })
  await app.ready()
  const res = await app.inject({ method: 'POST', url: `/collection-layouts${url}`, payload })
  await app.close()
  return { res, configRead: marks[0] === true }
}

beforeEach(() => vi.clearAllMocks())

describe('layout bulk routes', () => {
  it('previews as a read, counting values only for retire', async () => {
    const r = await call('/bulk/preview', {
      collection: 'po',
      action: { kind: 'retire', field: 'old_field' },
      labels: { old_field: 'Old field' }
    })
    expect(r.res.statusCode).toBe(200)
    expect(r.configRead).toBe(true)
    expect(r.res.json().data).toMatchObject({
      label: 'Retire Old field from every form',
      values: { populated: 3, total: 10 }
    })
    const c = await call('/bulk/preview', {
      collection: 'po',
      action: { kind: 'change', change: { type: 'remove', field: 'x' } }
    })
    expect(c.res.json().data.values).toBeNull()
    expect(svc.countFieldValues).toHaveBeenCalledTimes(1)
  })

  it('refuses a bad collection or action', async () => {
    expect(
      (await call('/bulk/preview', { collection: 'a b', action: { kind: 'retire', field: 'x' } }))
        .res.statusCode
    ).toBe(400)
    expect(
      (await call('/bulk/apply', { collection: 'po', action: { kind: 'drop' } })).res.statusCode
    ).toBe(400)
  })

  it('applies with the preview revs and logs only the changed forms', async () => {
    const r = await call('/bulk/apply', {
      collection: 'po',
      action: { kind: 'change', change: { type: 'set_width', field: 'x', width: 6 } },
      layout_ids: [1, '2', 'nope'],
      revs: { 1: 'a' }
    })
    expect(r.res.statusCode).toBe(200)
    expect(r.configRead).toBe(false)
    expect(svc.applyBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'po',
        only: [1, 2],
        revs: { 1: 'a' },
        note: 'Make x half',
        userId: 'admin-1'
      })
    )
    expect(svc.logActivity).toHaveBeenCalledTimes(1)
  })

  it('undo needs whole items', async () => {
    const bad = await call('/bulk/undo', { collection: 'po', items: [{ layout_id: 1 }] })
    expect(bad.res.statusCode).toBe(400)
    const ok = await call('/bulk/undo', {
      collection: 'po',
      items: [{ layout_id: 1, version_id: 9, rev: 'x' }]
    })
    expect(ok.res.statusCode).toBe(200)
    expect(svc.undoBulk).toHaveBeenCalledWith(
      'po',
      [{ layout_id: 1, version_id: 9, rev: 'x' }],
      'admin-1'
    )
  })
})
