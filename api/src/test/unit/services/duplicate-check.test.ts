import { describe, expect, it } from 'vitest'
import {
  type DuplicateConfig,
  type DuplicateDeps,
  findDuplicates,
  groupStatements,
  groupsFor,
  importDriver,
  importDuplicateScan
} from '../../../services/duplicate-check.js'
import {
  CLOSE_ROW_LIMIT,
  type ColumnFacts,
  classifyMatch,
  createdFieldOf,
  type DuplicateCheckSetting,
  filterPredicates,
  foldKey,
  groupStatement,
  normalizeRule,
  type PlanInput,
  type PlannedRule,
  parseDuplicateCheck,
  planDuplicateCheck,
  rulePredicate,
  sqlFoldValue,
  verifyGroup,
  verifyRule
} from '../../../services/duplicate-rules.js'
import type { ItemsQuery, User } from '../../../types.js'

// Rob 2026-11-13: creating "mx480" when "MX480" exists should say so before saving.
// Rob 2026-11-14: on for every collection, per-collection criteria, never scan a big table.

describe('parseDuplicateCheck — old settings keep working', () => {
  it('unset or malformed = ON with the default criteria', () => {
    const def = {
      mode: 'on',
      fields: null,
      rules: null,
      within_days: null,
      ignore_states: null,
      block_exact: false
    }
    expect(parseDuplicateCheck(null)).toEqual(def)
    expect(parseDuplicateCheck('not json')).toEqual(def)
    expect(parseDuplicateCheck({ duplicate_check: [] })).toEqual(def)
    // The 2026-11-13 "auto" (no mode) now means on.
    expect(parseDuplicateCheck({ duplicate_check: { block_exact: true } })).toMatchObject({
      mode: 'on',
      block_exact: true
    })
  })
  it('mode / fields / block_exact read as before', () => {
    expect(
      parseDuplicateCheck(
        JSON.stringify({
          duplicate_check: { mode: 'on', fields: ['name', 'bad name;'], block_exact: true }
        })
      )
    ).toMatchObject({ mode: 'on', fields: ['name'], rules: null, block_exact: true })
    expect(parseDuplicateCheck({ duplicate_check: { mode: 'off' } }).mode).toBe('off')
  })
  it('rules, time limit and ignored states are normalized', () => {
    const s = parseDuplicateCheck({
      duplicate_check: {
        rules: [
          { field: 'vendor', match: 'same' },
          { field: 'amount', match: 'percent', amount: 400 },
          { field: 'lines', match: 'shared', line_field: 'item', amount: '2' },
          { field: 'lines', match: 'shared' },
          { field: 'x;', match: 'exact' },
          { field: 'name', match: 'sounds_like' }
        ],
        within_days: '30',
        ignore_states: ['canceled', '', 'canceled']
      }
    })
    expect(s.rules).toEqual([
      { field: 'vendor', match: 'same' },
      { field: 'amount', match: 'percent', amount: 100 },
      { field: 'lines', match: 'shared', line_field: 'item', amount: 2 }
    ])
    expect(s.within_days).toBe(30)
    expect(s.ignore_states).toEqual(['canceled'])
    expect(normalizeRule({ field: 'due', match: 'days' })).toEqual({
      field: 'due',
      match: 'days',
      amount: 1
    })
  })
})

// ─── Plan ──────────────────────────────────────────────────────────────────

const cols = (types: Record<string, string>, leading: string[] = ['id']): ColumnFacts => ({
  columns: new Map(Object.entries(types)),
  leading: new Set(leading)
})

