import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../../db/index.js'
import {
  bracketedList,
  indexDefinition,
  indexKeyLists,
  indexNamesInModules,
  missingIndexGroups,
  redundantIndexes,
  statementsTouching,
  unbracket
} from '../../../../services/db-tuning/dmv.js'
import {
  observeIndexCreate,
  parsePlanMissingIndexes
} from '../../../../services/db-tuning/observers/index-create.js'
import {
  loadIndexDropEvidence,
  observeIndexDrop,
  recentlyCreatedKeys
} from '../../../../services/db-tuning/observers/index-drop.js'
import type { ApplySpec } from '../../../../services/db-tuning/types.js'

vi.mock('../../../../db/dialect.js', () => ({ isMssql: () => true }))
vi.mock('../../../../services/replication.js', () => ({ isReplicatedArticle: async () => false }))

type Raw = ReturnType<typeof db.raw>

const base = {
  planMissing: [],
  existing: [],
  uptimeDays: 40,
  replicated: new Set<string>()
}
const dmvRow = (table: string, equality: string[], over: Record<string, unknown> = {}) => ({
  table,
  equality,
  inequality: [],
  seeks: 9,
  scans: 0,
  avg_impact: 90,
  avg_cost: 9,
  ...over
})
/** Drop-evidence fields the brief's original tests predate. */
const dropBase = {
  since: '2026-08-20',
  recentlyCreated: new Set<string>(),
  hinted: new Set<string>()
}

describe('observeIndexCreate', () => {
  it('merges a config candidate and a DMV missing index on the same column into one proposal', () => {
    const out = observeIndexCreate({
      ...base,
      config: [
        {
          table: 'workflows',
          column: 'project_type',
          rows: 85000,
          reasons: ['M2O foreign key'],
          create_sql:
            'CREATE NONCLUSTERED INDEX idx_workflows_project_type ON [workflows] ([project_type])',
          live: { filter: 12, sort: 0, ops: ['_eq'] }
        }
      ],
      missing: [
        {
          table: 'workflows',
          equality: ['project_type'],
          inequality: [],
          seeks: 400,
          scans: 0,
          avg_impact: 80,
          avg_cost: 12.5
        }
      ]
    })
    expect(out).toHaveLength(1)
    expect(out[0].target).toBe('workflows.project_type')
    expect(out[0].apply).toEqual({
      type: 'sql',
      statements: [
        'CREATE NONCLUSTERED INDEX idx_workflows_project_type ON [workflows] ([project_type])'
      ]
    })
    expect(out[0].undo).toEqual({
      type: 'sql',
      statements: ['DROP INDEX [idx_workflows_project_type] ON [workflows]']
    })
    expect(out[0].estimate_ms_per_day).toBeGreaterThan(0)
    expect(out[0].evidence.sources as string[]).toEqual(expect.arrayContaining(['config', 'dmv']))
  })
  it('never proposes three or more key columns', () => {
    const out = observeIndexCreate({
      ...base,
      config: [],
      missing: [
        {
          table: 't',
          equality: ['a', 'b', 'c'],
          inequality: [],
          seeks: 9,
          scans: 0,
          avg_impact: 90,
          avg_cost: 9
        }
      ]
    })
    expect(out).toEqual([])
  })
  it('flags a replicated table', () => {
    const out = observeIndexCreate({
      ...base,
      replicated: new Set(['workflows']),
      config: [],
      missing: [
        {
          table: 'workflows',
          equality: ['x'],
          inequality: [],
          seeks: 9,
          scans: 0,
          avg_impact: 90,
          avg_cost: 9
        }
      ]
    })
    expect(out[0].replicated).toBe(true)
  })
  it('declines a DMV (a) INCLUDE (x,y) when an index on (a) exists', () => {
    const out = observeIndexCreate({
      ...base,
      existing: [{ table: 'T', index: 'ix_a', keys: ['A'] }],
      config: [],
      missing: [dmvRow('t', ['a'], { include: ['x', 'y'] })]
    })
    expect(out).toEqual([])
  })
  it('declines keys that lead an existing index, not keys an existing index merely contains', () => {
    const missing = [dmvRow('t', ['a'])]
    const on = (keys: string[]) => [{ table: 't', index: 'ix', keys }]
    expect(observeIndexCreate({ ...base, existing: on(['a', 'b']), config: [], missing })).toEqual(
      []
    )
    expect(
      observeIndexCreate({ ...base, existing: on(['b', 'a']), config: [], missing })
    ).toHaveLength(1)
    // the advisor's own name already on the table → CREATE would fail
    const named = [{ table: 't', index: 'idx_t_a', keys: ['z'] }]
    expect(observeIndexCreate({ ...base, existing: named, config: [], missing })).toEqual([])
  })
  it('proposes nothing when existing indexes could not be read', () => {
    expect(
      observeIndexCreate({ ...base, existing: null, config: [], missing: [dmvRow('t', ['a'])] })
    ).toEqual([])
  })
  it('merges (collection,item) and (item,collection) into one proposal in the first order seen', () => {
    const out = observeIndexCreate({
      ...base,
      config: [
        {
          table: 'notes',
          column: 'collection,item',
          rows: 90000,
          reasons: ['pair'],
          create_sql: ''
        }
      ],
      missing: [dmvRow('notes', ['item', 'collection'])]
    })
    expect(out).toHaveLength(1)
    expect(out[0].change_key).toBe('collection,item')
    expect(out[0].evidence.sources).toEqual(['config', 'dmv'])
  })
  it('keeps one proposal when two column lists produce the same index name', () => {
    const out = observeIndexCreate({
      ...base,
      config: [],
      missing: [dmvRow('t', ['a_b']), dmvRow('t', ['a', 'b'])]
    })
    expect(out.map((c) => c.change_key)).toEqual(['a_b'])
  })
})

