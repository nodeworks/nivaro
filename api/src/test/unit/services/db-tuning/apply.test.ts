// api/src/test/unit/services/db-tuning/apply.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyProposal,
  dismissProposal,
  executeSpec,
  parseIndexStatement,
  renderIndexStatement,
  revalidate,
  rollbackProposal,
  specsProblem,
  TuningRefusal
} from '../../../../services/db-tuning/apply.js'
import { bodyHash } from '../../../../services/db-tuning/twin.js'
import type { ProposalRow } from '../../../../services/db-tuning/types.js'
import { createIndexSql, indexName } from '../../../../services/index-advisor.js'

type IndexInfo = { type_desc: string; is_primary_key: boolean; is_unique_constraint: boolean }

const m = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  fields: new Map<string, Record<string, unknown>>(),
  queries: new Map<number, Record<string, unknown>>(),
  columns: {} as Record<string, string[]>,
  indexes: {} as Record<string, Record<string, IndexInfo>>,
  parentIds: [] as Array<{ id: unknown }>,
  mssql: true,
  /** proposal-row writes whose status is listed here throw (a DB hiccup mid-apply) */
  failStatus: new Set<string>(),
  /** proposal-row writes whose status is listed here land, then throw (the reply was lost) */
  commitThenFail: new Set<string>(),
  /** sys.indexes reads answered in order before falling back to m.indexes */
  indexReads: [] as Array<IndexInfo | null>,
  runLongSql: vi.fn(async (_sql: string): Promise<unknown[]> => []),
  hasColumn: vi.fn(async (_t: string, _c: string) => true),
  schemaTable: vi.fn(async (_t: string, _cb: unknown) => undefined),
  procBody: vi.fn(async (_n: string): Promise<string | null> => null),
  indexDef: vi.fn(async (_t: string, _i: string): Promise<string | null> => null),
  replicatedArticle: vi.fn(async (_t: string) => false),
  replicatedProc: vi.fn(async (_n: string) => false),
  run: {
    id: 7,
    progress: vi.fn(),
    complete: vi.fn(async (_o?: string) => {}),
    fail: vi.fn(async (_e: unknown) => {})
  },
  startJobRun: vi.fn(),
  logActivity: vi.fn(async (_o: Record<string, unknown>) => 1),
  captureBaseline: vi.fn(
    async (_r: unknown): Promise<Record<string, number | null>> => ({
      metric: 42
    })
  ),
  recalc: vi.fn(async (_e: unknown, _id: unknown) => {}),
  bustDef: vi.fn(),
  clearMeta: vi.fn(),
  bustRollup: vi.fn(),
  bustFresh: vi.fn()
}))

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v)

vi.mock('../../../../db/index.js', () => {
  const builder = (table: string) => {
    const where: Record<string, unknown> = {}
    const whereIn: Record<string, unknown[]> = {}
    const matchesIn = (row: Record<string, unknown>) =>
      Object.entries(whereIn).every(([k, vals]) => vals.includes(row[k]))
    const q = {
      where(o: Record<string, unknown>) {
        Object.assign(where, o)
        return q
      },
      whereIn(col: string, vals: unknown[]) {
        whereIn[col] = vals
        return q
      },
      async first() {
        if (table === 'nivaro_fields') return m.fields.get(`${where.collection}.${where.field}`)
        if (table === 'nivaro_custom_queries') return m.queries.get(Number(where.id))
        return undefined
      },
      async select() {
        return m.parentIds
      },
      async update(patch: Record<string, unknown>) {
        const p = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, iso(v)]))
        if (table === 'nivaro_tuning_proposals') {
          if (m.failStatus.has(String(p.status))) throw new Error('connection reset')
          // transition() JSON-encodes objects the way the ledger does; read them back as objects
          for (const [k, v] of Object.entries(p))
            if (typeof v === 'string' && v.startsWith('{')) p[k] = JSON.parse(v)
          const row = m.rows.get(String(where.id))
          if (!row || !matchesIn(row)) return 0
          Object.assign(row, p)
          if (m.commitThenFail.has(String(p.status))) throw new Error('connection reset')
          return 1
        }
        if (table === 'nivaro_fields') {
          const f = m.fields.get(`${where.collection}.${where.field}`)
          if (!f) return 0
          Object.assign(f, p)
          return 1
        }
        if (table === 'nivaro_custom_queries') {
          const r = m.queries.get(Number(where.id))
          if (!r || (where.slug !== undefined && r.slug !== where.slug)) return 0
          Object.assign(r, p)
          return 1
        }
        return 0
      }
    }
    return q
  }
  const raw = async (sql: string, b: unknown[] = []) => {
    const table = String(b[0])
    if (/sys\.columns/.test(sql)) return (m.columns[table] ?? []).map((name) => ({ name }))
    if (/sys\.indexes/.test(sql)) {
      if (m.indexReads.length) {
        const next = m.indexReads.shift()
        return next ? [next] : []
      }
      const ix = m.indexes[table]?.[String(b[1])]
      return ix ? [ix] : []
    }
    if (/sys\.data_spaces/.test(sql)) return b[0] === 'PRIMARY' ? [{ x: 1 }] : []
    return []
  }
  return {
    db: Object.assign(builder, {
      raw,
      schema: { hasColumn: m.hasColumn, table: m.schemaTable }
    })
  }
})
vi.mock('../../../../services/db-tuning/ledger.js', () => ({
  getProposal: async (id: string) => {
    const r = m.rows.get(id)
    return r ? (structuredClone(r) as unknown as ProposalRow) : null
  },
  updateProposal: async (id: string, patch: Record<string, unknown>) => {
    const r = m.rows.get(id)
    if (r) Object.assign(r, Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, iso(v)])))
  }
}))
vi.mock('../../../../services/db-tuning/settings.js', () => ({
  readTuningSettings: async () => ({ watch_days: 7 })
}))
vi.mock('../../../../services/db-tuning/watch.js', () => ({ captureBaseline: m.captureBaseline }))
vi.mock('../../../../services/db-tuning/dmv.js', () => ({
  isMssqlDb: () => m.mssql,
  procedureBody: m.procBody,
  indexDefinition: m.indexDef
}))
vi.mock('../../../../services/run-long.js', () => ({ runLongSql: m.runLongSql }))
vi.mock('../../../../services/job-runs.js', () => ({ startJobRun: m.startJobRun }))
vi.mock('../../../../services/activity.js', () => ({ logActivity: m.logActivity }))
vi.mock('../../../../services/replication.js', () => ({
  isReplicatedArticle: m.replicatedArticle,
  isReplicatedProcedure: m.replicatedProc
}))
vi.mock('../../../../services/collections.js', () => ({ clearMetadataCache: m.clearMeta }))
vi.mock('../../../../services/definition-cache.js', () => ({ bustDefinitionCache: m.bustDef }))
vi.mock('../../../../services/query-freshness.js', () => ({ bustFreshnessInference: m.bustFresh }))
vi.mock('../../../../services/rollups.js', () => ({
  bustRollupContributorCache: m.bustRollup,
  parseRollupFormula: (raw: string | null) => (raw ? { sources: [{ raw }] } : null),
  recalcRollupsForParent: m.recalc
}))

