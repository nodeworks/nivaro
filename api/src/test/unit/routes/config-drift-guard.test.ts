import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Changes made on production, not from promotion: the apply / restore paths warn about the ones
 * they would overwrite, refuse only when the setting says so (and the caller did not override),
 * and the promote chain's guard + the mark route answer their contract. Store stubbed.
 */

const h = vi.hoisted(() => ({
  tracking: true,
  check: {
    active: true,
    refuse: false,
    items: [] as Array<Record<string, unknown>>,
    lines: [] as string[]
  },
  checks: [] as Array<{ target: unknown; opts: Record<string, unknown> }>,
  uploads: 0,
  restores: 0,
  marks: [] as Array<{ ids: string[]; opts: Record<string, unknown> }>,
  activity: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (row: Record<string, unknown>) => {
    h.activity.push(row)
    return 1
  }
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (
    req: { headers: Record<string, string>; user?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    if (req.headers['x-test-user'] !== 'admin') return reply.code(403).send({ error: 'Admin only' })
    req.user = { id: 'admin-1' }
  }
}))
vi.mock('../../../services/config-inventory.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/config-inventory.js')>()),
  // dev's live rows: one the file never mentions, one the file changes
  buildConfigSnapshot: async () => ({
    format: 1,
    generated_at: '2026-11-13T00:00:00.000Z',
    instance: { version: '0.3.157', environment: 'development', database: 'EFP_Development' },
    classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
    tables: {
      nivaro_saved_views: {
        '1': { hash: 'a', data: { id: 1 } },
        '48': { hash: 'z', data: { id: 48, name: 'Dev row' } }
      }
    },
    errors: {}
  })
}))
vi.mock('../../../services/config-snapshots.js', () => ({
  takeConfigSnapshot: async () => ({ id: 1 }),
  listConfigSnapshots: async () => [],
  diffSinceSnapshot: async () => null,
  snapshotAtOrBefore: async () => null,
  loadConfigSnapshot: async () => ({
    format: 1,
    tables: { nivaro_saved_views: {}, nivaro_extension_settings: {} }
  })
}))
vi.mock('../../../services/config-drift/store.js', () => ({
  driftTrackingHere: async () => h.tracking,
  forgetDriftReport: () => {},
  checkOverwrite: async (target: unknown, opts: Record<string, unknown>) => {
    h.checks.push({ target, opts })
    return h.check
  },
  getDriftReport: async () => ({ active: true, items: [] }),
  buildCopyBundle: async () => ({
    format: 1,
    generated_at: '2026-11-13T00:00:00.000Z',
    instance: { database: 'EFP' },
    tables: { nivaro_saved_views: { '48': { hash: 'x', data: { id: 48 } } } }
  }),
  markItems: async (ids: string[], opts: Record<string, unknown>) => {
    h.marks.push({ ids, opts })
    return { marked: ids.length, missing: [] }
  },
  saveDriftSettings: async (p: Record<string, unknown>) => p
}))
vi.mock('../../../services/config-restore.js', async () => {
  class RestoreError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly code: string,
      readonly extra: Record<string, unknown> = {}
    ) {
      super(message)
    }
  }
  return {
    RestoreError,
    RESTORE_EXCLUDED: { nivaro_users: 'People accounts' },
    previewRestore: async (id: number) => ({
      snapshot_id: id,
      plan_hash: 'a'.repeat(64),
      tables: [],
      warnings: []
    }),
    applyRestore: async (id: number) => {
      h.restores++
      return { snapshot_id: id, pre_restore_id: 2, tables: [], totals: {} }
    },
    applyUploadedTable: async (_s: unknown, table: string, opts: { mode: string }) => {
      if (opts.mode === 'apply') h.uploads++
      return { table, inserts: 0, updates: 1, plan_hash: 'c'.repeat(64) }
    }
  }
})

import { configDiffRoutes } from '../../../routes/config-diff.js'
import { configDriftRoutes } from '../../../routes/config-drift.js'

async function app() {
  const a = Fastify()
  await a.register(configDiffRoutes)
  await a.register(configDriftRoutes)
  return a
}

