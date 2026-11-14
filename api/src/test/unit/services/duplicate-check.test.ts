import { describe, expect, it } from 'vitest'
import {
  AUTO_ROW_LIMIT,
  classifyMatch,
  type DuplicateConfig,
  type DuplicateDeps,
  exactStatement,
  findDuplicates,
  foldKey,
  foldStatement,
  importDuplicateScan,
  parseDuplicateCheck,
  resolveDuplicateFields,
  sqlFoldValue
} from '../../../services/duplicate-check.js'
import type { ItemsQuery, User } from '../../../types.js'

// Rob 2026-11-13: creating "mx480" when "MX480" exists should say so before saving.

describe('parseDuplicateCheck', () => {
  it('unset or malformed = auto; mode/fields/block read from JSON text or an object', () => {
    expect(parseDuplicateCheck(null)).toEqual({ mode: 'auto', fields: null, block_exact: false })
    expect(parseDuplicateCheck('not json')).toEqual({
      mode: 'auto',
      fields: null,
      block_exact: false
    })
    expect(
      parseDuplicateCheck(
        JSON.stringify({
          duplicate_check: { mode: 'on', fields: ['name', 'bad name;'], block_exact: true }
        })
      )
    ).toEqual({ mode: 'on', fields: ['name'], block_exact: true })
    expect(parseDuplicateCheck({ duplicate_check: { mode: 'off' } }).mode).toBe('off')
  })
})

describe('resolveDuplicateFields — which collections are checked', () => {
  const kinds = { name: 'unicode', code: 'ansi', notes: 'unicode' } as const
  const fields = [
    { field: 'name', type: 'string' },
    { field: 'code', type: 'string', options: { auto_id: { pattern: 'U-{seq}' } } },
    { field: 'notes', type: 'text' }
  ]
  const base = {
    collection: 'unit_types',
    setting: parseDuplicateCheck(null),
    template: '{{name}}',
    kinds: { ...kinds },
    fields,
    rows: 120
  }
  it('auto: on for a small list whose label is one plain string field', () => {
    const r = resolveDuplicateFields(base)
    expect(r).toMatchObject({ enabled: true, fields: ['name'], source: 'auto', close: true })
  })
  it('auto: off for big tables, several-field labels, generated ids and system tables', () => {
    expect(resolveDuplicateFields({ ...base, rows: AUTO_ROW_LIMIT + 1 }).enabled).toBe(false)
    expect(resolveDuplicateFields({ ...base, template: '{{name}} {{code}}' }).enabled).toBe(false)
    expect(resolveDuplicateFields({ ...base, template: '{{code}}' }).enabled).toBe(false)
    expect(resolveDuplicateFields({ ...base, template: '{{notes}}' }).enabled).toBe(false)
    expect(resolveDuplicateFields({ ...base, collection: 'nivaro_roles' }).enabled).toBe(false)
  })
  it('on: the chosen fields on any table size (exact pass only when big); off: never', () => {
    const on = resolveDuplicateFields({
      ...base,
      rows: 900_000,
      template: '{{name}} {{code}}',
      setting: parseDuplicateCheck({ duplicate_check: { mode: 'on', fields: ['name', 'id'] } })
    })
    expect(on).toMatchObject({
      enabled: true,
      fields: ['name'],
      close: false,
      source: 'configured'
    })
    expect(
      resolveDuplicateFields({
        ...base,
        setting: parseDuplicateCheck({ duplicate_check: { mode: 'off' } })
      }).enabled
    ).toBe(false)
  })
})

describe('classifyMatch', () => {
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

describe('candidate statements carry the caller read gate', () => {
  const access = { sql: '[id] IN (SELECT id FROM t WHERE zone = ?)', bindings: ['Z1'] }
  it('exact: bound value, the gate on t.[id]', () => {
    const s = exactStatement('unit_types', 'name', ' MX480 ', 'unicode', access, true)
    expect(s.sql).toContain('FROM [unit_types] AS t WHERE t.[name] = ?')
    expect(s.sql).toContain('AND t.[id] IN (SELECT id FROM t WHERE zone = ?)')
    expect(s.bindings).toEqual(['MX480', 'Z1'])
  })
  it('folded: REPLACE chain in the binary collation, folded upper value bound', () => {
    const s = foldStatement('unit_types', 'name', 'mx-480', access)
    expect(s?.sql).toMatch(/UPPER\(REPLACE\(/)
    expect(s?.sql).toContain('COLLATE Latin1_General_100_BIN2 = ?')
    expect(s?.bindings).toEqual(['MX480', 'Z1'])
    expect(foldStatement('unit_types', 'name', '-', null)).toBeNull()
  })
})

const cfg = (over: Partial<DuplicateConfig> = {}): DuplicateConfig => ({
  enabled: true,
  fields: ['name'],
  block_exact: false,
  close: true,
  source: 'auto',
  rows: 50,
  kinds: { name: 'unicode' },
  template: '{{name}}',
  label: 'Unit Type',
  ...over
})

function deps(over: Partial<DuplicateDeps> & { rows?: Array<Record<string, unknown>> }) {
  const sqls: string[] = []
  const reads: ItemsQuery[] = []
  const d: DuplicateDeps = {
    config: async () => cfg(),
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
    expect(sqls.every((s) => s.includes('[id] IN (SELECT 1)'))).toBe(true)
    expect(reads[0].fields).toEqual(['id', 'name'])
  })
  it('a record the caller may not read never shows (the read drops it)', async () => {
    // id 2 is outside the caller's scope: readItems does not return it.
    const { d } = deps({ rows: [{ id: 1, name: 'MX-480' }] })
    const out = await findDuplicates(user, 'unit_types', { name: 'MX480' }, {}, d)
    expect(out.matches.name.map((m) => m.id)).toEqual(['1'])
  })
  it('a field the caller may not read is never compared', async () => {
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
  it('a big table runs the exact pass only', async () => {
    const { d, sqls } = deps({ config: async () => cfg({ close: false }), rows: [] })
    await findDuplicates(user, 'unit_types', { name: 'Transformer' }, {}, d)
    expect(sqls).toHaveLength(1)
    expect(sqls[0]).not.toContain('REPLACE')
  })
  it('off collections answer enabled:false without SQL', async () => {
    const { d, sqls } = deps({ config: async () => cfg({ enabled: false, fields: [] }) })
    expect((await findDuplicates(user, 'unit_types', { name: 'MX480' }, {}, d)).enabled).toBe(false)
    expect(sqls).toEqual([])
  })
})

describe('importDuplicateScan — import preview', () => {
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
        config: async () => cfg(),
        fetch: async (_f, pass, keys) =>
          pass === 'exact'
            ? keys.some((k) => k.toLowerCase() === 'mx480')
              ? [{ id: 10, v: 'MX480' }]
              : []
            : [
                { id: 11, v: 'Router 9' },
                { id: 10, v: 'MX480' }
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
  it('null when the collection does not check duplicates or the field is not mapped', async () => {
    expect(
      await importDuplicateScan('unit_types', [{ row: 2, values: { name: 'x' } }], {
        config: async () => cfg({ enabled: false })
      })
    ).toBeNull()
    expect(
      await importDuplicateScan('unit_types', [{ row: 2, values: { code: 'x' } }], {
        config: async () => cfg()
      })
    ).toBeNull()
  })
})