const row = (over: Partial<ProposalRow>): ProposalRow => ({
  id: 'x',
  kind: 'index_create',
  target: 'workflows.project_type',
  fingerprint: 'f',
  status: 'proposed',
  title: 't',
  evidence: {},
  proof: null,
  estimate_ms_per_day: 1,
  risk: 'reversible',
  replicated: false,
  dialect_note: null,
  apply: {
    type: 'sql',
    statements: ['CREATE NONCLUSTERED INDEX idx ON [workflows] ([project_type])']
  },
  undo: { type: 'sql', statements: ['DROP INDEX [idx] ON [workflows]'] },
  applied_at: null,
  applied_by: null,
  watch_until: null,
  watch_baseline: null,
  rolled_back_at: null,
  rollback_reason: null,
  dismissed_at: null,
  dismissed_by: null,
  dismiss_note: null,
  first_seen: '',
  last_seen: '',
  run_id: null,
  ...over
})
const live = { indexExists: false, procHash: null, fieldStore: null, queryRow: null }

describe('revalidate', () => {
  it('index_create: refuses when the index already exists', () => {
    expect(revalidate(row({}), { ...live, indexExists: true })).toMatch(/already exists/)
    expect(revalidate(row({}), live)).toBeNull()
  })
  it('index_drop: refuses when the index is gone', () => {
    expect(revalidate(row({ kind: 'index_drop' }), { ...live, indexExists: false })).toMatch(
      /no longer exists/
    )
  })
  it('proc_rewrite: refuses when the live body hash moved (stale)', () => {
    const r = row({
      kind: 'proc_rewrite',
      apply: { type: 'proc_body', proc: 'p', body: 'new', hash: 'n' },
      undo: { type: 'proc_body', proc: 'p', body: 'old', hash: 'OLD' }
    })
    expect(revalidate(r, { ...live, procHash: 'OLD' })).toBeNull()
    expect(revalidate(r, { ...live, procHash: 'CHANGED' })).toMatch(/changed since the proof/)
  })
  it('rollup_store: refuses when already stored; query_cache: refuses when the query already caches', () => {
    expect(
      revalidate(
        row({
          kind: 'rollup_store',
          apply: {
            type: 'field_patch',
            collection: 'c',
            field: 'f',
            patch: { computed_store: true }
          }
        }),
        { ...live, fieldStore: true }
      )
    ).toMatch(/already/)
    expect(
      revalidate(
        row({
          kind: 'query_cache',
          apply: {
            type: 'query_patch',
            id: 1,
            slug: 's',
            patch: { cache_ttl: 600, warm_daily: false }
          },
          undo: {
            type: 'query_patch',
            id: 1,
            slug: 's',
            patch: { cache_ttl: 0, warm_daily: false }
          }
        }),
        { ...live, queryRow: { cache_ttl: 300, warm_daily: false } }
      )
    ).toMatch(/changed since/)
  })

  it('index_create: refuses when the table or a key column is gone, or the catalog is unread', () => {
    expect(revalidate(row({}), { ...live, columnsExist: false })).toMatch(/column/)
    expect(revalidate(row({}), { ...live, indexExists: null })).toMatch(/could not be read/)
  })
  it('index_drop: refuses when the live definition differs from the recorded undo', () => {
    const r = row({
      kind: 'index_drop',
      target: 'workflows.ix_a',
      apply: { type: 'sql', statements: ['DROP INDEX [ix_a] ON [workflows]'] },
      undo: { type: 'sql', statements: ['CREATE NONCLUSTERED INDEX [ix_a] ON [workflows] ([a])'] }
    })
    const def = 'CREATE NONCLUSTERED INDEX [ix_a] ON [workflows] ([a])'
    expect(revalidate(r, { ...live, indexExists: true, indexDefinition: def })).toBeNull()
    expect(
      revalidate(r, {
        ...live,
        indexExists: true,
        indexDefinition: 'CREATE NONCLUSTERED INDEX [ix_a] ON [workflows] ([a]) INCLUDE ([b])'
      })
    ).toMatch(/definition changed/)
    // not rebuildable any more (disabled, partitioned …) → not the index the proposal saw
    expect(revalidate(r, { ...live, indexExists: true, indexDefinition: null })).toMatch(
      /definition changed/
    )
  })
  it('rollup_store: a field that is no longer a rollup; query_cache: a query that is gone', () => {
    const rollup = row({
      kind: 'rollup_store',
      apply: { type: 'field_patch', collection: 'c', field: 'f', patch: { computed_store: true } }
    })
    expect(revalidate(rollup, { ...live, fieldStore: null })).toMatch(/no longer a rollup/)
    expect(revalidate(rollup, { ...live, fieldStore: false })).toBeNull()
    const q = row({
      kind: 'query_cache',
      apply: {
        type: 'query_patch',
        id: 1,
        slug: 's',
        patch: { cache_ttl: 600, warm_daily: false }
      },
      undo: { type: 'query_patch', id: 1, slug: 's', patch: { cache_ttl: 0, warm_daily: false } }
    })
    expect(revalidate(q, live)).toMatch(/no longer exists/)
    expect(revalidate(q, { ...live, queryRow: { cache_ttl: 0, warm_daily: false } })).toBeNull()
  })
})

