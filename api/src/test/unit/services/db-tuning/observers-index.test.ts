import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../../db/index.js'
import {
  indexDefinition,
  redundantIndexes,
  statementsTouching
} from '../../../../services/db-tuning/dmv.js'
import {
  observeIndexCreate,
  parsePlanMissingIndex
} from '../../../../services/db-tuning/observers/index-create.js'
import { observeIndexDrop } from '../../../../services/db-tuning/observers/index-drop.js'

vi.mock('../../../../db/dialect.js', () => ({ isMssql: () => true }))

const base = { planMissing: [], uptimeDays: 40, replicated: new Set<string>() }

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
  it('parses a SHOWPLAN missing-index line', () => {
    expect(
      parsePlanMissingIndex(
        'CREATE NONCLUSTERED INDEX [<Name of Missing Index>] ON [dbo].[invoices] ([vendor],[status])'
      )
    ).toEqual({ table: 'invoices', columns: ['vendor', 'status'] })
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
  })
  it('skips an index backing a foreign key, and one with reads', () => {
    expect(
      observeIndexDrop({
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
    usage: [{ ...row, ...over }],
    redundant: [] as Array<{ table: string; index: string; covered_by: string }>,
    uptimeDays: 31,
    fkBacked: new Set<string>(),
    definitions,
    replicated: new Set<string>()
  })
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
    const out = observeIndexDrop({
      ...ev({ reads: 900 }, def),
      redundant: [{ table: 'workflows', index: 'ix_old', covered_by: 'ix_wide' }]
    })
    expect(out).toHaveLength(1)
    expect(out[0].title).toContain('prefix of ix_wide')
  })
})

type Raw = ReturnType<typeof db.raw>

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
  it('statementsTouching leaves out proof twins with an escaped LIKE', async () => {
    vi.mocked(db.raw).mockReturnValue(Promise.resolve([]) as unknown as Raw)
    await statementsTouching('workflows', 'status')
    const [sql, binds] = vi.mocked(db.raw).mock.calls[0] as unknown as [string, string[]]
    expect(sql).toContain("NOT LIKE '%[_][_]tune%'")
    expect(binds).toEqual(['%\\[workflows\\]%', '%\\[status\\]%'])
    expect(await statementsTouching('bad name', 'status')).toEqual([])
  })
})