describe('parsePlanMissingIndexes', () => {
  // Shape of a real SQL Server ShowPlan <MissingIndexes> block.
  const xml = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.564">
  <BatchSequence><Batch><Statements><StmtSimple StatementType="SELECT"><QueryPlan>
  <MissingIndexes>
    <MissingIndexGroup Impact="87.4">
      <MissingIndex Database="[nivaro]" Schema="[dbo]" Table="[invoices]">
        <ColumnGroup Usage="EQUALITY">
          <Column Name="[vendor]" ColumnId="3" />
        </ColumnGroup>
        <ColumnGroup Usage="INEQUALITY">
          <Column Name="[status]" ColumnId="5" />
        </ColumnGroup>
        <ColumnGroup Usage="INCLUDE">
          <Column Name="[amount]" ColumnId="7" />
          <Column Name="[posted_at]" ColumnId="9" />
        </ColumnGroup>
      </MissingIndex>
    </MissingIndexGroup>
    <MissingIndexGroup Impact="40.1">
      <MissingIndex Database="[other_db]" Schema="[dbo]" Table="[invoices]">
        <ColumnGroup Usage="EQUALITY"><Column Name="[vendor]" ColumnId="3" /></ColumnGroup>
      </MissingIndex>
    </MissingIndexGroup>
    <MissingIndexGroup Impact="40.1">
      <MissingIndex Database="[nivaro]" Schema="[audit]" Table="[invoices]">
        <ColumnGroup Usage="EQUALITY"><Column Name="[vendor]" ColumnId="3" /></ColumnGroup>
      </MissingIndex>
    </MissingIndexGroup>
    <MissingIndexGroup Impact="30">
      <MissingIndex Database="[nivaro]" Schema="[dbo]" Table="[orders]">
        <ColumnGroup Usage="EQUALITY"><Column Name="[a]]b]" ColumnId="2" /></ColumnGroup>
      </MissingIndex>
    </MissingIndexGroup>
  </MissingIndexes>
  </QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`
  it('keeps only the current database and default schema; EQUALITY+INEQUALITY are keys', () => {
    expect(parsePlanMissingIndexes(xml, { database: 'Nivaro', schema: 'dbo' })).toEqual([
      { table: 'invoices', columns: ['vendor', 'status'], include: ['amount', 'posted_at'] }
    ])
  })
  it('feeds the observer as a plan source', () => {
    const planMissing = parsePlanMissingIndexes(xml, { database: 'nivaro', schema: 'dbo' }).map(
      (p) => ({ slug: 'spend', ...p })
    )
    const out = observeIndexCreate({ ...base, config: [], missing: [], planMissing })
    expect(out).toHaveLength(1)
    expect(out[0].target).toBe('invoices.vendor,status')
    expect(out[0].evidence.requested_include).toEqual(['amount', 'posted_at'])
  })
  it('a plan without missing indexes contributes nothing', () => {
    expect(parsePlanMissingIndexes('<ShowPlanXML/>', { database: 'n', schema: 'dbo' })).toEqual([])
  })
})

describe('bracket parsing', () => {
  afterEach(() => vi.mocked(db.raw).mockReset())
  it('strips brackets only around one IDENT', () => {
    expect(unbracket('[vendor]')).toBe('vendor')
    expect(unbracket(' [vendor] ')).toBe('vendor')
    expect(unbracket('[a]]b]')).toBeNull()
    expect(unbracket('vendor')).toBeNull()
    expect(unbracket('[a b]')).toBeNull()
    expect(bracketedList('[a], [b]')).toEqual(['a', 'b'])
    expect(bracketedList('[a], [b]]c]')).toBeNull()
    expect(bracketedList(null)).toEqual([])
  })
  it('missingIndexGroups drops a row with a name it cannot read exactly', async () => {
    vi.mocked(db.raw).mockReturnValue(
      Promise.resolve([
        { table_name: 't', equality_columns: '[a]]b]', user_seeks: 5 },
        { table_name: 't', equality_columns: '[a]', included_columns: '[x], [y]', user_seeks: 5 }
      ]) as unknown as Raw
    )
    const out = await missingIndexGroups()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ equality: ['a'], inequality: [], include: ['x', 'y'] })
  })
})

describe('observeIndexDrop', () => {
  const usage = [
    {
      table: 'workflows',
      index: 'ix_old',
      reads: 0,
      writes: 50000,
      size_mb: 120,
      unique: false,
      pk: false,
      type: 'NONCLUSTERED'
    }
  ]
  const defs = new Map([
    ['workflows.ix_old', 'CREATE NONCLUSTERED INDEX [ix_old] ON [workflows] ([legacy_col])']
  ])
  it('proposes nothing when the server restarted 3 days ago', () => {
    expect(
      observeIndexDrop({
        ...dropBase,
        usage,
        redundant: [],
        uptimeDays: 3,
        fkBacked: new Set(),
        definitions: defs,
        replicated: new Set()
      })
    ).toEqual([])
  })
  it('proposes a drop with the rebuilt CREATE as undo after 30 days of zero reads', () => {
    const out = observeIndexDrop({
      ...dropBase,
      usage,
      redundant: [],
      uptimeDays: 31,
      fkBacked: new Set(),
      definitions: defs,
      replicated: new Set()
    })
    expect(out[0].apply).toEqual({
      type: 'sql',
      statements: ['DROP INDEX [ix_old] ON [workflows]']
    })
    expect(out[0].undo).toEqual({ type: 'sql', statements: [defs.get('workflows.ix_old')] })
    expect(out[0].title).toBe('Drop workflows.ix_old — 50,000 writes, no reads since 2026-08-20')
    expect(out[0].evidence).toMatchObject({ uptime_days: 31, since: '2026-08-20' })
  })
  it('skips an index backing a foreign key, and one with reads', () => {
    expect(
      observeIndexDrop({
        ...dropBase,
        usage,
        redundant: [],
        uptimeDays: 31,
        fkBacked: new Set(['workflows.ix_old']),
        definitions: defs,
        replicated: new Set()
      })
    ).toEqual([])
    expect(
      observeIndexDrop({
        ...dropBase,
        usage: [{ ...usage[0], reads: 1 }],
        redundant: [],
        uptimeDays: 31,
        fkBacked: new Set(),
        definitions: defs,
        replicated: new Set()
      })
    ).toEqual([])
  })
})

describe('observeIndexDrop guards', () => {
  const row = {
    table: 'workflows',
    index: 'ix_old',
    reads: 0,
    writes: 50000,
    size_mb: 120,
    unique: false,
    pk: false,
    type: 'NONCLUSTERED'
  }
  const ev = (over: Partial<typeof row>, definitions = new Map<string, string>()) => ({
    ...dropBase,
    usage: [{ ...row, ...over }],
    redundant: [] as Array<{ table: string; index: string; covered_by: string }>,
    uptimeDays: 31,
    fkBacked: new Set<string>(),
    definitions,
    replicated: new Set<string>()
  })
  const wide = { ...row, index: 'ix_wide', reads: 900 }
  const def = new Map([
    ['workflows.ix_old', 'CREATE NONCLUSTERED INDEX [ix_old] ON [workflows] ([a])']
  ])
  it('never proposes without a rebuilt CREATE to undo with', () => {
    expect(observeIndexDrop(ev({}))).toEqual([])
  })
  it('never proposes unique, clustered, or non-identifier indexes', () => {
    expect(observeIndexDrop(ev({ unique: true }, def))).toEqual([])
    expect(observeIndexDrop(ev({ type: 'CLUSTERED' }, def))).toEqual([])
    const odd = new Map([
      ['workflows.ix]x', 'CREATE NONCLUSTERED INDEX [ix]x] ON [workflows] ([a])']
    ])
    expect(observeIndexDrop(ev({ index: 'ix]x' }, odd))).toEqual([])
  })
  it('proposes a redundant prefix index even with reads', () => {
    const e = ev({ reads: 900 }, def)
    const out = observeIndexDrop({
      ...e,
      usage: [...e.usage, wide],
      redundant: [{ table: 'workflows', index: 'ix_old', covered_by: 'ix_wide' }]
    })
    expect(out).toHaveLength(1)
    expect(out[0].title).toContain('prefix of ix_wide')
  })
  it('a used ix_a beside a disabled (a,b) is not proposed: the coverer is not a live index', () => {
    // indexUsage lists live indexes only, so the disabled (a,b) is absent from usage.
    const out = observeIndexDrop({
      ...ev({ index: 'ix_a', reads: 500 }, new Map([['workflows.ix_a', 'CREATE …']])),
      redundant: [{ table: 'workflows', index: 'ix_a', covered_by: 'ix_ab_disabled' }]
    })
    expect(out).toEqual([])
  })
  it('never proposes an index the ledger created recently, or one a module mentions', () => {
    expect(
      observeIndexDrop({ ...ev({}, def), recentlyCreated: new Set(['workflows.ix_old']) })
    ).toEqual([])
    expect(observeIndexDrop({ ...ev({}, def), hinted: new Set(['ix_old']) })).toEqual([])
    expect(observeIndexDrop({ ...ev({}, def), since: null })).toEqual([])
  })
})

describe('recentlyCreatedKeys', () => {
  const now = Date.parse('2026-10-05T00:00:00Z')
  const undo = (t: string, i: string): ApplySpec => ({
    type: 'sql',
    statements: [`DROP INDEX [${i}] ON [${t}]`]
  })
  const row = (over: Record<string, unknown>) => ({
    kind: 'index_create' as const,
    status: 'applied' as const,
    target: 'workflows.status',
    applied_at: '2026-09-20T00:00:00Z',
    undo: undo('workflows', 'idx_workflows_status'),
    ...over
  })
  it('names indexes applied or watching within 60 days, from undo and target', () => {
    const keys = recentlyCreatedKeys(
      [
        row({}),
        row({ status: 'watching', target: 'notes.collection,item', undo: undo('notes', 'ix_n') }),
        row({ target: 'old.col', undo: undo('old', 'idx_old_col'), applied_at: '2026-07-01' }),
        row({ status: 'rolled_back', target: 'rb.col', undo: undo('rb', 'idx_rb_col') }),
        row({ target: 'nodate.c', undo: undo('nodate', 'idx_nodate_c'), applied_at: null })
      ],
      now
    )
    expect([...keys].sort()).toEqual([
      'nodate.idx_nodate_c',
      'notes.idx_notes_collection_item',
      'notes.ix_n',
      'workflows.idx_workflows_status'
    ])
  })
})

describe('loadIndexDropEvidence', () => {
  afterEach(() => {
    vi.mocked(db.raw).mockReset()
    vi.mocked(db).mockClear()
  })
  const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000)
  const usageRow = (index: string, reads: number, writes: number) => ({
    table_name: 'workflows',
    index_name: index,
    type_desc: 'NONCLUSTERED',
    is_unique: false,
    is_primary_key: false,
    is_unique_constraint: false,
    reads,
    writes,
    size_mb: 1
  })
  const stubRaw = () => {
    const raw = vi.mocked(db.raw)
    raw.mockImplementation(((sql: string) => {
      if (sql.includes('sqlserver_start_time')) return Promise.resolve([{ t: fortyDaysAgo }])
      if (sql.includes('sys.sql_modules')) return Promise.resolve([{ name: 'ix_hint' }])
      if (sql.includes('WITH keys AS') || sql.includes('sys.foreign_keys'))
        return Promise.resolve([])
      if (sql.includes('OBJECT_ID(?)'))
        return Promise.resolve([
          {
            name: 'a',
            key_ordinal: 1,
            is_included_column: false,
            is_descending_key: false,
            type_desc: 'NONCLUSTERED',
            data_space: 'PRIMARY',
            data_space_type: 'FG',
            data_space_default: true,
            compression: 'NONE'
          }
        ])
      if (sql.includes('dm_db_index_usage_stats'))
        return Promise.resolve([
          usageRow('ix_quiet', 0, 50),
          usageRow('ix_dead', 0, 5000),
          usageRow('ix_hint', 0, 5000)
        ])
      return Promise.resolve([])
    }) as unknown as typeof db.raw)
    return raw
  }
  it('reads definitions only for qualifying, unhinted indexes; one module query for all', async () => {
    const raw = stubRaw()
    const ev = await loadIndexDropEvidence()
    const calls = raw.mock.calls as unknown as Array<[string, unknown[]?]>
    const moduleCalls = calls.filter(([sql]) => sql.includes('sys.sql_modules'))
    expect(moduleCalls).toHaveLength(1)
    // ix_quiet (50 writes) is below MIN_WRITES and never even checked
    expect(moduleCalls[0][1]).toEqual(['ix_dead', 'ix_hint'])
    const defCalls = calls.filter(([sql]) => sql.includes('OBJECT_ID(?)'))
    expect(defCalls.map(([, b]) => b)).toEqual([['workflows', 'ix_dead']])
    expect(ev.since).toBe(fortyDaysAgo.toISOString().slice(0, 10))
    expect(observeIndexDrop(ev).map((c) => c.target)).toEqual(['workflows.ix_dead'])
  })
  it('proposes nothing when the ledger cannot be read', async () => {
    stubRaw()
    vi.mocked(db).mockImplementationOnce((() => {
      throw new Error('ledger down')
    }) as never)
    const ev = await loadIndexDropEvidence()
    expect(ev.definitions.size).toBe(0)
    expect(observeIndexDrop(ev)).toEqual([])
  })
})

describe('indexNamesInModules', () => {
  afterEach(() => vi.mocked(db.raw).mockReset())
  it('asks once for every valid name, lower-cased, and fails to null', async () => {
    vi.mocked(db.raw).mockReturnValue(Promise.resolve([{ name: 'IX_B' }]) as unknown as Raw)
    const out = await indexNamesInModules(['IX_A', 'ix_b', 'bad name', 'ix_a'])
    expect(vi.mocked(db.raw)).toHaveBeenCalledTimes(1)
    const [sql, binds] = vi.mocked(db.raw).mock.calls[0] as unknown as [string, string[]]
    expect(sql).toContain('(VALUES (?), (?))')
    expect(binds).toEqual(['ix_a', 'ix_b'])
    expect([...(out ?? [])]).toEqual(['ix_b'])
    vi.mocked(db.raw).mockReturnValue(Promise.reject(new Error('denied')) as unknown as Raw)
    expect(await indexNamesInModules(['ix_a'])).toBeNull()
  })
})

describe('indexDefinition', () => {
  afterEach(() => vi.mocked(db.raw).mockReset())
  const idx = {
    type_desc: 'NONCLUSTERED',
    is_unique: false,
    is_primary_key: false,
    is_unique_constraint: false,
    is_disabled: false,
    is_hypothetical: false,
    has_filter: false,
    filter_definition: null as string | null,
    fill_factor: 0,
    is_padded: false,
    ignore_dup_key: false,
    allow_row_locks: true,
    allow_page_locks: true,
    data_space: 'PRIMARY',
    data_space_type: 'FG',
    data_space_default: true,
    compression: 'NONE',
    no_recompute: false
  }
  const col = (name: string, key: number, incl = false, desc = false) => ({
    ...idx,
    name,
    key_ordinal: key,
    is_included_column: incl,
    is_descending_key: desc
  })
  const answer = (rows: unknown[]) =>
    vi.mocked(db.raw).mockReturnValue(Promise.resolve(rows) as unknown as Raw)

  it('rebuilds keys in key order with DESC, INCLUDE columns, filter and UNIQUE', async () => {
    answer(
      [col('b', 2, false, true), col('a', 1), col('c', 0, true)].map((r) => ({
        ...r,
        is_unique: true,
        has_filter: true,
        filter_definition: "([status]='open')"
      }))
    )
    expect(await indexDefinition('workflows', 'ix_ab')).toBe(
      "CREATE UNIQUE NONCLUSTERED INDEX [ix_ab] ON [workflows] ([a], [b] DESC) INCLUDE ([c]) WHERE ([status]='open')"
    )
    expect(vi.mocked(db.raw).mock.calls[0][1]).toEqual(['workflows', 'ix_ab'])
  })
  it('carries fill factor, compression and a non-default filegroup', async () => {
    answer([
      {
        ...col('a', 1),
        fill_factor: 80,
        compression: 'PAGE',
        data_space: 'INDEXES',
        data_space_default: false
      }
    ])
    expect(await indexDefinition('t', 'ix')).toBe(
      'CREATE NONCLUSTERED INDEX [ix] ON [t] ([a]) WITH (FILLFACTOR = 80, DATA_COMPRESSION = PAGE) ON [INDEXES]'
    )
  })
  it('refuses what it cannot reproduce', async () => {
    answer([col('a', 1), col('part_col', 0)])
    expect(await indexDefinition('t', 'ix')).toBeNull()
    answer([{ ...col('a', 1), data_space_type: 'PS' }])
    expect(await indexDefinition('t', 'ix')).toBeNull()
    answer([{ ...col('a', 1), is_disabled: true }])
    expect(await indexDefinition('t', 'ix')).toBeNull()
    answer([{ ...col('a', 1), is_unique_constraint: true }])
    expect(await indexDefinition('t', 'ix')).toBeNull()
    answer([{ ...col('a', 1), has_filter: true }])
    expect(await indexDefinition('t', 'ix')).toBeNull()
    answer([col('we]ird', 1)])
    expect(await indexDefinition('t', 'ix')).toBeNull()
    answer([])
    expect(await indexDefinition('t', 'ix')).toBeNull()
  })
  it('never queries for a name outside IDENT, and fails to null on error', async () => {
    expect(await indexDefinition('t]; DROP TABLE x --', 'ix')).toBeNull()
    expect(vi.mocked(db.raw)).not.toHaveBeenCalled()
    vi.mocked(db.raw).mockReturnValue(Promise.reject(new Error('denied')) as unknown as Raw)
    expect(await indexDefinition('t', 'ix')).toBeNull()
  })
})

describe('dmv readers', () => {
  afterEach(() => vi.mocked(db.raw).mockReset())
  it('redundantIndexes keeps the widest covering index per redundant index', async () => {
    vi.mocked(db.raw).mockReturnValue(
      Promise.resolve([
        { table_name: 't', index_name: 'ix_a', covered_by: 'ix_ab', covered_keys: 'a,b' },
        { table_name: 't', index_name: 'ix_a', covered_by: 'ix_abc', covered_keys: 'a,b,c' }
      ]) as unknown as Raw
    )
    expect(await redundantIndexes()).toEqual([{ table: 't', index: 'ix_a', covered_by: 'ix_abc' }])
  })
  it('redundantIndexes counts only live coverers in the default schema', async () => {
    vi.mocked(db.raw).mockReturnValue(Promise.resolve([]) as unknown as Raw)
    await redundantIndexes()
    const sql = String(vi.mocked(db.raw).mock.calls[0][0])
    const cte = sql.slice(sql.indexOf('WITH keys AS'), sql.indexOf('SELECT t.name'))
    expect(cte).toContain('i.is_hypothetical = 0 AND i.is_disabled = 0')
    expect(sql).toContain('SCHEMA_NAME(t.schema_id) = SCHEMA_NAME()')
  })
  it('indexKeyLists groups key columns per index in key order, null on error', async () => {
    vi.mocked(db.raw).mockReturnValue(
      Promise.resolve([
        { table_name: 't', index_name: 'ix', column_name: 'a' },
        { table_name: 't', index_name: 'ix', column_name: 'b' },
        { table_name: 't', index_name: 'pk', column_name: 'id' }
      ]) as unknown as Raw
    )
    expect(await indexKeyLists()).toEqual([
      { table: 't', index: 'ix', keys: ['a', 'b'] },
      { table: 't', index: 'pk', keys: ['id'] }
    ])
    vi.mocked(db.raw).mockReturnValue(Promise.reject(new Error('denied')) as unknown as Raw)
    expect(await indexKeyLists()).toBeNull()
  })
  it('statementsTouching leaves out proof twins with an escaped LIKE', async () => {
    vi.mocked(db.raw).mockReturnValue(Promise.resolve([]) as unknown as Raw)
    await statementsTouching('workflows', 'status')
    const [sql, binds] = vi.mocked(db.raw).mock.calls[0] as unknown as [string, string[]]
    expect(sql).toContain("NOT LIKE '%[_][_]tune%'")
    expect(binds).toEqual(['%\\[workflows\\]%', '%\\[status\\]%'])
    expect(await statementsTouching('bad name', 'status')).toEqual([])
  })
})