describe('parseIndexStatement', () => {
  it('accepts the observer shapes and renders them canonically', () => {
    const c = parseIndexStatement(
      'CREATE NONCLUSTERED INDEX idx_workflows_a_b ON [workflows] ([a], [b])'
    )
    expect(c).toMatchObject({ op: 'create', name: 'idx_workflows_a_b', table: 'workflows' })
    expect(renderIndexStatement(c!)).toBe(
      'CREATE NONCLUSTERED INDEX [idx_workflows_a_b] ON [workflows] ([a], [b])'
    )
    const d = parseIndexStatement('DROP INDEX [ix] ON [workflows];')
    expect(d).toMatchObject({ op: 'drop', name: 'ix', table: 'workflows' })
    expect(renderIndexStatement(d!)).toBe('DROP INDEX [ix] ON [workflows]')
  })
  it('accepts a full rebuilt definition (unique, DESC, INCLUDE, filter, WITH, filegroup)', () => {
    const sql =
      "CREATE UNIQUE NONCLUSTERED INDEX [ix] ON [t] ([a] DESC, [b] ASC) INCLUDE ([c]) WHERE ([s]='open' AND [d] IS NOT NULL) WITH (FILLFACTOR = 90, DATA_COMPRESSION = PAGE) ON [PRIMARY]"
    const s = parseIndexStatement(sql)
    expect(s).toMatchObject({
      unique: true,
      keys: [
        { column: 'a', desc: true },
        { column: 'b', desc: false }
      ],
      include: ['c'],
      filterColumns: ['s', 'd'],
      options: ['FILLFACTOR = 90', 'DATA_COMPRESSION = PAGE'],
      fileGroup: 'PRIMARY'
    })
    expect(renderIndexStatement(s!)).toBe(
      "CREATE UNIQUE NONCLUSTERED INDEX [ix] ON [t] ([a] DESC, [b]) INCLUDE ([c]) WHERE ( [s] = 'open' AND [d] IS NOT NULL ) WITH (FILLFACTOR = 90, DATA_COMPRESSION = PAGE) ON [PRIMARY]"
    )
  })
  it('keeps a semicolon inside a string literal as data', () => {
    const s = parseIndexStatement(
      "CREATE NONCLUSTERED INDEX i ON [t] ([a]) WHERE ([s] = 'x''; DROP TABLE t; --')"
    )
    expect(s?.filter).toBe("( [s] = 'x''; DROP TABLE t; --' )")
  })
  it.each([
    'DROP TABLE [workflows]',
    'CREATE NONCLUSTERED INDEX i ON [t] ([a]); DROP TABLE [t]',
    'CREATE NONCLUSTERED INDEX i ON [t] ([a]) -- trailing comment',
    'CREATE NONCLUSTERED INDEX i ON [t] ([a]) /* c */',
    'CREATE CLUSTERED INDEX i ON [t] ([a])',
    'CREATE INDEX i ON [t] ([a])',
    'CREATE NONCLUSTERED INDEX i ON [dbo].[t] ([a])',
    'CREATE NONCLUSTERED INDEX [i]]; DROP TABLE t; --] ON [t] ([a])',
    'CREATE NONCLUSTERED INDEX i ON [t] ([a]) WITH (DROP_EXISTING = ON)',
    'CREATE NONCLUSTERED INDEX i ON [t] ([a]) WHERE (dbo.f([a]) = 1)',
    'CREATE NONCLUSTERED INDEX i ON [t] ([a]) WHERE ([a] = (SELECT 1))',
    'CREATE NONCLUSTERED INDEX i ON [t] ([a]) WHERE ([a] = 1',
    'CREATE NONCLUSTERED INDEX i ON [t] ()',
    'DROP INDEX [ix] ON [t] EXTRA',
    'EXEC sp_who'
  ])('refuses %s', (sql) => {
    expect(parseIndexStatement(sql)).toBeNull()
  })
})

describe('specsProblem', () => {
  it('passes the observer shapes', () => {
    expect(
      specsProblem(
        row({
          apply: { type: 'sql', statements: [createIndexSql('workflows', 'project_type')] },
          undo: {
            type: 'sql',
            statements: [`DROP INDEX [${indexName('workflows', 'project_type')}] ON [workflows]`]
          }
        })
      )
    ).toBeNull()
  })
  it('refuses an index statement on another table than the target', () => {
    expect(
      specsProblem(
        row({
          apply: {
            type: 'sql',
            statements: ['CREATE NONCLUSTERED INDEX idx ON [users] ([project_type])']
          }
        })
      )
    ).toMatch(/target/)
  })
  it('refuses an undo that would not reverse the apply', () => {
    expect(
      specsProblem(
        row({ undo: { type: 'sql', statements: ['DROP INDEX [other] ON [workflows]'] } })
      )
    ).toMatch(/undo/)
    expect(specsProblem(row({ undo: { type: 'sql', statements: [] } }))).toMatch(/undo/)
  })
  it('refuses a spec type that does not fit the kind, a foreign proc, a foreign query', () => {
    expect(specsProblem(row({ kind: 'proc_rewrite', target: 'p' }))).toMatch(/kind/)
    expect(
      specsProblem(
        row({
          kind: 'proc_rewrite',
          target: 'p',
          apply: { type: 'proc_body', proc: 'q', body: 'b', hash: 'h' },
          undo: { type: 'proc_body', proc: 'p', body: 'b', hash: 'h' }
        })
      )
    ).toMatch(/target/)
    expect(
      specsProblem(
        row({
          kind: 'query_cache',
          target: 's',
          apply: {
            type: 'query_patch',
            id: 1,
            slug: 's',
            patch: { cache_ttl: 600, warm_daily: false }
          },
          undo: {
            type: 'query_patch',
            id: 2,
            slug: 's',
            patch: { cache_ttl: 0, warm_daily: false }
          }
        })
      )
    ).toMatch(/undo/)
  })
})

