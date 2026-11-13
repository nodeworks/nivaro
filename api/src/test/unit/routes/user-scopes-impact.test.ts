import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb } from '../../fake-sql.js'

// POST /api/user-scopes/:userId/impact — the blast-radius preview behind
// "Apply restriction" on a person's Scopes card. Rob 2026-11-13: slow. The
// collections now run side by side under a time budget; the answer keeps its
// shape (plus `label` per row and `partial`).

const USER = 'a0000000-0000-0000-0000-00000000000a'

vi.mock('../../../middleware/authenticate.js', () => {
  const who = (req: { headers: Record<string, string | undefined>; user?: unknown }) => {
    const w = req.headers['x-test-user']
    if (!w) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id: 'f0000000-0000-0000-0000-00000000000f' }
    return w
  }
  return {
    requireAuth: vi.fn(async (req: never) => {
      who(req)
    }),
    requireAdmin: vi.fn(async (req: never) => {
      if (who(req) !== 'admin') throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    })
  }
})

const h = vi.hoisted(() => ({
  // table → how the fake bounded runner answers its statements
  behaviour: {} as Record<string, 'ok' | 'fail' | 'cancel' | 'slow'>,
  statements: [] as string[]
}))

vi.mock('../../../db/index.js', async () => {
  const db = makeFakeDb((q) => {
    if (q.method === 'raw' && q.sql.includes('sys.tables'))
      return [
        { table_name: 'invoices', rows: 900 },
        { table_name: 'line_items', rows: 800 },
        { table_name: 'workflows', rows: 100 },
        { table_name: 'units', rows: 50 },
        { table_name: 'not_registered', rows: 5000 }
      ]
    if (q.sql.includes('nivaro_collections'))
      return [
        { collection: 'workflows', display_name: 'Workflows', plural: 'Workflows' },
        { collection: 'invoices', display_name: 'Invoices', plural: null },
        { collection: 'line_items', display_name: null, plural: null },
        { collection: 'units', display_name: 'Units', plural: 'Units' }
      ]
    if (q.sql.includes('nivaro_workflow_bindings')) return [{ collection: 'workflows' }]
    return []
  })
  return { db, resolveDb: () => db }
})
vi.mock('../../../db/config-epoch.js', () => ({ runPersonalConfigWrite: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/queues.js', () => ({
  getLabels: vi.fn(async (m: Map<string, Set<string>>) => {
    const out: Record<string, string> = {}
    for (const [c, ids] of m) for (const id of ids) out[`${c}:${id}`] = `${c.toUpperCase()}-${id}`
    return out
  })
}))
vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: (_who: unknown, fn: () => Promise<unknown>) => fn(),
  clientGoneSignal: () => new AbortController().signal
}))
vi.mock('../../../services/user-scopes.js', async (orig) => {
  const real = await orig<typeof import('../../../services/user-scopes.js')>()
  return {
    ...real,
    listScopeDimensions: vi.fn(async () => [
      { id: 2, name: 'region', label: 'Region', target_collection: 'regions', display_field: null }
    ]),
    getUserScopes: vi.fn(async () => [
      { id: 1, user: USER, dimension: 'region', mode: 'restrict', values: [1, 2] }
    ]),
    // units has no route to regions; the rest scope through their own FK.
    scopeHopsFor: vi.fn(async (_d: unknown, c: string) =>
      c === 'units' ? null : [{ kind: 'm2o', from: c, to: 'regions', fk: 'region' }]
    )
  }
})
vi.mock('../../../services/bounded-sql.js', async (orig) => {
  const real = await orig<typeof import('../../../services/bounded-sql.js')>()
  return {
    ...real,
    boundedRaw: vi.fn(async (sql: string, bindings: unknown[]) => {
      h.statements.push(sql)
      const table = /from \[(\w+)\]/.exec(sql)?.[1] ?? ''
      const how = h.behaviour[table] ?? 'ok'
      if (how === 'fail') throw new Error('Invalid column name region')
      if (how === 'cancel') throw new real.StatementCancelled('timeout')
      if (how === 'slow') await new Promise((r) => setTimeout(r, 30))
      if (sql.includes('order by')) return [{ id: 9 }, { id: 8 }]
      const ids = bindings.filter((b) => typeof b === 'number')
      // gained = inside [1,2,3] and not [1,2] → 4; lost = inside [1,2] and not [1,2,3] → 0
      if (sql.includes(' not ')) return [{ n: sql.includes('in (?, ?, ?)) and not') ? 4 : 0 }]
      return [{ n: ids.length * 10 }] // current [1,2] → 20, proposed [1,2,3] → 30
    })
  }
})

import { userScopesRoutes } from '../../../routes/user-scopes.js'
import { boundedRaw } from '../../../services/bounded-sql.js'
import { planImpact, runCandidates, sampleStatement } from '../../../services/user-scope-impact.js'

async function call(body: unknown, who = 'admin') {
  const app = Fastify()
  await app.register(userScopesRoutes)
  const res = await app.inject({
    method: 'POST',
    url: `/user-scopes/${USER}/impact`,
    headers: { 'x-test-user': who },
    payload: body as Record<string, unknown>
  })
  await app.close()
  return res
}

afterEach(() => {
  h.behaviour = {}
  h.statements = []
  vi.mocked(boundedRaw).mockClear()
})

