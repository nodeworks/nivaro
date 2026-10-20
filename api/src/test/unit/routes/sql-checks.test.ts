import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const currentUser: { id: string; isAdmin: boolean } = { id: 'user-admin', isAdmin: true }

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: currentUser.id, email: 'a@x' }
    if (!currentUser.isAdmin) {
      const err = new Error('Forbidden') as Error & { statusCode: number }
      err.statusCode = 403
      throw err
    }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

// a chainable knex stand-in: every builder call returns the chain; awaiting it / first() answer `state`
const state: { first: unknown; rows: unknown[]; inserted: unknown[]; updated: unknown[] } = {
  first: undefined,
  rows: [],
  inserted: [],
  updated: []
}
function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const m of [
    'where',
    'whereIn',
    'orderBy',
    'orderByRaw',
    'limit',
    'offset',
    'select',
    'count',
    'groupBy'
  ])
    c[m] = vi.fn(() => c)
  c.first = vi.fn(async () => state.first)
  c.insert = vi.fn((row: unknown) => {
    state.inserted.push(row)
    return { returning: async () => [{ id: 7 }] }
  })
  c.update = vi.fn(async (row: unknown) => {
    state.updated.push(row)
    return 1
  })
  // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited as a thenable
  c.then = (res: (v: unknown) => unknown) => Promise.resolve(state.rows).then(res)
  return c
}
vi.mock('../../../db/index.js', () => {
  const db = vi.fn(() => chain()) as unknown as Record<string, unknown>
  db.schema = { hasTable: vi.fn(async () => true) }
  db.raw = vi.fn()
  return { db }
})
vi.mock('../../../services/sql-checks/run.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  return {
    ...m,
    runSqlChecks: vi.fn(),
    isSqlChecksRunning: vi.fn(() => false),
    sqlChecksInFlight: vi.fn(async () => false)
  }
})
vi.mock('../../../services/sql-checks/settings.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  return {
    ...m,
    readSqlCheckSettings: vi.fn(async () => m.SQL_CHECK_DEFAULTS),
    readStoredSqlCheckSettings: vi.fn(async () => ({})),
    bustSqlCheckSettings: vi.fn()
  }
})

vi.mock('../../../services/sql-checks/apply.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  return {
    ...m,
    proposalFor: vi.fn(async (id: number) => ({ finding_id: id, proposable: true })),
    applyFix: vi.fn(async () => ({ fix_id: 1, applied: true, rolled_back: false, deployed: true })),
    revertFix: vi.fn(async () => ({ reverted: true }))
  }
})

import { sqlChecksRoutes } from '../../../routes/sql-checks.js'
import { applyFix, FixError, revertFix } from '../../../services/sql-checks/apply.js'
import { runSqlChecks, sqlChecksInFlight } from '../../../services/sql-checks/run.js'

async function build() {
  const app = Fastify()
  await app.register(sqlChecksRoutes, { prefix: '/sql-checks' })
  return app
}

beforeEach(() => {
  currentUser.isAdmin = true
  state.first = undefined
  state.rows = []
  state.inserted = []
  state.updated = []
  vi.mocked(runSqlChecks).mockReset()
  vi.mocked(sqlChecksInFlight).mockResolvedValue(false)
})