const PROC_OLD = 'CREATE PROCEDURE [dbo].[p] AS SELECT 1'
const PROC_NEW = 'CREATE PROCEDURE p AS SELECT 2'
const procRow = (over: Partial<ProposalRow> = {}) =>
  row({
    kind: 'proc_rewrite',
    target: 'p',
    risk: 'review',
    apply: { type: 'proc_body', proc: 'p', body: PROC_NEW, hash: bodyHash(PROC_NEW) },
    undo: { type: 'proc_body', proc: 'p', body: PROC_OLD, hash: bodyHash(PROC_OLD) },
    proof: { passed: true, method: 'twin', before: {}, after: {}, detail: '' },
    ...over
  })
const PLAIN_NC: IndexInfo = {
  type_desc: 'NONCLUSTERED',
  is_primary_key: false,
  is_unique_constraint: false
}

beforeEach(() => {
  vi.clearAllMocks()
  m.rows.clear()
  m.fields.clear()
  m.queries.clear()
  m.columns = { workflows: ['id', 'project_type', 'status'] }
  m.indexes = { workflows: {} }
  m.parentIds = [{ id: 1 }, { id: 2 }]
  m.mssql = true
  m.failStatus.clear()
  m.commitThenFail.clear()
  m.indexReads = []
  m.runLongSql.mockImplementation(async () => [])
  m.procBody.mockImplementation(async () => null)
  m.indexDef.mockImplementation(async () => null)
  m.replicatedArticle.mockImplementation(async () => false)
  m.replicatedProc.mockImplementation(async () => false)
  m.hasColumn.mockImplementation(async () => true)
  m.captureBaseline.mockImplementation(async () => ({ metric: 42 }))
  m.startJobRun.mockImplementation(async () => m.run)
})

const refusal = async (p: Promise<unknown>): Promise<TuningRefusal> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(TuningRefusal)
  return err as TuningRefusal
}

describe('executeSpec', () => {
  it('never runs a statement outside the index create/drop shapes', async () => {
    const err = await refusal(
      executeSpec({ type: 'sql', statements: ['DROP TABLE [workflows]'] }, { userId: 'u' })
    )
    expect(err.code).toBe('TUNING_INVALID')
    expect(err.status).toBe(400)
    expect(m.runLongSql).not.toHaveBeenCalled()
  })
  it('validates every statement before running the first', async () => {
    await refusal(
      executeSpec(
        {
          type: 'sql',
          statements: ['DROP INDEX [idx] ON [workflows]', 'EXEC sp_who']
        },
        { userId: 'u' }
      )
    )
    expect(m.runLongSql).not.toHaveBeenCalled()
  })
  it('re-checks names against sys.*: a missing column or table refuses, nothing runs', async () => {
    const col = await refusal(
      executeSpec(
        { type: 'sql', statements: ['CREATE NONCLUSTERED INDEX i ON [workflows] ([gone])'] },
        { userId: 'u' }
      )
    )
    expect(col.code).toBe('TUNING_INVALID')
    expect(col.message).toMatch(/gone/)
    await refusal(
      executeSpec(
        { type: 'sql', statements: ['CREATE NONCLUSTERED INDEX i ON [nope] ([a])'] },
        { userId: 'u' }
      )
    )
    await refusal(
      executeSpec(
        {
          type: 'sql',
          statements: ['CREATE NONCLUSTERED INDEX i ON [workflows] ([status]) ON [fg9]']
        },
        { userId: 'u' }
      )
    )
    expect(m.runLongSql).not.toHaveBeenCalled()
  })
  it('runs the canonical rendering of a valid create', async () => {
    const out = await executeSpec(
      {
        type: 'sql',
        statements: ['create nonclustered index idx on workflows (project_type desc)']
      },
      { userId: 'u' }
    )
    expect(m.runLongSql).toHaveBeenCalledWith(
      'CREATE NONCLUSTERED INDEX [idx] ON [workflows] ([project_type] DESC)'
    )
    expect(out).toMatch(/CREATE NONCLUSTERED INDEX \[idx\]/)
  })
  it('drops only an existing plain nonclustered index', async () => {
    const drop = { type: 'sql' as const, statements: ['DROP INDEX [pk] ON [workflows]'] }
    expect((await refusal(executeSpec(drop, { userId: 'u' }))).message).toMatch(/does not exist/)
    m.indexes.workflows.pk = {
      type_desc: 'CLUSTERED',
      is_primary_key: true,
      is_unique_constraint: false
    }
    expect((await refusal(executeSpec(drop, { userId: 'u' }))).message).toMatch(
      /plain nonclustered/
    )
    m.indexes.workflows.ix = {
      type_desc: 'NONCLUSTERED',
      is_primary_key: false,
      is_unique_constraint: false
    }
    await executeSpec(
      { type: 'sql', statements: ['DROP INDEX [ix] ON [workflows]'] },
      { userId: 'u' }
    )
    expect(m.runLongSql).toHaveBeenCalledWith('DROP INDEX [ix] ON [workflows]')
  })
  it('refuses index and procedure changes off SQL Server', async () => {
    m.mssql = false
    const err = await refusal(executeSpec(row({}).apply, { userId: 'u' }))
    expect(err.code).toBe('TUNING_NOT_APPLICABLE')
  })
  it('proc_body: only CREATE OR ALTER of the named proc, with a matching hash', async () => {
    m.procBody.mockImplementation(async () => PROC_OLD)
    const other = 'CREATE PROCEDURE [dbo].[q] AS SELECT 1'
    expect(
      (
        await refusal(
          executeSpec(
            { type: 'proc_body', proc: 'p', body: other, hash: bodyHash(other) },
            { userId: 'u' }
          )
        )
      ).code
    ).toBe('TUNING_INVALID')
    await refusal(
      executeSpec({ type: 'proc_body', proc: 'p', body: PROC_NEW, hash: 'stale' }, { userId: 'u' })
    )
    expect(m.runLongSql).not.toHaveBeenCalled()
    await executeSpec(procRow().apply, { userId: 'u' })
    expect(m.runLongSql).toHaveBeenCalledWith('CREATE OR ALTER PROCEDURE [dbo].[p] AS SELECT 2')
  })
  it('proc_body: a procedure that no longer exists is refused', async () => {
    await refusal(executeSpec(procRow().apply, { userId: 'u' }))
    expect(m.runLongSql).not.toHaveBeenCalled()
  })
  it('query_patch: writes the row and busts the definition + freshness caches', async () => {
    m.queries.set(3, { id: 3, slug: 's', cache_ttl: 0, warm_daily: false })
    await executeSpec(
      { type: 'query_patch', id: 3, slug: 's', patch: { cache_ttl: 600, warm_daily: true } },
      { userId: 'u' }
    )
    expect(m.queries.get(3)).toMatchObject({ cache_ttl: 600, warm_daily: true })
    expect(m.bustDef).toHaveBeenCalledWith('custom-query:3')
    expect(m.bustFresh).toHaveBeenCalled()
    // a renamed slug is not the query the proposal measured
    await refusal(
      executeSpec(
        { type: 'query_patch', id: 3, slug: 'other', patch: { cache_ttl: 0, warm_daily: false } },
        { userId: 'u' }
      )
    )
    await refusal(
      executeSpec(
        { type: 'query_patch', id: 3, slug: 's', patch: { cache_ttl: 999_999, warm_daily: false } },
        { userId: 'u' }
      )
    )
  })
  it('field_patch: provisions the column, stores, busts caches and backfills every row', async () => {
    m.fields.set('orders.total', {
      type: 'string',
      computed_type: 'rollup',
      computed_formula: '{"sources":[]}',
      computed_store: 0
    })
    m.hasColumn.mockImplementation(async () => false)
    const out = await executeSpec(
      {
        type: 'field_patch',
        collection: 'orders',
        field: 'total',
        patch: { computed_store: true }
      },
      { userId: 'u' }
    )
    expect(m.schemaTable).toHaveBeenCalledWith('orders', expect.any(Function))
    expect(m.fields.get('orders.total')).toMatchObject({ computed_store: 1, type: 'decimal' })
    expect(m.clearMeta).toHaveBeenCalledWith('orders')
    expect(m.bustRollup).toHaveBeenCalled()
    expect(m.recalc).toHaveBeenCalledTimes(2)
    expect(out).toMatch(/2 row/)
  })
  it('field_patch: refuses a field that is not a rollup, and system collections', async () => {
    m.fields.set('orders.name', { type: 'string', computed_type: null, computed_formula: null })
    await refusal(
      executeSpec(
        {
          type: 'field_patch',
          collection: 'orders',
          field: 'name',
          patch: { computed_store: true }
        },
        { userId: 'u' }
      )
    )
    await refusal(
      executeSpec(
        {
          type: 'field_patch',
          collection: 'nivaro_users',
          field: 'x',
          patch: { computed_store: true }
        },
        { userId: 'u' }
      )
    )
    expect(m.schemaTable).not.toHaveBeenCalled()
  })
})