const TYPES = {
  id: 'int',
  name: 'nvarchar',
  code: 'varchar',
  notes: 'nvarchar',
  amount: 'decimal',
  due: 'date',
  vendor: 'int',
  date_created: 'datetime2'
}

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  collection: 'unit_types',
  setting: parseDuplicateCheck(null),
  template: '{{name}}',
  fields: [
    { field: 'name', type: 'string' },
    { field: 'code', type: 'string', options: { auto_id: { pattern: 'U-{seq}' } } },
    { field: 'notes', type: 'text' },
    { field: 'amount', type: 'decimal', name: 'Amount' },
    { field: 'due', type: 'date' },
    { field: 'vendor', type: 'integer', name: 'Vendor' },
    { field: 'lines', type: 'alias', special: 'o2m' },
    { field: 'date_created', type: 'timestamp', special: 'date-created' }
  ],
  relations: [
    {
      many_collection: 'unit_types',
      many_field: 'vendor',
      one_collection: 'vendors',
      one_field: null,
      junction_field: null
    },
    {
      many_collection: 'unit_lines',
      many_field: 'unit_type',
      one_collection: 'unit_types',
      one_field: 'lines',
      junction_field: null
    }
  ],
  rows: 120,
  kinds: { name: 'unicode', code: 'ansi', notes: 'unicode' },
  columns: cols(TYPES),
  child: () => ({ rows: 500, columns: cols({ id: 'int', unit_type: 'int', item: 'int' }) }),
  ...over
})

const withRules = (rules: unknown[], extra: Record<string, unknown> = {}): DuplicateCheckSetting =>
  parseDuplicateCheck({ duplicate_check: { rules, ...extra } })

describe('planDuplicateCheck — default on, per-collection off', () => {
  it('default: ON for every non-system collection, each label text field on its own', () => {
    const p = planDuplicateCheck(input({ rows: 2_000_000, columns: cols(TYPES, ['id', 'name']) }))
    expect(p).toMatchObject({ enabled: true, source: 'default', big: true, close: false })
    expect(p.groups.map((g) => [g.anchor, g.rules.map((r) => [r.match, r.status])])).toEqual([
      ['name', [['close', 'limited']]]
    ])
    // Several text fields in the label = one check each.
    const two = planDuplicateCheck(input({ template: '{{name}} {{notes}}' }))
    expect(two.groups.map((g) => g.anchor)).toEqual(['name', 'notes'])
  })
  it('generated ids, non-text labels and system tables are not compared; off = never', () => {
    expect(planDuplicateCheck(input({ template: '{{code}}' })).enabled).toBe(false)
    expect(planDuplicateCheck(input({ template: '{{amount}}' })).enabled).toBe(false)
    expect(planDuplicateCheck(input({ collection: 'nivaro_roles' })).enabled).toBe(false)
    const off = planDuplicateCheck(
      input({ setting: parseDuplicateCheck({ duplicate_check: { mode: 'off' } }) })
    )
    expect(off).toMatchObject({ enabled: false, source: 'off' })
  })
  it('legacy fields: the chosen text fields, each on its own', () => {
    const p = planDuplicateCheck(
      input({ setting: parseDuplicateCheck({ duplicate_check: { fields: ['code', 'amount'] } }) })
    )
    expect(p.source).toBe('configured')
    expect(p.groups.map((g) => g.anchor)).toEqual(['code'])
  })
  it('custom rules: one AND set; rules that do not fit the field are listed as invalid', () => {
    const p = planDuplicateCheck(
      input({
        setting: withRules([
          { field: 'vendor', match: 'same' },
          { field: 'amount', match: 'percent', amount: 5 },
          { field: 'name', match: 'equal' },
          { field: 'ghost', match: 'exact' }
        ])
      })
    )
    expect(p.groups).toHaveLength(1)
    expect(p.groups[0].anchor).toBe('vendor')
    expect(p.groups[0].rules.map((r) => [r.field, r.kind, r.status])).toEqual([
      ['vendor', 'relation', 'ok'],
      ['amount', 'number', 'ok']
    ])
    expect(p.invalid.map((i) => i.rule.field)).toEqual(['name', 'ghost'])
  })
  it('created-date field and the time limit', () => {
    const i = input()
    expect(createdFieldOf(i)).toBe('date_created')
    const p = planDuplicateCheck(
      input({ setting: withRules([{ field: 'name', match: 'exact' }], { within_days: 30 }) })
    )
    expect(p.created_field).toBe('date_created')
    const none = planDuplicateCheck(
      input({
        fields: input().fields.filter((f) => f.field !== 'date_created'),
        columns: cols({ ...TYPES, date_created: 'nvarchar' }),
        setting: withRules([{ field: 'name', match: 'exact' }], { within_days: 30 })
      })
    )
    expect(none.created_field).toBeNull()
    expect(none.within_note).toMatch(/No created-date field/)
  })
})