const admin = { 'x-test-user': 'admin' }
const view = {
  id: 'nivaro_saved_views:48',
  table: 'nivaro_saved_views',
  key: '48',
  label: 'Active types (deployment_part_types)',
  kind: 'added',
  at: '2026-11-13T14:00:00.000Z',
  who: 'Rob Lee'
}
const snapshot = {
  format: 1,
  generated_at: '2026-11-13T00:00:00.000Z',
  instance: { version: '0.3.157', environment: 'development', database: 'EFP_Development' },
  classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
  tables: { nivaro_saved_views: { '48': { hash: 'y', data: { id: 48, name: 'Other' } } } },
  errors: {}
}

beforeEach(() => {
  h.tracking = true
  h.check = { active: true, refuse: false, items: [], lines: [] }
  h.checks.length = 0
  h.uploads = 0
  h.restores = 0
  h.marks.length = 0
  h.activity.length = 0
})

describe('POST /config-diff/apply — the uploaded-table apply path', () => {
  it('previews with the changes it would overwrite, scoped to the table and keys, no deletes', async () => {
    h.check = { active: true, refuse: false, items: [view], lines: ['Active types — added here'] }
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/apply',
      headers: admin,
      payload: { snapshot, table: 'nivaro_saved_views', keys: ['48'], mode: 'preview' }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.prod_only_changes).toEqual([view])
    expect(h.checks[0].opts).toEqual({
      tables: ['nivaro_saved_views'],
      deletes: false,
      keys: ['48']
    })
  })

  it('warn-only by default: the apply goes through', async () => {
    h.check = { active: true, refuse: false, items: [view], lines: ['x'] }
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/apply',
      headers: admin,
      payload: { snapshot, table: 'nivaro_saved_views', mode: 'apply', plan_hash: 'c'.repeat(64) }
    })
    expect(r.statusCode).toBe(200)
    expect(h.uploads).toBe(1)
  })

  it('refuses (409 PROD_ONLY_CHANGES) when the setting says so, unless overridden', async () => {
    h.check = { active: true, refuse: true, items: [view], lines: ['x'] }
    const a = await app()
    const payload = {
      snapshot,
      table: 'nivaro_saved_views',
      mode: 'apply',
      plan_hash: 'c'.repeat(64)
    }
    const r = await a.inject({ method: 'POST', url: '/config-diff/apply', headers: admin, payload })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ code: 'PROD_ONLY_CHANGES', items: [view] })
    expect(h.uploads).toBe(0)

    const forced = await a.inject({
      method: 'POST',
      url: '/config-diff/apply',
      headers: admin,
      payload: { ...payload, overwrite_prod_changes: true }
    })
    expect(forced.statusCode).toBe(200)
    expect(h.uploads).toBe(1)
  })

  it('does not check at all where nothing is tracked', async () => {
    h.tracking = false
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/apply',
      headers: admin,
      payload: { snapshot, table: 'nivaro_saved_views', mode: 'preview' }
    })
    expect(r.statusCode).toBe(200)
    expect(h.checks).toEqual([])
    expect(r.json().data.prod_only_changes).toEqual([])
  })
})

describe('POST /config-diff/history/:id/restore', () => {
  it('a restore preview warns (restores delete, so deletes: true)', async () => {
    h.check = { active: true, refuse: true, items: [view], lines: ['Active types — added here'] }
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      headers: admin,
      payload: { mode: 'preview' }
    })
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.prod_only_changes).toEqual([view])
    expect(d.warnings[0]).toMatch(/1 change made here, not from promotion, would be overwritten/)
    expect(h.checks[0].opts).toMatchObject({ deletes: true })
  })

  it('a restore apply is refused under the setting', async () => {
    h.check = { active: true, refuse: true, items: [view], lines: ['x'] }
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      headers: admin,
      payload: { mode: 'apply', plan_hash: 'a'.repeat(64) }
    })
    expect(r.statusCode).toBe(409)
    expect(h.restores).toBe(0)
  })
})

describe('POST /config-diff/history — the promote chain stores the baseline', () => {
  it("accepts trigger 'promote'", async () => {
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/history',
      headers: admin,
      payload: { trigger: 'promote', note: 'from EFP_Development' }
    })
    expect(r.statusCode).toBe(200)
  })
})