describe('index_create apply grammar', () => {
  const create = (sql: string) => row({ apply: { type: 'sql', statements: [sql] } })
  it.each([
    'CREATE UNIQUE NONCLUSTERED INDEX idx ON [workflows] ([project_type])',
    'CREATE NONCLUSTERED INDEX idx ON [workflows] ([project_type]) WHERE ([project_type] IS NOT NULL)',
    'CREATE NONCLUSTERED INDEX idx ON [workflows] ([project_type]) ON [PRIMARY]',
    'CREATE NONCLUSTERED INDEX idx ON [workflows] ([project_type]) WITH (IGNORE_DUP_KEY = ON)',
    'CREATE NONCLUSTERED INDEX idx ON [workflows] ([project_type]) WITH (ALLOW_ROW_LOCKS = OFF)',
    'CREATE NONCLUSTERED INDEX idx ON [workflows] ([project_type]) WITH (ALLOW_PAGE_LOCKS = OFF)'
  ])('an index_create apply refuses %s', (sql) => {
    expect(specsProblem(create(sql))).toMatch(/index_create may not/)
  })
  it('allows build and storage options on a create', () => {
    expect(
      specsProblem(
        create(
          'CREATE NONCLUSTERED INDEX idx ON [workflows] ([project_type]) WITH (ONLINE = ON, SORT_IN_TEMPDB = ON, DATA_COMPRESSION = PAGE, FILLFACTOR = 90, MAXDOP = 4)'
        )
      )
    ).toBeNull()
  })
  it('the full grammar stays for restoring a dropped definition (index_drop undo)', () => {
    const drop = row({
      kind: 'index_drop',
      target: 'workflows.ix_u',
      apply: { type: 'sql', statements: ['DROP INDEX [ix_u] ON [workflows]'] },
      undo: {
        type: 'sql',
        statements: [
          "CREATE UNIQUE NONCLUSTERED INDEX [ix_u] ON [workflows] ([status]) WHERE ([status] = N'open') WITH (IGNORE_DUP_KEY = ON) ON [PRIMARY]"
        ]
      }
    })
    expect(specsProblem(drop)).toBeNull()
  })
  it("index_drop revalidate keeps literal case: a filter on N'Open' is not N'open'", () => {
    const drop = row({
      kind: 'index_drop',
      target: 'workflows.ix_f',
      apply: { type: 'sql', statements: ['DROP INDEX [ix_f] ON [workflows]'] },
      undo: {
        type: 'sql',
        statements: ["CREATE NONCLUSTERED INDEX [ix_f] ON [workflows] ([a]) WHERE ([s] = N'open')"]
      }
    })
    const def = (lit: string) =>
      `CREATE NONCLUSTERED INDEX [IX_F] ON [Workflows] ([A]) WHERE ([S] = N'${lit}')`
    expect(
      revalidate(drop, { ...live, indexExists: true, indexDefinition: def('open') })
    ).toBeNull()
    expect(revalidate(drop, { ...live, indexExists: true, indexDefinition: def('Open') })).toMatch(
      /definition changed/
    )
  })
})