describe('POST /user-scopes/:userId/impact', () => {
  it('administrators only; an unknown dimension is a 404', async () => {
    expect((await call({ dimension: 'region', values: [1] }, 'member')).statusCode).toBe(403)
    expect((await call({ dimension: 'nope', values: [1] })).statusCode).toBe(404)
  })

  it('answers the same shape: per collection current → proposed, gained / lost with samples', async () => {
    const res = await call({ dimension: 'region', values: [1, 2, 3] })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(Object.keys(data).sort()).toEqual(
      ['current_values', 'dimension', 'impact', 'partial', 'proposed_values'].sort()
    )
    expect(data.dimension).toBe('region')
    expect(data.current_values).toEqual([1, 2])
    expect(data.proposed_values).toEqual([1, 2, 3])
    // workflows (bound) leads, then the biggest registered tables; units has no route.
    expect(data.impact.map((r: { collection: string }) => r.collection)).toEqual([
      'workflows',
      'invoices',
      'line_items'
    ])
    expect(data.impact[0]).toEqual({
      collection: 'workflows',
      label: 'Workflows',
      total: 100,
      current: 20,
      proposed: 30,
      gained: 4,
      lost: 0,
      gained_sample: [
        { id: '9', label: 'WORKFLOWS-9' },
        { id: '8', label: 'WORKFLOWS-8' }
      ],
      lost_sample: []
    })
    // A collection without a display name gets its table name in words.
    expect(data.impact[2].label).toBe('Line Items')
    expect(data.partial).toEqual([])
  })

  it('a collection whose statements fail is skipped; one the budget cut is named', async () => {
    h.behaviour = { invoices: 'fail', line_items: 'cancel' }
    const { data } = (await call({ dimension: 'region', values: [1, 2, 3] })).json()
    expect(data.impact.map((r: { collection: string }) => r.collection)).toEqual(['workflows'])
    expect(data.partial).toEqual([{ collection: 'line_items', label: 'Line Items' }])
  })

  it('removing the restriction counts the whole table as visible and only gains', async () => {
    const { data } = (await call({ dimension: 'region', values: [] })).json()
    expect(data.impact[0]).toMatchObject({
      collection: 'workflows',
      current: 20,
      proposed: 100,
      lost: 0,
      lost_sample: []
    })
  })
})

describe('planImpact', () => {
  it('needs no statement for an empty allowance and keeps the one-sided moves', () => {
    expect(planImpact([1], [1, 2])).toEqual({
      current: [1],
      proposed: [1, 2],
      gained: { inside: [1, 2], outside: [1] },
      lost: { inside: [1], outside: [1, 2] }
    })
    // to "everything": gains what [1] hid, loses nothing
    expect(planImpact([1], [])).toEqual({
      current: [1],
      proposed: null,
      gained: { inside: [], outside: [1] },
      lost: null
    })
    // from "everything": gains nothing, loses what [2] hides
    expect(planImpact([], [2])).toEqual({
      current: null,
      proposed: [2],
      gained: null,
      lost: { inside: [], outside: [2] }
    })
    expect(planImpact([], [])).toEqual({ current: null, proposed: null, gained: null, lost: null })
  })
})

describe('sampleStatement', () => {
  it('newest five ids, without the row goal on SQL Server', () => {
    const s = sampleStatement(
      'workflows',
      [{ kind: 'm2o', from: 'workflows', to: 'regions', fk: 'region' }],
      {
        inside: [1],
        outside: [2]
      }
    )
    expect(s.sql).toMatch(/^select top \(\?\) \[id\] from \[workflows\]/)
    expect(s.sql).toContain('order by [id] desc')
    expect(s.sql).toMatch(/OPTION \(USE HINT\('DISABLE_OPTIMIZER_ROWGOAL'\)\)$/)
  })
})

describe('runCandidates', () => {
  const ok = (v: number) => ({ kind: 'ok' as const, value: v })

  it('returns the first `limit` successes in candidate order, whatever finishes first', async () => {
    const delays = [40, 5, 30, 1, 10, 1, 1]
    const started: number[] = []
    const r = await runCandidates(
      [0, 1, 2, 3, 4, 5, 6],
      async (i) => {
        started.push(i)
        await new Promise((res) => setTimeout(res, delays[i]))
        return i === 1 ? { kind: 'skip' as const } : ok(i)
      },
      { limit: 3, concurrency: 2 }
    )
    expect(r.ok).toEqual([0, 2, 3])
    expect(r.cut).toEqual([])
    // never ran far past what it needed
    expect(started).not.toContain(6)
  })

  it('never runs more than `concurrency` at once', async () => {
    let active = 0
    let peak = 0
    await runCandidates(
      Array.from({ length: 12 }, (_, i) => i),
      async (i) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((res) => setTimeout(res, 3))
        active--
        return i % 3 === 0 ? { kind: 'skip' as const } : ok(i)
      },
      { limit: 5, concurrency: 4 }
    )
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('a cut candidate holds its place and is named', async () => {
    const r = await runCandidates(
      [0, 1, 2, 3],
      async (i) => (i === 1 ? { kind: 'cut' as const } : ok(i)),
      { limit: 3, concurrency: 1 }
    )
    expect(r.ok).toEqual([0, 2])
    expect(r.cut).toEqual([1])
  })
})