describe('planDuplicateCheck — big tables never scan', () => {
  const big = { rows: CLOSE_ROW_LIMIT + 1 }
  it('exact on a column with no index is skipped, with the reason', () => {
    const p = planDuplicateCheck(
      input({ ...big, setting: withRules([{ field: 'name', match: 'exact' }]) })
    )
    expect(p.enabled).toBe(false)
    expect(p.groups[0].rules[0]).toMatchObject({
      status: 'skipped',
      note: 'No index on Name — exact match skipped'
    })
  })
  it('an indexed rule drives; the others only filter what it finds', () => {
    const p = planDuplicateCheck(
      input({
        ...big,
        columns: cols(TYPES, ['id', 'vendor']),
        setting: withRules([
          { field: 'vendor', match: 'same' },
          { field: 'name', match: 'close' },
          { field: 'notes', match: 'contains' }
        ])
      })
    )
    expect(p.enabled).toBe(true)
    expect(p.groups[0].rules.map((r) => [r.field, r.status, r.near])).toEqual([
      ['vendor', 'ok', false],
      ['name', 'residual', true],
      ['notes', 'residual', true]
    ])
    expect(p.groups[0].rules[1].note).toMatch(/No index on Name — checked only among/)
  })
  it('Contains alone and near matches alone never drive a big table', () => {
    const c = planDuplicateCheck(
      input({
        ...big,
        columns: cols(TYPES, ['id', 'notes']),
        setting: withRules([{ field: 'notes', match: 'contains' }])
      })
    )
    expect(c.groups[0].rules[0]).toMatchObject({
      status: 'skipped',
      note: 'Contains is skipped on tables over 50,000 records'
    })
    const n = planDuplicateCheck(
      input({
        ...big,
        columns: cols(TYPES, ['id', 'name']),
        setting: withRules([{ field: 'name', match: 'close' }])
      })
    )
    expect(n.groups[0].rules[0]).toMatchObject({ status: 'limited', near: false })
  })
  it('shared lines: skipped when the line table is big and its column has no index', () => {
    const rules = [
      { field: 'vendor', match: 'same' },
      { field: 'lines', match: 'shared', line_field: 'item', amount: 2 }
    ]
    const p = planDuplicateCheck(
      input({
        ...big,
        columns: cols(TYPES, ['id', 'vendor']),
        setting: withRules(rules),
        child: () => ({
          rows: 9_000_000,
          columns: cols({ id: 'int', unit_type: 'int', item: 'int' })
        })
      })
    )
    expect(p.groups[0].rules[1]).toMatchObject({
      status: 'skipped',
      note: 'No index on Item in the lines — skipped'
    })
    // The set still runs on the vendor, but its matches are never "exact".
    expect(p.groups[0]).toMatchObject({ runs: true, trimmed: true })
    const indexed = planDuplicateCheck(
      input({
        ...big,
        columns: cols(TYPES, ['id']),
        setting: withRules(rules),
        child: () => ({
          rows: 9_000_000,
          columns: cols({ id: 'int', unit_type: 'int', item: 'int' }, ['id', 'item'])
        })
      })
    )
    expect(indexed.groups[0].rules.map((r) => r.status)).toEqual(['residual', 'ok'])
  })
})

// ─── Verdicts ──────────────────────────────────────────────────────────────

describe('classifyMatch (default text rule)', () => {
  it('exact ignores case and spacing', () => {
    expect(classifyMatch('mx480 ', 'MX480')).toEqual({ match: 'exact', score: 1 })
    expect(classifyMatch('Acme  Corp', 'acme corp')?.match).toBe('exact')
  })
  it('close: punctuation/accents folded, a prefix, a typo in a longer value', () => {
    expect(classifyMatch('MX-480', 'MX480')?.match).toBe('close')
    expect(classifyMatch('Café Supply', 'Cafe Supply')?.match).toBe('close')
    expect(classifyMatch('Acme Corp', 'Acme Corporation')?.match).toBe('close')
    expect(classifyMatch('Transformer', 'Transfomer')?.match).toBe('close')
  })
  it('different short codes and unrelated names are not duplicates', () => {
    expect(classifyMatch('MX480', 'MX481')).toBeNull()
    expect(classifyMatch('Unit A', 'Unit B')).toBeNull()
    expect(classifyMatch('Pumps', 'Valves')).toBeNull()
  })
  it('folding keys', () => {
    expect(foldKey(' mx-480/b ')).toBe('MX480B')
    expect(sqlFoldValue("o'brien & co.")).toBe('OBRIENCO')
  })
})