describe('applyProposal', () => {
  const app = {} as never

  it('applies only a proposed row — stale / rejected_by_proof answer reprove first', async () => {
    for (const status of ['rejected_by_proof', 'stale'] as const) {
      m.rows.set('x', { ...row({ status }) })
      const err = await refusal(applyProposal('x', { userId: 'u', dbaOk: false, app }))
      expect(err.code).toBe('TUNING_NOT_APPLICABLE')
      expect(err.status).toBe(409)
      expect(err.message).toMatch(/reprove first/)
    }
    m.rows.set('x', { ...row({ status: 'watching' }) })
    const err = await refusal(applyProposal('x', { userId: 'u', dbaOk: false, app }))
    expect(err.message).not.toMatch(/reprove/)
    expect(m.startJobRun).not.toHaveBeenCalled()
  })
  it('a proc rewrite applies only on a passed twin proof', async () => {
    m.procBody.mockImplementation(async () => PROC_OLD)
    for (const proof of [
      null,
      { passed: false, method: 'twin' as const, before: {}, after: {}, detail: '' },
      { passed: true, method: 'cost-model' as const, before: {}, after: {}, detail: '' }
    ]) {
      m.rows.set('x', { ...procRow({ proof }) })
      expect((await refusal(applyProposal('x', { userId: 'u', dbaOk: false, app }))).code).toBe(
        'TUNING_NOT_APPLICABLE'
      )
    }
    expect(m.runLongSql).not.toHaveBeenCalled()
  })
  it('an extension CREATE UNIQUE … WITH (IGNORE_DUP_KEY = ON) → 400 TUNING_INVALID, nothing runs', async () => {
    m.rows.set('x', {
      ...row({
        apply: {
          type: 'sql',
          statements: [
            'CREATE UNIQUE NONCLUSTERED INDEX idx ON [workflows] ([project_type]) WITH (IGNORE_DUP_KEY = ON)'
          ]
        }
      })
    })
    const err = await refusal(applyProposal('x', { userId: 'u', dbaOk: false, app }))
    expect(err.code).toBe('TUNING_INVALID')
    expect(err.status).toBe(400)
    expect(m.rows.get('x')?.status).toBe('proposed')
    expect(m.runLongSql).not.toHaveBeenCalled()
  })
  it('refuses a replicated target without dba_ok — recorded or live; the body names the statement', async () => {
    m.rows.set('x', { ...row({ replicated: true }) })
    const recorded = await refusal(applyProposal('x', { userId: 'u', dbaOk: false, app }))
    expect(recorded.code).toBe('TUNING_REPLICATED')
    expect(recorded.detail).toEqual({
      target: 'workflows.project_type',
      statements: ['CREATE NONCLUSTERED INDEX [idx] ON [workflows] ([project_type])']
    })
    m.rows.set('y', { ...row({ id: 'y' }) })
    m.replicatedArticle.mockImplementation(async () => true)
    expect((await refusal(applyProposal('y', { userId: 'u', dbaOk: false, app }))).code).toBe(
      'TUNING_REPLICATED'
    )
    expect(m.runLongSql).not.toHaveBeenCalled()
    await applyProposal('y', { userId: 'u', dbaOk: true, app })
    expect(m.rows.get('y')?.status).toBe('watching')
  })
  it("a stored rollup on a replicated collection's table is refused live (its column add is DDL)", async () => {
    m.rows.set('x', {
      ...row({
        kind: 'rollup_store',
        target: 'orders.total',
        apply: {
          type: 'field_patch',
          collection: 'orders',
          field: 'total',
          patch: { computed_store: true }
        },
        undo: {
          type: 'field_patch',
          collection: 'orders',
          field: 'total',
          patch: { computed_store: false }
        }
      })
    })
    m.replicatedArticle.mockImplementation(async (t: string) => t === 'orders')
    const err = await refusal(applyProposal('x', { userId: 'u', dbaOk: false, app }))
    expect(err.code).toBe('TUNING_REPLICATED')
    expect(err.detail?.target).toBe('orders.total')
    expect(m.schemaTable).not.toHaveBeenCalled()
  })
  it('stale proc hash → status stale, 409 TUNING_STALE, nothing runs', async () => {
    m.rows.set('x', { ...procRow() })
    m.procBody.mockImplementation(async () => 'CREATE PROCEDURE [dbo].[p] AS SELECT 99')
    const err = await refusal(applyProposal('x', { userId: 'u', dbaOk: false, app }))
    expect(err.code).toBe('TUNING_STALE')
    expect(err.status).toBe(409)
    expect(err.message).toMatch(/changed since the proof/)
    expect(m.rows.get('x')?.status).toBe('stale')
    expect(m.runLongSql).not.toHaveBeenCalled()
    expect(m.startJobRun).not.toHaveBeenCalled()
  })
  it('an index that appeared since the proposal → stale', async () => {
    m.rows.set('x', { ...row({}) })
    m.indexes.workflows.idx = PLAIN_NC
    expect((await refusal(applyProposal('x', { userId: 'u', dbaOk: false, app }))).code).toBe(
      'TUNING_STALE'
    )
    expect(m.rows.get('x')?.status).toBe('stale')
  })
  it('an invalid statement is refused before anything changes', async () => {
    m.rows.set('x', {
      ...row({
        apply: {
          type: 'sql',
          statements: [
            'CREATE NONCLUSTERED INDEX idx ON [workflows] ([project_type]); DROP TABLE x'
          ]
        }
      })
    })
    expect((await refusal(applyProposal('x', { userId: 'u', dbaOk: false, app }))).code).toBe(
      'TUNING_INVALID'
    )
    expect(m.rows.get('x')?.status).toBe('proposed')
  })
  it('success → watching, baseline captured BEFORE the change, watch window, job run, activity', async () => {
    m.rows.set('x', {
      ...row({
        proof: {
          passed: true,
          method: 'hypothetical',
          before: { cost: 9 },
          after: { cost: 3, note: 'n' },
          detail: ''
        }
      })
    })
    const before = Date.now()
    const out = await applyProposal('x', { userId: 'u1', dbaOk: false, app })
    expect(out.status).toBe('watching')
    expect(out.applied_by).toBe('u1')
    expect(out.run_id).toBe(7)
    expect(out.watch_baseline).toEqual({ before: { metric: 42 }, after: { cost: 3 } })
    const until = new Date(String(out.watch_until)).getTime()
    expect(until - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000)
    expect(until - before).toBeLessThan(7 * 86_400_000 + 60_000)
    expect(m.captureBaseline.mock.invocationCallOrder[0]).toBeLessThan(
      m.runLongSql.mock.invocationCallOrder[0]
    )
    expect(m.startJobRun).toHaveBeenCalledWith(
      'tuning',
      'tuning:apply:x',
      expect.objectContaining({ triggeredBy: 'u1' })
    )
    expect(m.run.complete).toHaveBeenCalled()
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tuning-apply',
        collection: 'nivaro_tuning_proposals',
        item: 'x'
      })
    )
  })
  it('a failed apply → failed with the error, undo run at once and its outcome recorded', async () => {
    m.rows.set('x', { ...procRow() })
    m.procBody.mockImplementation(async () => PROC_OLD)
    m.runLongSql.mockImplementationOnce(async () => {
      throw new Error('Invalid column name foo')
    })
    await expect(applyProposal('x', { userId: 'u', dbaOk: false, app })).rejects.toThrow(/foo/)
    const r = m.rows.get('x')
    expect(r?.status).toBe('failed')
    expect(String(r?.rollback_reason)).toMatch(/apply failed: Invalid column name foo/)
    expect(String(r?.rollback_reason)).toMatch(/undo ran/)
    expect(m.runLongSql).toHaveBeenCalledTimes(2)
    expect(m.runLongSql.mock.calls[1][0]).toBe('CREATE OR ALTER PROCEDURE [dbo].[p] AS SELECT 1')
    expect(m.run.fail).toHaveBeenCalled()
  })
  it('a failed apply whose undo also fails records both errors', async () => {
    m.rows.set('x', { ...procRow() })
    m.procBody.mockImplementation(async () => PROC_OLD)
    m.runLongSql
      .mockImplementationOnce(async () => {
        throw new Error('lock timeout')
      })
      .mockImplementationOnce(async () => {
        throw new Error('deadlock victim')
      })
    await expect(applyProposal('x', { userId: 'u', dbaOk: false, app })).rejects.toThrow(
      /lock timeout/
    )
    const reason = String(m.rows.get('x')?.rollback_reason)
    expect(reason).toMatch(/apply failed: lock timeout/)
    expect(reason).toMatch(/undo failed: deadlock victim/)
    expect(m.rows.get('x')?.status).toBe('failed')
  })
  it('an undo the catalog refuses is recorded as not run', async () => {
    m.rows.set('x', { ...row({}) })
    m.runLongSql.mockImplementation(async () => {
      throw new Error('lock timeout')
    })
    await expect(applyProposal('x', { userId: 'u', dbaOk: false, app })).rejects.toThrow(/lock/)
    // the CREATE never landed, so the DROP is refused by the catalog re-check
    expect(String(m.rows.get('x')?.rollback_reason)).toMatch(
      /undo not run: index idx does not exist/
    )
    expect(m.runLongSql).toHaveBeenCalledTimes(1)
  })
  it("a refusal before the first write runs no undo (it would drop a stranger's index)", async () => {
    m.rows.set('x', { ...row({}) })
    // absent when revalidated, taken by someone else by the time the statement is checked
    m.indexReads = [null, PLAIN_NC, PLAIN_NC]
    const err = await refusal(applyProposal('x', { userId: 'u', dbaOk: false, app }))
    expect(err.message).toMatch(/already exists/)
    expect(m.runLongSql).not.toHaveBeenCalled()
    expect(m.rows.get('x')?.status).toBe('failed')
    expect(String(m.rows.get('x')?.rollback_reason)).toMatch(/nothing ran, no undo/)
  })
  it('a post-change write that throws still ends terminal: failed, change undone', async () => {
    m.rows.set('x', { ...procRow() })
    m.procBody.mockImplementation(async () => PROC_OLD)
    m.failStatus.add('watching')
    await expect(applyProposal('x', { userId: 'u', dbaOk: false, app })).rejects.toThrow(
      /connection reset/
    )
    expect(m.rows.get('x')?.status).toBe('failed')
    expect(String(m.rows.get('x')?.rollback_reason)).toMatch(/connection reset; undo ran/)
    expect(m.run.fail).toHaveBeenCalled()
  })
  it('a watching write that committed before it threw is not undone', async () => {
    m.rows.set('x', { ...procRow() })
    m.procBody.mockImplementation(async () => PROC_OLD)
    m.commitThenFail.add('watching')
    await expect(applyProposal('x', { userId: 'u', dbaOk: false, app })).rejects.toThrow(
      /connection reset/
    )
    // the row says watching: the change stays, and so does the row
    expect(m.rows.get('x')?.status).toBe('watching')
    expect(m.runLongSql).toHaveBeenCalledTimes(1)
  })
  it('a claim the watch already ended as failed is not undone by the apply that wakes up', async () => {
    m.rows.set('x', { ...procRow() })
    m.procBody.mockImplementation(async () => PROC_OLD)
    m.runLongSql.mockImplementation(async () => {
      const r = m.rows.get('x')
      if (r) Object.assign(r, { status: 'failed', rollback_reason: 'apply did not finish' })
      return []
    })
    await expect(applyProposal('x', { userId: 'u', dbaOk: false, app })).rejects.toThrow(
      /left the applying state/
    )
    expect(m.runLongSql).toHaveBeenCalledTimes(1)
    expect(m.rows.get('x')?.rollback_reason).toBe('apply did not finish')
  })
  it('a baseline read that throws does not stop the apply (metric null)', async () => {
    m.rows.set('x', { ...row({}) })
    m.captureBaseline.mockImplementation(async () => {
      throw new Error('dmv denied')
    })
    const out = await applyProposal('x', { userId: 'u', dbaOk: false, app })
    expect(out.status).toBe('watching')
    expect(out.watch_baseline?.before).toEqual({ metric: null })
  })
  it('loses a race to another apply cleanly', async () => {
    m.rows.set('x', { ...row({}) })
    const results = await Promise.allSettled([
      applyProposal('x', { userId: 'u', dbaOk: false, app }),
      applyProposal('x', { userId: 'u', dbaOk: false, app })
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(m.runLongSql).toHaveBeenCalledTimes(1)
    expect(m.run.complete).toHaveBeenCalledWith(expect.stringMatching(/skipped/))
  })
})