describe('compare of a "Copy to dev" file', () => {
  it('does not list every other row as only here, and says what it is', async () => {
    const a = await app()
    const bundle = {
      ...snapshot,
      instance: { ...snapshot.instance, environment: 'production', database: 'EFP' },
      bundle: { kind: 'changed-here', items: [view], removed: [], baseline_snapshot_id: 9 }
    }
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/compare',
      headers: admin,
      payload: { snapshot: bundle }
    })
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.tables).toHaveLength(1)
    expect(d.tables[0].added).toEqual([])
    expect(d.tables[0].changed.map((c: { key: string }) => c.key)).toEqual(['48'])
    expect(d.totals).toMatchObject({ added: 0, changed: 1 })
    expect(d.bundle.items).toEqual([view])

    // a whole snapshot still lists dev's other row
    const whole = await a.inject({
      method: 'POST',
      url: '/config-diff/compare',
      headers: admin,
      payload: { snapshot }
    })
    expect(whole.json().data.tables[0].added).toEqual(['1'])
  })
})

describe('/config-drift routes', () => {
  it('mark needs ids and a note (reopen needs none)', async () => {
    const a = await app()
    const noNote = await a.inject({
      method: 'POST',
      url: '/config-drift/mark',
      headers: admin,
      payload: { ids: [view.id] }
    })
    expect(noNote.statusCode).toBe(400)
    const bad = await a.inject({
      method: 'POST',
      url: '/config-drift/mark',
      headers: admin,
      payload: { ids: ['DROP TABLE'], note: 'x' }
    })
    expect(bad.statusCode).toBe(400)
    const ok = await a.inject({
      method: 'POST',
      url: '/config-drift/mark',
      headers: admin,
      payload: { ids: [view.id], note: 'Agreed with ops' }
    })
    expect(ok.statusCode).toBe(200)
    const reopen = await a.inject({
      method: 'POST',
      url: '/config-drift/mark',
      headers: admin,
      payload: { ids: [view.id], reopen: true }
    })
    expect(reopen.statusCode).toBe(200)
    expect(h.marks.map((m) => m.opts.reopen)).toEqual([false, true])
  })

  it('the guard: what a promotion over these tables would overwrite (deletes: true)', async () => {
    h.check = { active: true, refuse: true, items: [view], lines: ['x'] }
    const a = await app()
    const r = await a.inject({
      method: 'GET',
      url: '/config-drift/guard?tables=nivaro_saved_views,nivaro_extension_settings',
      headers: admin
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ refuse: true, items: [view] })
    expect(h.checks[0]).toEqual({
      target: null,
      opts: { tables: ['nivaro_saved_views', 'nivaro_extension_settings'], deletes: true }
    })
    const bad = await a.inject({
      method: 'GET',
      url: '/config-drift/guard?tables=users;drop',
      headers: admin
    })
    expect(bad.statusCode).toBe(400)
  })

  it('the bundle downloads as an attachment and is logged as an export', async () => {
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-drift/bundle',
      headers: admin,
      payload: { ids: [view.id] }
    })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-disposition']).toMatch(/nivaro-changed-here-EFP/)
    expect(h.activity[0]).toMatchObject({ action: 'config-snapshot-export' })
  })

  it('settings validate', async () => {
    const a = await app()
    const bad = await a.inject({
      method: 'PUT',
      url: '/config-drift/settings',
      headers: admin,
      payload: { refuse_overwrite: 'yes' }
    })
    expect(bad.statusCode).toBe(400)
    const ok = await a.inject({
      method: 'PUT',
      url: '/config-drift/settings',
      headers: admin,
      payload: { refuse_overwrite: true, baseline_snapshot_id: 12 }
    })
    expect(ok.json().data).toEqual({ refuse_overwrite: true, baseline_snapshot_id: 12 })
  })

  it('is admin-only', async () => {
    const a = await app()
    const r = await a.inject({ method: 'GET', url: '/config-drift' })
    expect(r.statusCode).toBe(403)
  })
})