describe('SQL checks routes (#2562)', () => {
  it('are admin only', async () => {
    currentUser.isAdmin = false
    const app = await build()
    for (const [method, url] of [
      ['GET', '/sql-checks/summary'],
      ['GET', '/sql-checks/findings'],
      ['POST', '/sql-checks/run'],
      ['POST', '/sql-checks/fixes'],
      ['PATCH', '/sql-checks/settings'],
      ['GET', '/sql-checks/findings/1/proposal'],
      ['POST', '/sql-checks/findings/1/apply'],
      ['POST', '/sql-checks/fixes/1/revert']
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
  })

  it('validates settings and names every bad key', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/sql-checks/settings',
      payload: { row_cap: 1, enabled: 'yes' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().problems).toHaveLength(2)
    const ok = await app.inject({
      method: 'PATCH',
      url: '/sql-checks/settings',
      payload: { enabled: true }
    })
    expect(ok.statusCode).toBe(200)
    expect(
      JSON.parse(String((state.updated[0] as { sql_checks: string }).sql_checks)).enabled
    ).toBe(true)
  })

  it('refuses a run while one is in flight; starts one otherwise', async () => {
    const app = await build()
    vi.mocked(sqlChecksInFlight).mockResolvedValueOnce(true)
    expect((await app.inject({ method: 'POST', url: '/sql-checks/run' })).statusCode).toBe(409)
    vi.mocked(runSqlChecks).mockImplementation(async (o) => {
      o.onStarted?.(42)
      return new Promise(() => {}) // still running
    })
    const res = await app.inject({ method: 'POST', url: '/sql-checks/run' })
    expect(res.statusCode).toBe(202)
    expect(res.json().data.run_id).toBe(42)
  })

  it('validates filters', async () => {
    const app = await build()
    expect((await app.inject({ url: '/sql-checks/findings?severity=bad' })).statusCode).toBe(400)
    expect((await app.inject({ url: '/sql-checks/findings?check=nope' })).statusCode).toBe(400)
    expect(
      (await app.inject({ url: '/sql-checks/findings?status=open,accepted' })).statusCode
    ).toBe(200)
  })

  it('accepting a finding needs a note; only accepted ones reopen', async () => {
    const app = await build()
    state.first = { status: 'open', message: 'm' }
    const noNote = await app.inject({
      method: 'PATCH',
      url: '/sql-checks/findings/1',
      payload: { status: 'accepted' }
    })
    expect(noNote.statusCode).toBe(400)
    const reopen = await app.inject({
      method: 'PATCH',
      url: '/sql-checks/findings/1',
      payload: { status: 'open' }
    })
    expect(reopen.statusCode).toBe(409)
    const ok = await app.inject({
      method: 'PATCH',
      url: '/sql-checks/findings/1',
      payload: { status: 'accepted', note: 'cleared on purpose' }
    })
    expect(ok.statusCode).toBe(200)
    expect(state.updated[0]).toMatchObject({
      status: 'accepted',
      accepted_note: 'cleared on purpose'
    })
  })

  it('records a fix from a script and validates it', async () => {
    const app = await build()
    expect(
      (await app.inject({ method: 'POST', url: '/sql-checks/fixes', payload: { action: 'nuke' } }))
        .statusCode
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/sql-checks/fixes',
          payload: { action: 'cleanup', rows_affected: -1 }
        })
      ).statusCode
    ).toBe(400)
    const res = await app.inject({
      method: 'POST',
      url: '/sql-checks/fixes',
      payload: {
        action: 'cleanup',
        check_key: 'merge-null-key',
        target_table: 'workflows_files',
        rows_affected: 273657,
        backup_table: 'zz_backup_workflows_files_20261019',
        detail: { kept: 'newest' },
        run_by: 'efp-ops fix-null-key-copies'
      }
    })
    expect(res.statusCode).toBe(201)
    expect(state.inserted[0]).toMatchObject({
      action: 'cleanup',
      rows_affected: 273657,
      run_by: 'efp-ops fix-null-key-copies'
    })
  })

  it('applies a fix only with the preview hash, and maps fix errors to their status', async () => {
    const app = await build()
    const bad = await app.inject({
      method: 'POST',
      url: '/sql-checks/findings/5/apply',
      payload: { new_definition_hash: 'nope' }
    })
    expect(bad.statusCode).toBe(400)
    expect(applyFix).not.toHaveBeenCalled()
    const hash = 'a'.repeat(64)
    const ok = await app.inject({
      method: 'POST',
      url: '/sql-checks/findings/5/apply',
      payload: { new_definition_hash: hash, confirm_risky: true }
    })
    expect(ok.statusCode).toBe(200)
    expect(applyFix).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: 5, newDefinitionHash: hash, confirmRisky: true })
    )
    vi.mocked(revertFix).mockRejectedValueOnce(new FixError(409, 'changed since'))
    const conflict = await app.inject({ method: 'POST', url: '/sql-checks/fixes/3/revert' })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ error: 'changed since' })
  })
})
