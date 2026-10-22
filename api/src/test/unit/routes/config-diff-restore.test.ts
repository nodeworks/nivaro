import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #2803 — the deploy script's contract on POST /config-diff/history and the restore route's
 * preview/apply binding, with the snapshot + restore services stubbed.
 */

const h = vi.hoisted(() => ({
  taken: [] as Array<{ trigger: string; opts: Record<string, unknown> }>,
  activity: [] as Array<Record<string, unknown>>,
  previews: [] as Array<{ id: number; scope: unknown; read: boolean }>,
  applies: [] as Array<{ id: number; opts: Record<string, unknown> }>,
  uploads: [] as Array<{
    snap: { tables: Record<string, Record<string, { data: Record<string, unknown> }>> }
    table: string
    opts: Record<string, unknown>
  }>,
  applyError: null as Error | null
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
vi.mock('../../../services/config-snapshots.js', () => ({
  takeConfigSnapshot: async (trigger: string, opts: Record<string, unknown>) => {
    h.taken.push({ trigger, opts })
    return { id: 77, trigger, tables: 3, rows: 9, note: opts.note ?? null }
  },
  listConfigSnapshots: async () => [],
  diffSinceSnapshot: async () => null,
  snapshotAtOrBefore: async () => null
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
    RestoreOpError: class extends Error {},
    RESTORE_EXCLUDED: { nivaro_users: 'People accounts', nivaro_sso_providers: 'credentials' },
    previewRestore: async (id: number, scope: unknown, allowCascade: unknown) => {
      h.previews.push({ id, scope, read: false, allowCascade } as never)
      return { snapshot_id: id, plan_hash: 'a'.repeat(64), tables: [] }
    },
    applyRestore: async (id: number, opts: Record<string, unknown>) => {
      if (h.applyError) throw h.applyError
      h.applies.push({ id, opts })
      return { snapshot_id: id, pre_restore_id: 78, tables: [], totals: {} }
    },
    applyUploadedTable: async (
      snap: (typeof h.uploads)[number]['snap'],
      table: string,
      opts: Record<string, unknown>
    ) => {
      h.uploads.push({ snap, table, opts })
      return { table, inserts: 1, updates: 0, plan_hash: 'c'.repeat(64) }
    }
  }
})

import { configDiffRoutes } from '../../../routes/config-diff.js'
import { RestoreError } from '../../../services/config-restore.js'

async function app() {
  const a = Fastify()
  // The config-write hook's read marker, as routes/index.ts would see it.
  a.addHook('onSend', async (req, _reply, payload) => {
    const r = req as unknown as { nvrConfigRead?: boolean }
    const last = h.previews[h.previews.length - 1]
    if (r.nvrConfigRead && last) last.read = true
    return payload
  })
  await a.register(configDiffRoutes)
  return a
}

const admin = { 'x-test-user': 'admin' }

beforeEach(() => {
  h.taken.length = 0
  h.activity.length = 0
  h.previews.length = 0
  h.applies.length = 0
  h.uploads.length = 0
  h.applyError = null
})

describe('POST /config-diff/history', () => {
  it('stores a manual snapshot by default', async () => {
    const a = await app()
    const r = await a.inject({ method: 'POST', url: '/config-diff/history', headers: admin })
    expect(r.statusCode).toBe(200)
    expect(h.taken).toEqual([
      { trigger: 'manual', opts: { userId: 'admin-1', note: null, targetVersion: null } }
    ])
    // A note-less snapshot is logged by the route, keyed by the snapshot id.
    expect(h.activity[0]).toMatchObject({
      action: 'config-snapshot-store',
      collection: 'nivaro_config_snapshots',
      item: '77'
    })
  })

  it("accepts the deploy script's { trigger: 'pre-deploy', version }", async () => {
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/history',
      headers: admin,
      payload: { trigger: 'pre-deploy', version: '0.3.5' }
    })
    expect(r.statusCode).toBe(200)
    expect(h.taken[0]).toEqual({
      trigger: 'pre-deploy',
      opts: { userId: 'admin-1', note: 'Before deploying 0.3.5', targetVersion: '0.3.5' }
    })
    expect(r.json().data.id).toBe(77)
  })

  it('refuses the triggers only the server takes, and junk versions', async () => {
    const a = await app()
    for (const trigger of ['cron', 'pre-migration', 'pre-restore', 'nightly', 5]) {
      const r = await a.inject({
        method: 'POST',
        url: '/config-diff/history',
        headers: admin,
        payload: { trigger }
      })
      expect(r.statusCode).toBe(400)
    }
    const bad = await a.inject({
      method: 'POST',
      url: '/config-diff/history',
      headers: admin,
      payload: { trigger: 'pre-deploy', version: '1.0; DROP TABLE x' }
    })
    expect(bad.statusCode).toBe(400)
    expect(h.taken).toEqual([])
  })

  it('is admin-only', async () => {
    const a = await app()
    const r = await a.inject({ method: 'POST', url: '/config-diff/history' })
    expect(r.statusCode).toBe(403)
    const r2 = await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      payload: { mode: 'preview' }
    })
    expect(r2.statusCode).toBe(403)
  })
})

