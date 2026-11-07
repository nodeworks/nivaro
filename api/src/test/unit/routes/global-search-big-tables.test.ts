import { describe, expect, it } from 'vitest'
import {
  bigTableSeekColumns,
  demoteForeignExact,
  prefixStatement,
  splitExactSpecs,
  TAB_SEEK_PER_COLUMN,
  tabSeekStatement
} from '../../../routes/global-search.js'

// army 8 b07/b14/b16: invoices (2.7M rows) sat out of global search entirely, so an
// invoice number ("11006855426ADJ", "130115") found nothing. A big table now answers
// an id (or its start) through index-led id columns — seeks, never a scan.
describe('bigTableSeekColumns — what a big table may be sought on', () => {
  const strings = ['number', 'invoice_id', 'description', 'vendor_name', 'po_number']
  const numerics = ['line_item_number', 'amount_number']
  it('keeps string id columns an index leads; never an unindexed one', () => {
    const r = bigTableSeekColumns(strings, numerics, ['number', 'invoice_id', 'id', 'vendor'], null)
    expect(r.cols).toEqual(['invoice_id', 'number'])
    // po_number is id-ish but no index leads it: a scan, so left out.
    expect(r.cols).not.toContain('po_number')
    // Numeric columns only when search_fields names them (line_item_number "12" = noise).
    expect(r.nums).toEqual([])
  })

  it('search_fields adds indexed non-id columns and named numeric ones', () => {
    const r = bigTableSeekColumns(
      strings,
      numerics,
      ['number', 'vendor_name', 'line_item_number'],
      ['vendor_name', 'line_item_number', 'description']
    )
    expect(r.cols).toEqual(['number', 'vendor_name'])
    expect(r.nums).toEqual(['line_item_number'])
  })

  it('every big-table column is a seek (none falls to the scan side)', () => {
    const { cols } = bigTableSeekColumns(strings, [], ['number', 'invoice_id'], null)
    const { seek, scan } = splitExactSpecs(
      [
        {
          collection: 'invoices',
          cols,
          nums: [],
          rows: 2_700_000,
          indexedCols: ['number', 'invoice_id']
        }
      ],
      '11006855426ADJ'
    )
    expect(scan).toEqual([])
    expect(seek[0].cols).toEqual(['invoice_id', 'number'])
  })
})

describe('prefixStatement — an id start as a range seek per column', () => {
  const batch = [
    {
      collection: 'invoices',
      cols: ['number', 'legacy_no'],
      kinds: { number: 'unicode', legacy_no: 'ansi' } as const
    }
  ]
  it('one TOP-N subquery per column, the pattern bound (escaped) in the column type', () => {
    const st = prefixStatement(batch, 'INV-PPC_0003', true)
    expect(st).not.toBeNull()
    expect(st!.sql).toContain(`[number] LIKE ? ESCAPE '\\'`)
    expect(st!.sql).toContain(`[legacy_no] LIKE CAST(? AS varchar(4000)) ESCAPE '\\'`)
    expect(st!.sql).toContain('TOP 5')
    expect(st!.sql).not.toContain('INV-PPC')
    // `_` escaped so it is not a wildcard; never UPPER()/COLLATE (that would scan).
    expect(st!.bindings).toEqual(['INV-PPC\\_0003%', 'INV-PPC\\_0003%'])
    expect(st!.sql).not.toContain('UPPER(')
  })

  it('a short start runs no prefix seek', () => {
    expect(prefixStatement(batch, 'IN1', true)).toBeNull()
  })

  it('unsafe names are never placed in SQL', () => {
    expect(
      prefixStatement([{ collection: 'x];drop', cols: ['number'] }], 'ABCD12', true)
    ).toBeNull()
  })
})

// Army 8 review M3: the /counts and /records tabs ORed `_starts_with` across every id
// column from 2 characters — "13" on invoices = a 2.7M-row scan per tab request.
describe('tabSeekStatement — the tab endpoints seek each column on its own', () => {
  const p = { collection: 'invoices', kinds: { number: 'unicode', legacy_no: 'ansi' } as const }
  it('from 4 characters: one typed TOP-N prefix seek per column, UNION ALL — never an OR', () => {
    const st = tabSeekStatement(p, ['number', 'legacy_no'], 'INV_0003', 100, true)
    expect(st).not.toBeNull()
    expect(st!.sql).not.toMatch(/\bOR\b/)
    expect(st!.sql.split('UNION ALL')).toHaveLength(2)
    expect(st!.sql).toContain(`TOP 100 CAST(id AS nvarchar(64)) AS id, 'number' AS k`)
    expect(st!.sql).toContain(`[number] LIKE ? ESCAPE '\\'`)
    expect(st!.sql).toContain(`[legacy_no] LIKE CAST(? AS varchar(4000)) ESCAPE '\\'`)
    expect(st!.sql).not.toContain('UPPER(')
    expect(st!.sql).not.toContain('INV')
    expect(st!.bindings).toEqual(['INV\\_0003%', 'INV\\_0003%'])
  })

  it('under 4 characters: an exact seek per column, never a 2-character prefix range', () => {
    const st = tabSeekStatement(p, ['number', 'legacy_no'], '13', TAB_SEEK_PER_COLUMN, true)
    expect(st).not.toBeNull()
    expect(st!.sql).not.toContain('LIKE')
    expect(st!.sql).not.toMatch(/\bOR\b/)
    expect(st!.sql).toContain('[number] = ?')
    expect(st!.sql).toContain('[legacy_no] = CAST(? AS varchar(4000))')
    expect(st!.bindings).toEqual(['13', '13'])
  })

  it('one character, no columns or unsafe names: nothing runs', () => {
    expect(tabSeekStatement(p, ['number'], '1', 100, true)).toBeNull()
    expect(tabSeekStatement(p, [], 'ABCD', 100, true)).toBeNull()
    expect(tabSeekStatement(p, ['x];drop'], 'ABCD', 100, true)).toBeNull()
    expect(tabSeekStatement({ collection: 'x];drop' }, ['number'], 'ABCD', 100, true)).toBeNull()
  })
})

describe('demoteForeignExact — the record that owns an id is the exact match', () => {
  const templates: Record<string, string> = {
    projects: '{{project_id}} - {{name}}',
    workflows: '{{workflow_id}}'
  }
  const of = (c: string) => templates[c] ?? null
  it('a workflow matched on its project_id ranks under the project (army 8 b14 "201953")', () => {
    const out = demoteForeignExact(
      [
        {
          collection: 'workflows',
          matched_field: 'project_id',
          exact: true,
          tier: 'exact' as const
        },
        { collection: 'projects', matched_field: 'project_id', exact: true, tier: 'exact' as const }
      ],
      of
    )
    expect(out[0]).toMatchObject({ collection: 'workflows', exact: false, tier: 'equal' })
    expect(out[1]).toMatchObject({ collection: 'projects', exact: true, tier: 'exact' })
  })

  it('with no owner in the answer, a reference match stays exact', () => {
    const hits = [
      { collection: 'workflows', matched_field: 'project_id', exact: true, tier: 'exact' as const }
    ]
    expect(demoteForeignExact(hits, of)).toEqual(hits)
  })
})
