import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Ruling P5-10 item 5 (review I5): a restart leaves job runs and conformance runs marked
// 'running'. Self-hosted closes them at boot; a shared deployment now runs the same two passes
// once per app, inside that app, best-effort (one app failing never stops the others).

const state = vi.hoisted(() => ({
  writes: [] as Array<{ tenant: string | null; table: string; op: string }>,
  failIn: null as string | null
}))

vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const db = (table: string) => {
    const tenant = tc.getTenantId() || null
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNotIn', 'orWhereNull', 'limit', 'orderBy'])
      b[m] = () => b
    b.modify = (fn: (q: unknown) => void) => {
      fn(b)
      return b
    }
    b.select = async () => {
      state.writes.push({ tenant, table, op: 'select' })
      return table === 'nivaro_job_runs' ? [{ id: 1, kind: 'cron', job_id: 'outbox-worker' }] : []
    }
    b.update = async () => {
      if (state.failIn && state.failIn === tenant) throw new Error('db down')
      state.writes.push({ tenant, table, op: 'update' })
      return 1
    }
    return b
  }
  return { db, _backgroundDb: null, _staticDb: null }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => false }))
vi.mock('../../../services/error-tracking.js', () => ({ trackError: vi.fn(async () => {}) }))
vi.mock('../../../services/system-issues.js', () => ({ restartImpactIssue: () => ({}) }))

const { runRestartCleanups, runRestartCleanupsPerApp } = await import(
  '../../../services/restart-cleanups.js'
)
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord

const tenant = (id: string): TenantRecord => ({
  id,
  slug: id.toLowerCase(),
  name: `App ${id}`,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://u@127.0.0.1:1/app_${id.toLowerCase()}`,
  poolMax: 1,
  hostnames: []
})

const saved = { ...process.env }
beforeEach(() => {
  state.writes.length = 0
  state.failIn = null
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
  const list = [tenant('A'), tenant('B')]
  setTenantRegistryForTests({
    source: 'hub',
    resolve: async () => null,
    listActive: async () => list,
    status: () => ({ source: 'hub', count: 2, loadedAt: null, stale: false, lastError: null })
  })
})
afterEach(() => {
  setTenantRegistryForTests(null)
  process.env = { ...saved }
})

const updates = (t: string | null) =>
  state.writes.filter((w) => w.tenant === t && w.op === 'update').map((w) => w.table)

describe('restart clean-ups', () => {
  it('self-hosted: one pass closes stranded job runs and conformance runs', async () => {
    await runRestartCleanups()
    expect(updates(null)).toEqual(['nivaro_job_runs', 'nivaro_conformance_runs'])
  })

  it('shared: the same passes run once inside every app', async () => {
    const r = await runRestartCleanupsPerApp()
    expect(r.ran.sort()).toEqual(['A', 'B'])
    expect(updates('A')).toEqual(['nivaro_job_runs', 'nivaro_conformance_runs'])
    expect(updates('B')).toEqual(['nivaro_job_runs', 'nivaro_conformance_runs'])
    expect(updates(null)).toEqual([])
  })

  it('shared: an app whose database fails never stops the others or throws', async () => {
    state.failIn = 'A'
    const r = await runRestartCleanupsPerApp()
    expect(r.ran.sort()).toEqual(['A', 'B'])
    expect(updates('B')).toEqual(['nivaro_job_runs', 'nivaro_conformance_runs'])
  })
})