describe('POST /config-diff/history/:id/restore', () => {
  it('previews (marked read-only) with an optional table scope', async () => {
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      headers: admin,
      payload: { mode: 'preview', tables: ['nivaro_fields'] }
    })
    expect(r.statusCode).toBe(200)
    expect(h.previews[0]).toMatchObject({ id: 5, scope: ['nivaro_fields'], read: true })
  })

  it('needs a mode, a plan hash for apply, and nivaro_* table names', async () => {
    const a = await app()
    const noMode = await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      headers: admin,
      payload: {}
    })
    expect(noMode.statusCode).toBe(400)
    const noHash = await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      headers: admin,
      payload: { mode: 'apply' }
    })
    expect(noHash.statusCode).toBe(400)
    const badTables = await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      headers: admin,
      payload: { mode: 'preview', tables: ['orders'] }
    })
    expect(badTables.statusCode).toBe(400)
    expect(h.applies).toEqual([])
  })

  it('applies with the preview hash and returns the undo point', async () => {
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      headers: admin,
      payload: { mode: 'apply', plan_hash: 'a'.repeat(64) }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.pre_restore_id).toBe(78)
    expect(h.applies[0]).toMatchObject({
      id: 5,
      opts: { planHash: 'a'.repeat(64), userId: 'admin-1' }
    })
  })

  it('answers 409 STALE with the fresh preview when live config moved', async () => {
    h.applyError = new RestoreError(409, 'Configuration changed since the preview', 'STALE', {
      preview: { plan_hash: 'b'.repeat(64) }
    })
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      headers: admin,
      payload: { mode: 'apply', plan_hash: 'a'.repeat(64) }
    })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ code: 'STALE', preview: { plan_hash: 'b'.repeat(64) } })
  })
})

describe('POST /config-diff/apply (uploaded snapshot)', () => {
  const snapshot = {
    format: 1,
    generated_at: '2026-10-07T08:40:00.000Z',
    instance: { version: '0.2.20', environment: 'production', database: 'P' },
    classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
    tables: {
      nivaro_settings: {
        '1': { hash: 'x', data: { id: 1, project_name: 'EFP', directory_password: 'file-secret' } }
      }
    },
    errors: {}
  }

  it('strips secret columns from the file before the engine sees it', async () => {
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/config-diff/apply',
      headers: admin,
      payload: { snapshot, table: 'nivaro_settings', mode: 'preview' }
    })
    expect(r.statusCode).toBe(200)
    expect(h.uploads[0].snap.tables.nivaro_settings['1'].data).toEqual({
      id: 1,
      project_name: 'EFP'
    })
    expect(JSON.stringify(r.json())).not.toContain('file-secret')
  })

  it('needs the preview hash to apply, and passes it on', async () => {
    const a = await app()
    const missing = await a.inject({
      method: 'POST',
      url: '/config-diff/apply',
      headers: admin,
      payload: { snapshot, table: 'nivaro_settings', mode: 'apply' }
    })
    expect(missing.statusCode).toBe(400)
    const ok = await a.inject({
      method: 'POST',
      url: '/config-diff/apply',
      headers: admin,
      payload: { snapshot, table: 'nivaro_settings', mode: 'apply', plan_hash: 'c'.repeat(64) }
    })
    expect(ok.statusCode).toBe(200)
    expect(h.uploads.at(-1)?.opts).toMatchObject({ mode: 'apply', planHash: 'c'.repeat(64) })
  })
})

describe('allow_cascade', () => {
  it('reaches the preview and the apply', async () => {
    const a = await app()
    await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      headers: admin,
      payload: { mode: 'preview', allow_cascade: true }
    })
    expect((h.previews[0] as unknown as { allowCascade: unknown }).allowCascade).toBe(true)
    await a.inject({
      method: 'POST',
      url: '/config-diff/history/5/restore',
      headers: admin,
      payload: { mode: 'apply', plan_hash: 'a'.repeat(64), allow_cascade: true }
    })
    expect(h.applies[0].opts).toMatchObject({ allowCascade: true })
  })
})