describe('verifyRule — each rule kind', () => {
  it('text: exact / close / contains', () => {
    expect(verifyRule({ field: 'n', match: 'exact' }, 'mx480', 'MX480')).toMatchObject({
      match: 'exact'
    })
    expect(verifyRule({ field: 'n', match: 'exact' }, 'MX-480', 'MX480')).toBeNull()
    expect(verifyRule({ field: 'n', match: 'close' }, 'MX-480', 'MX480')).toMatchObject({
      match: 'close'
    })
    expect(verifyRule({ field: 'n', match: 'contains' }, 'acme', 'The ACME Co')).toMatchObject({
      match: 'close'
    })
    expect(verifyRule({ field: 'n', match: 'contains' }, 'zed', 'The ACME Co')).toBeNull()
  })
  it('numbers: equal / within ±X% / within ±X', () => {
    expect(verifyRule({ field: 'a', match: 'equal' }, '100', 100)).toMatchObject({ match: 'exact' })
    expect(verifyRule({ field: 'a', match: 'equal' }, 100, 101)).toBeNull()
    expect(verifyRule({ field: 'a', match: 'percent', amount: 5 }, 100, 104.5)).toMatchObject({
      match: 'close'
    })
    expect(verifyRule({ field: 'a', match: 'percent', amount: 5 }, 100, 106)).toBeNull()
    expect(verifyRule({ field: 'a', match: 'within', amount: 10 }, 100, 91)).toMatchObject({
      match: 'close'
    })
    expect(verifyRule({ field: 'a', match: 'within', amount: 10 }, 100, 89)).toBeNull()
  })
  it('dates: same day / within N days', () => {
    expect(
      verifyRule({ field: 'd', match: 'same_day' }, '2026-11-14', new Date('2026-11-14T15:00:00Z'))
    ).toMatchObject({ match: 'exact' })
    expect(verifyRule({ field: 'd', match: 'same_day' }, '2026-11-14', '2026-11-15')).toBeNull()
    expect(
      verifyRule({ field: 'd', match: 'days', amount: 3 }, '2026-11-14', '2026-11-11')
    ).toMatchObject({ match: 'close' })
    expect(
      verifyRule({ field: 'd', match: 'days', amount: 3 }, '2026-11-14', '2026-11-10')
    ).toBeNull()
  })
  it('links: same record (any casing, id or object); lines are judged in SQL', () => {
    expect(verifyRule({ field: 'v', match: 'same' }, { id: 'AB-1' }, 'ab-1')).toMatchObject({
      match: 'exact'
    })
    expect(verifyRule({ field: 'v', match: 'same' }, 7, 8)).toBeNull()
    expect(
      verifyRule({ field: 'l', match: 'shared', line_field: 'i', amount: 2 }, [1, 2], null)
    ).toBe('neutral')
    expect(verifyRule({ field: 'v', match: 'same' }, 7, 7, true)).toMatchObject({ match: 'exact' })
    expect(verifyRule({ field: 'a', match: 'percent', amount: 5 }, 100, 101, true)).toBeNull()
  })
  it('a set is exact only when every rule is, and never when a rule was skipped', () => {
    const g = planDuplicateCheck(
      input({
        setting: withRules([
          { field: 'vendor', match: 'same' },
          { field: 'amount', match: 'percent', amount: 5 }
        ])
      })
    ).groups[0]
    expect(verifyGroup(g, { vendor: 3, amount: 100 }, { vendor: 3, amount: 100 })).toEqual({
      match: 'exact',
      score: 1
    })
    expect(verifyGroup(g, { vendor: 3, amount: 100 }, { vendor: 3, amount: 103 })?.match).toBe(
      'close'
    )
    expect(verifyGroup(g, { vendor: 3, amount: 100 }, { vendor: 4, amount: 100 })).toBeNull()
    expect(
      verifyGroup({ ...g, trimmed: true }, { vendor: 3, amount: 100 }, { vendor: 3, amount: 100 })
        ?.match
    ).toBe('close')
  })
})