describe('rollbackProposal', () => {
  const CREATED = 'CREATE NONCLUSTERED INDEX [idx] ON [workflows] ([project_type])'
  const watchingIndex = () => {
    m.rows.set('x', { ...row({ status: 'watching', applied_by: 'u1' }) })
    m.indexes.workflows.idx = PLAIN_NC
    m.indexDef.mockImplementation(async () => CREATED)
  }

  it('rolls back only a watching or applied row', async () => {
    m.rows.set('x', { ...row({}) })
    expect(
      (await refusal(rollbackProposal('x', { userId: 'u', reason: 'r', app: null }))).code
    ).toBe('TUNING_NOT_APPLICABLE')
  })
  it('runs the undo → rolled_back with the reason, job run and activity', async () => {
    watchingIndex()
    const out = await rollbackProposal('x', { userId: 'u2', reason: 'by admin', app: null })
    expect(out.status).toBe('rolled_back')
    expect(out.rollback_reason).toBe('by admin')
    expect(out.rolled_back_at).toBeTruthy()
    expect(m.runLongSql).toHaveBeenCalledWith('DROP INDEX [idx] ON [workflows]')
    expect(m.startJobRun).toHaveBeenCalledWith('tuning', 'tuning:rollback:x', expect.anything())
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tuning-rollback', item: 'x', user: 'u2' })
    )
  })
  it('two rollbacks at once (admin + watcher): one wins, one undo runs, the row ends rolled_back', async () => {
    watchingIndex()
    const results = await Promise.allSettled([
      rollbackProposal('x', { userId: 'u2', reason: 'by admin', app: null }),
      rollbackProposal('x', { userId: null, reason: 'regressed', app: null })
    ])
    const lost = results.filter((r) => r.status === 'rejected')
    expect(lost).toHaveLength(1)
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'TUNING_NOT_APPLICABLE'
    })
    expect(m.runLongSql).toHaveBeenCalledTimes(1)
    expect(m.rows.get('x')?.status).toBe('rolled_back')
  })
  it('a same-named index rebuilt differently since the apply is not dropped', async () => {
    watchingIndex()
    m.indexDef.mockImplementation(
      async () => 'CREATE NONCLUSTERED INDEX [idx] ON [workflows] ([project_type], [status])'
    )
    expect(
      (await refusal(rollbackProposal('x', { userId: null, reason: 'r', app: null }))).code
    ).toBe('TUNING_STALE')
    expect(m.runLongSql).not.toHaveBeenCalled()
    expect(m.rows.get('x')?.status).toBe('failed')
    expect(String(m.rows.get('x')?.rollback_reason)).toMatch(/rollback refused: the index changed/)
  })
  it('a proc edited since the apply is not clobbered: failed + 409 STALE, nothing runs', async () => {
    m.rows.set('x', { ...procRow({ status: 'watching' }) })
    m.procBody.mockImplementation(async () => 'CREATE PROCEDURE [dbo].[p] AS SELECT 3')
    expect(
      (await refusal(rollbackProposal('x', { userId: null, reason: 'r', app: null }))).code
    ).toBe('TUNING_STALE')
    expect(m.rows.get('x')?.status).toBe('failed')
    expect(String(m.rows.get('x')?.rollback_reason)).toMatch(/rollback refused/)
    expect(m.runLongSql).not.toHaveBeenCalled()
  })
  it('an undo that throws → failed with the error', async () => {
    m.rows.set('x', { ...procRow({ status: 'applied' }) })
    m.procBody.mockImplementation(async () => PROC_NEW)
    m.runLongSql.mockImplementation(async () => {
      throw new Error('deadlock')
    })
    await expect(rollbackProposal('x', { userId: null, reason: 'r', app: null })).rejects.toThrow(
      /deadlock/
    )
    expect(m.rows.get('x')?.status).toBe('failed')
    expect(String(m.rows.get('x')?.rollback_reason)).toMatch(/rollback failed: deadlock/)
    expect(m.run.fail).toHaveBeenCalled()
  })
  it('a final write that throws still leaves the row terminal (failed)', async () => {
    watchingIndex()
    m.failStatus.add('rolled_back')
    await expect(rollbackProposal('x', { userId: null, reason: 'r', app: null })).rejects.toThrow(
      /connection reset/
    )
    expect(m.rows.get('x')?.status).toBe('failed')
  })
})

describe('dismissProposal', () => {
  it('dismisses an open row with the note and logs it', async () => {
    m.rows.set('x', { ...row({ status: 'stale' }) })
    await dismissProposal('x', { userId: 'u', note: 'not now' })
    expect(m.rows.get('x')).toMatchObject({
      status: 'dismissed',
      dismissed_by: 'u',
      dismiss_note: 'not now'
    })
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tuning-dismiss',
        item: 'x',
        comment: expect.stringContaining('not now')
      })
    )
  })
  it('a failed row can be dismissed once a person has looked', async () => {
    m.rows.set('x', { ...row({ status: 'failed' }) })
    await dismissProposal('x', { userId: 'u', note: 'checked by hand' })
    expect(m.rows.get('x')?.status).toBe('dismissed')
  })
  it('refuses an in-flight row', async () => {
    for (const status of ['watching', 'applying', 'applied'] as const) {
      m.rows.set('x', { ...row({ status }) })
      expect((await refusal(dismissProposal('x', { userId: 'u', note: '' }))).code).toBe(
        'TUNING_NOT_APPLICABLE'
      )
    }
  })
})