// ─── SQL ───────────────────────────────────────────────────────────────────

const rule = (over: Partial<PlannedRule>): PlannedRule => ({
  field: 'name',
  match: 'close',
  kind: 'text',
  status: 'ok',
  indexed: true,
  near: true,
  ...over
})
const P = { mssql: true, kinds: { name: 'unicode' as const } }

describe('rulePredicate / groupStatement', () => {
  it('text close on a small table: exact OR folded; big table: exact only', () => {
    const near = rulePredicate(rule({}), ' mx-480 ', P)
    expect(near?.sql).toMatch(
      /^\(t\.\[name\] = \? OR UPPER\(REPLACE\(.* COLLATE Latin1_General_100_BIN2 = \?\)$/
    )
    expect(near?.bindings).toEqual(['mx-480', 'MX480'])
    expect(rulePredicate(rule({ near: false }), 'mx480', P)).toEqual({
      sql: 't.[name] = ?',
      bindings: ['mx480']
    })
    expect(rulePredicate(rule({}), 'm', P)).toBeNull()
  })
  it('contains, numbers, dates, links, lines', () => {
    expect(rulePredicate(rule({ match: 'contains' }), 'a_b', P)?.bindings).toEqual(['%A\\_B%'])
    expect(
      rulePredicate(rule({ field: 'amount', kind: 'number', match: 'percent', amount: 10 }), 200, P)
    ).toEqual({
      sql: 't.[amount] BETWEEN ? AND ?',
      bindings: [180, 220]
    })
    expect(
      rulePredicate(rule({ field: 'due', kind: 'date', match: 'days', amount: 2 }), '2026-11-14', P)
    ).toEqual({
      sql: 't.[due] >= ? AND t.[due] < ?',
      bindings: ['2026-11-12', '2026-11-17']
    })
    expect(
      rulePredicate(rule({ field: 'vendor', kind: 'relation', match: 'same' }), { id: 9 }, P)
    ).toEqual({
      sql: 't.[vendor] = ?',
      bindings: ['9']
    })
    const lines = rulePredicate(
      rule({
        field: 'lines',
        kind: 'lines',
        match: 'shared',
        amount: 2,
        line_field: 'item',
        child: 'unit_lines',
        fk: 'unit_type'
      }),
      [{ item: 5 }, { item: { id: 6 } }, { item: 5 }],
      { ...P, childAccess: new Map([['unit_lines', null]]) }
    )
    expect(lines?.sql).toContain(
      'FROM [unit_lines] AS l WHERE l.[item] IN (SELECT [value] FROM OPENJSON(?)) GROUP BY l.[unit_type] HAVING COUNT(DISTINCT l.[item]) >= ?'
    )
    expect(lines?.bindings).toEqual(['["5","6"]', 2])
    // Fewer line values than required → nothing to compare.
    expect(
      rulePredicate(
        rule({
          kind: 'lines',
          match: 'shared',
          amount: 3,
          line_field: 'item',
          child: 'c',
          fk: 'f'
        }),
        [1, 2],
        P
      )
    ).toBeNull()
  })
  it('filters: created in the last N days, ignored pipeline states', () => {
    const f = filterPredicates({
      collection: 'unit_types',
      within_days: 30,
      created_field: 'date_created',
      ignore_states: ['canceled'],
      now: new Date('2026-11-14T00:00:00Z')
    })
    expect(f[0]).toEqual({
      sql: 't.[date_created] >= ?',
      bindings: [new Date('2026-10-15T00:00:00Z')]
    })
    expect(f[1].sql).toContain('NOT EXISTS (SELECT 1 FROM [nivaro_workflow_instances]')
    expect(f[1].bindings).toEqual(['unit_types', '["canceled"]'])
  })
  // name has no index here: the scan compares in the binary collation (small table).
  it('a set is one statement: every rule, the filters and the caller gate, AND-ed', () => {
    const g = planDuplicateCheck(
      input({
        setting: withRules([
          { field: 'vendor', match: 'same' },
          { field: 'name', match: 'exact' }
        ])
      })
    ).groups[0]
    const s = groupStatement(
      'unit_types',
      g,
      { vendor: 4, name: 'MX480' },
      {
        mssql: true,
        kinds: { name: 'unicode' },
        filters: [{ sql: 't.[x] = ?', bindings: ['f'] }],
        access: { sql: '[id] IN (SELECT id FROM t WHERE zone = ?)', bindings: ['Z1'] },
        top: 10
      }
    )
    expect(s?.sql).toBe(
      'SELECT TOP 10 CAST(t.[id] AS nvarchar(64)) AS id FROM [unit_types] AS t WHERE (t.[vendor] = ?) AND (UPPER(t.[name]) COLLATE Latin1_General_100_BIN2 = ?) AND (t.[x] = ?) AND (t.[id] IN (SELECT id FROM t WHERE zone = ?))'
    )
    expect(s?.bindings).toEqual(['4', 'MX480', 'f', 'Z1'])
    // A rule the draft leaves empty = no check yet.
    expect(
      groupStatement(
        'unit_types',
        g,
        { name: 'MX480' },
        { ...P, filters: [], access: null, top: 10 }
      )
    ).toBeNull()
  })
})

// ─── The lookup, as the caller ─────────────────────────────────────────────

const cfgFor = (
  over: Partial<PlanInput> = {},
  extra: Partial<DuplicateConfig> = {}
): DuplicateConfig => ({
  ...planDuplicateCheck(input(over)),
  kinds: { name: 'unicode', code: 'ansi', notes: 'unicode' },
  template: '{{name}}',
  label: 'Unit Type',
  collection: 'unit_types',
  fieldLabels: {},
  ...extra
})

function deps(over: Partial<DuplicateDeps> & { rows?: Array<Record<string, unknown>> }) {
  const sqls: string[] = []
  const reads: ItemsQuery[] = []
  const d: DuplicateDeps = {
    config: async () => cfgFor(),
    allowed: async () => null,
    access: async () => ({ sql: '[id] IN (SELECT 1)', bindings: [] }),
    mssql: () => true,
    runner: () => ({
      run: async (_l, sql) => {
        sqls.push(sql)
        return [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 9 }]
      },
      finish: () => {},
      partial: false
    }),
    read: async (_u, _c, q) => {
      reads.push(q)
      const ids = ((q.filter as { id: { _in: string[] } }).id._in ?? []).map(String)
      return (over.rows ?? []).filter((r) => ids.includes(String(r.id)))
    },
    ...over
  }
  return { d, sqls, reads }
}

const user = { id: 'u1', role: 'r1' } as unknown as User

describe('findDuplicates — judged as the caller', () => {
  it('exact first, then close; candidates read again through the items service', async () => {
    const { d, sqls, reads } = deps({
      rows: [
        { id: 1, name: 'MX-480' },
        { id: 2, name: 'MX480' },
        { id: 3, name: 'Router' }
      ]
    })
    const out = await findDuplicates(user, 'unit_types', { name: 'mx480' }, {}, d)
    expect(out.enabled).toBe(true)
    expect(out.matches.name.map((m) => [m.id, m.match])).toEqual([
      ['2', 'exact'],
      ['1', 'close']
    ])
    expect(sqls.length).toBeGreaterThan(0)
    expect(sqls.every((s) => s.includes('[id] IN (SELECT 1)'))).toBe(true)
    expect(reads[0].fields).toEqual(['id', 'name'])
  })
  it('a record the caller may not read never shows (the read drops it)', async () => {
    const { d } = deps({ rows: [{ id: 1, name: 'MX-480' }] })
    const out = await findDuplicates(user, 'unit_types', { name: 'MX480' }, {}, d)
    expect(out.matches.name.map((m) => m.id)).toEqual(['1'])
  })
  it('a set naming a field the caller may not read is never checked', async () => {
    const { d, sqls } = deps({
      allowed: async () => ['id', 'code'],
      rows: [{ id: 2, name: 'MX480' }]
    })
    const out = await findDuplicates(user, 'unit_types', { name: 'MX480' }, {}, d)
    expect(out.enabled).toBe(false)
    expect(out.matches).toEqual({})
    expect(sqls).toEqual([])
  })
  it('the record being edited is excluded; short values are not looked up', async () => {
    const { d } = deps({ rows: [{ id: 2, name: 'MX480' }] })
    expect(
      (await findDuplicates(user, 'unit_types', { name: 'MX480' }, { excludeId: 2 }, d)).matches
    ).toEqual({})
    const { d: d2, sqls } = deps({ rows: [] })
    await findDuplicates(user, 'unit_types', { name: 'M' }, {}, d2)
    expect(sqls).toEqual([])
  })
  it('a big table with an indexed label runs the exact statement only (no typo scan)', async () => {
    const big = cfgFor({ rows: 900_000, columns: cols(TYPES, ['id', 'name']) })
    const { d, sqls } = deps({ config: async () => big, rows: [] })
    await findDuplicates(user, 'unit_types', { name: 'Transformer' }, {}, d)
    expect(sqls).toHaveLength(1)
    expect(sqls[0]).not.toContain('REPLACE')
    // …and with no index on the label, nothing runs at all.
    const none = cfgFor({ rows: 900_000 })
    expect(none.enabled).toBe(false)
  })
  it('off collections answer enabled:false without SQL', async () => {
    const off = cfgFor({ setting: parseDuplicateCheck({ duplicate_check: { mode: 'off' } }) })
    const { d, sqls } = deps({ config: async () => off })
    expect((await findDuplicates(user, 'unit_types', { name: 'MX480' }, {}, d)).enabled).toBe(false)
    expect(sqls).toEqual([])
  })
  it('custom AND rules: one set under its first field; the typo pass keeps the other rules', async () => {
    const c = cfgFor({
      setting: withRules([
        { field: 'name', match: 'close' },
        { field: 'vendor', match: 'same' }
      ])
    })
    const stmts = groupStatements(c, c.groups[0], { name: 'Transformer', vendor: 4 }, null, true)
    expect(stmts.map(([l]) => l)).toEqual(['dup-set', 'dup-typo'])
    expect(stmts[1][1].sql).toContain('t.[vendor] = ?')
    const { d } = deps({
      config: async () => c,
      rows: [
        { id: 1, name: 'Transformer', vendor: 4 },
        { id: 2, name: 'Transformer', vendor: 5 },
        { id: 3, name: 'Transfomer', vendor: 4 }
      ]
    })
    const out = await findDuplicates(user, 'unit_types', { name: 'Transformer', vendor: 4 }, {}, d)
    expect(out.sets).toEqual([{ anchor: 'name', fields: ['name', 'vendor'] }])
    expect(out.matches.name.map((m) => [m.id, m.match])).toEqual([
      ['1', 'exact'],
      ['3', 'close']
    ])
  })
})

// ─── Import preview ────────────────────────────────────────────────────────

describe('importDuplicateScan — import preview uses the same criteria', () => {
  it('counts exact, near and in-file copies among the rows the import creates', async () => {
    const out = await importDuplicateScan(
      'unit_types',
      [
        { row: 2, values: { name: 'MX480' } },
        { row: 3, values: { name: 'mx 480' } },
        { row: 4, values: { name: 'Router-9' } },
        { row: 5, values: { name: 'Brand new' } },
        { row: 6, values: { name: 'brand new ' } },
        { row: 7, values: { name: 'Another' } }
      ],
      {
        config: async () => cfgFor(),
        fetch: async ({ pass, keys }) =>
          pass === 'exact'
            ? keys.some((k) => k.toLowerCase() === 'mx480')
              ? [{ id: 10, name: 'MX480' }]
              : []
            : [
                { id: 11, name: 'Router 9' },
                { id: 10, name: 'MX480' }
              ]
      }
    )
    expect(out).toMatchObject({ exact_rows: 1, close_rows: 2, in_file_rows: 1, fields: ['name'] })
    expect(out?.rows.map((r) => [r.row, r.match, r.existing_id ?? `row ${r.first_row}`])).toEqual([
      [2, 'exact', '10'],
      [3, 'close', '10'],
      [4, 'close', '11'],
      [6, 'exact', 'row 5']
    ])
  })
  it('AND rules: looked up by the text rule, the other rules checked per row', async () => {
    const c = cfgFor({
      setting: withRules([
        { field: 'vendor', match: 'same' },
        { field: 'name', match: 'exact' }
      ])
    })
    expect((importDriver(c.groups[0]) as PlannedRule).field).toBe('name')
    const out = await importDuplicateScan(
      'unit_types',
      [
        { row: 2, values: { name: 'MX480', vendor: 1 } },
        { row: 3, values: { name: 'MX480', vendor: 2 } }
      ],
      { config: async () => c, fetch: async () => [{ id: 10, name: 'MX480', vendor: 1 }] }
    )
    expect(out?.rows.map((r) => [r.row, r.field, r.existing_id])).toEqual([[2, 'vendor', '10']])
  })
  it('null when nothing is checked; lines rules are named as not checked', async () => {
    const off = cfgFor({ setting: parseDuplicateCheck({ duplicate_check: { mode: 'off' } }) })
    expect(
      await importDuplicateScan('unit_types', [{ row: 2, values: { name: 'x' } }], {
        config: async () => off
      })
    ).toBeNull()
    expect(
      await importDuplicateScan('unit_types', [{ row: 2, values: { code: 'x' } }], {
        config: async () => cfgFor()
      })
    ).toBeNull()
    const lines = cfgFor({
      setting: withRules([
        { field: 'name', match: 'exact' },
        { field: 'lines', match: 'shared', line_field: 'item' }
      ])
    })
    const out = await importDuplicateScan(
      'unit_types',
      [{ row: 2, values: { name: 'x', lines: [] } }],
      {
        config: async () => lines,
        fetch: async () => []
      }
    )
    expect(out?.skipped?.[0]).toMatch(/compares lines/)
  })
})

// ─── Shared lines, as the caller (security review 2026-11-14) ──────────────

describe('shared lines are judged as the caller', () => {
  const linesCfg = () =>
    cfgFor({
      setting: withRules([
        { field: 'vendor', match: 'same' },
        { field: 'lines', match: 'shared', line_field: 'item', amount: 2 }
      ])
    })
  const lineRule = (): PlannedRule => linesCfg().groups[0].rules[1]
  const zoneGate = { sql: '[id] IN (SELECT id FROM unit_lines WHERE zone = ?)', bindings: ['Z1'] }

  it('no read gate known for the line collection → the rule compares nothing', () => {
    expect(rulePredicate(lineRule(), [1, 2], P)).toBeNull()
  })
  it('a row-filtered line collection: hidden lines are never counted', () => {
    const s = rulePredicate(lineRule(), [{ item: 1 }, { item: 2 }], {
      ...P,
      childAccess: new Map([['unit_lines', zoneGate]])
    })
    expect(s?.sql).toContain(
      'WHERE l.[item] IN (SELECT [value] FROM OPENJSON(?)) AND (l.[id] IN (SELECT id FROM unit_lines WHERE zone = ?)) GROUP BY l.[unit_type]'
    )
    expect(s?.bindings).toEqual(['["1","2"]', 'Z1', 2])
  })
  it('the set is dropped unless the caller may read the link back and the line field', () => {
    const c = linesCfg()
    expect(groupsFor(c, null)).toEqual([])
    expect(groupsFor(c, null, new Map([['unit_lines', []]]))).toEqual([])
    expect(groupsFor(c, null, new Map([['unit_lines', ['id', 'item']]]))).toEqual([])
    expect(groupsFor(c, null, new Map([['unit_lines', ['unit_type', 'item']]]))).toHaveLength(1)
    expect(groupsFor(c, null, new Map([['unit_lines', null]]))).toHaveLength(1)
  })
  it('findDuplicates: unreadable line collection → no check, no SQL', async () => {
    const { d, sqls } = deps({
      config: async () => linesCfg(),
      allowed: async (_u, c) => (c === 'unit_lines' ? [] : null)
    })
    const out = await findDuplicates(user, 'unit_types', { vendor: 4, lines: [1, 2] }, {}, d)
    expect(out.enabled).toBe(false)
    expect(sqls).toEqual([])
  })
  it('findDuplicates: the line collection gate rides inside the lines subquery', async () => {
    const { d, sqls } = deps({
      config: async () => linesCfg(),
      access: async (_u, c) => (c === 'unit_lines' ? zoneGate : null)
    })
    await findDuplicates(user, 'unit_types', { vendor: 4, lines: [1, 2] }, {}, d)
    expect(sqls).toHaveLength(1)
    expect(sqls[0]).toContain('AND (l.[id] IN (SELECT id FROM unit_lines WHERE zone = ?))')
  })
})
