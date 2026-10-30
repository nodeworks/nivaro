import { describe, expect, it } from 'vitest'
import {
  exactStatement,
  fuzzyStatement,
  packArms,
  searchBudgetMs,
  splitExactSpecs,
  textArm
} from '../../../routes/global-search.js'
import { BINARY_COLLATION } from '../../../services/search-like.js'

const kinds = { workflow_id: 'ansi', name: 'unicode', body: 'other' } as const

describe('textArm — the text pass per collection', () => {
  it('binds each column in its cheap form on SQL Server', () => {
    const arm = textArm(
      { collection: 'workflows', kinds },
      ['workflow_id', 'name'],
      'Reggie',
      ['%Reggie%'],
      null,
      8,
      true
    )
    expect(arm.sql).toContain(`[workflow_id] LIKE CAST(? AS varchar(4000)) ESCAPE '\\'`)
    expect(arm.sql).toContain(`UPPER([name]) COLLATE ${BINARY_COLLATION} LIKE ? ESCAPE '\\'`)
    expect(arm.sql).toContain('SELECT TOP 8')
    // where (2) + equal rank (2) + prefix rank (2)
    expect(arm.bindings).toEqual(['%Reggie%', '%REGGIE%', 'Reggie', 'REGGIE', 'Reggie%', 'REGGIE%'])
    expect(arm.sql).not.toContain('Reggie')
  })

  it('other dialects keep the plain statement', () => {
    const arm = textArm({ collection: 'w', kinds }, ['name'], 'ab', ['%ab%'], null, 8, false)
    expect(arm.sql).toContain('[name] LIKE ? ESCAPE')
    expect(arm.sql).not.toContain('COLLATE')
  })

  it('synonym forms read the nvr_syn CTE (bound once, outside the arm)', () => {
    const arm = textArm(
      { collection: 'w', kinds },
      ['name'],
      'po',
      ['%po%', '%purchase order%'],
      null,
      8,
      true
    )
    expect(arm.sql).toContain('FROM nvr_syn s')
    expect(arm.bindings).not.toContain('%po%')
  })

  it('a full-text column answers through CONTAINS and leaves the LIKE', () => {
    const arm = textArm(
      { collection: 'w', kinds },
      ['name', 'workflow_id'],
      'fiber',
      ['%fiber%'],
      { cols: ['name'], cond: { sql: 'CONTAINS([name], ?)', bindings: ['"fiber*"'] } },
      8,
      true
    )
    expect(arm.sql).toContain('CONTAINS([name], ?)')
    expect(arm.sql.split('ORDER BY')[0]).not.toContain('UPPER([name])')
    expect(arm.bindings[0]).toBe('"fiber*"')
  })
})

describe('packArms — statements under the time budget', () => {
  it('gives every big table its own statement and packs the small ones', () => {
    const arm = (collection: string, rows: number, n = 3) => ({
      collection,
      rows,
      bindings: Array(n).fill('x')
    })
    const groups = packArms([arm('a', 10), arm('units', 200_000), arm('b', 5), arm('wf', 85_000)])
    expect(groups.map((g) => g.map((a) => a.collection))).toEqual([['units'], ['wf'], ['a', 'b']])
  })

  it('splits the small tables at the binding cap', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      collection: `t${i}`,
      rows: 1,
      bindings: Array(400).fill('x')
    }))
    const groups = packArms(many)
    expect(groups.length).toBeGreaterThan(1)
    for (const g of groups) expect(g.flatMap((a) => a.bindings).length).toBeLessThanOrEqual(1800)
    expect(groups.flat()).toHaveLength(10)
  })
})

describe('exact ids — the index-backed path first', () => {
  it('splits each collection into seekable and scanned columns', () => {
    const { seek, scan } = splitExactSpecs(
      [
        {
          collection: 'workflows',
          rows: 85_000,
          cols: ['workflow_id', 'requisition_id', 'nuvolo_id'],
          nums: [],
          indexedCols: ['workflow_id', 'nuvolo_id']
        },
        {
          collection: 'purchase_orders',
          rows: 100_000,
          cols: [],
          nums: ['po_number'],
          indexedCols: []
        }
      ],
      'HN26-80378'
    )
    expect(seek).toEqual([
      expect.objectContaining({
        collection: 'workflows',
        cols: ['workflow_id', 'nuvolo_id'],
        indexed: true
      })
    ])
    // A numeric column only for digits: purchase_orders has nothing to scan for words.
    expect(scan).toEqual([
      expect.objectContaining({ collection: 'workflows', cols: ['requisition_id'], indexed: false })
    ])
    const digits = splitExactSpecs(
      [{ collection: 'po', rows: 1, cols: [], nums: ['po_number'], indexedCols: [] }],
      '12345'
    )
    expect(digits.scan[0].nums).toEqual(['po_number'])
  })

  it('binds each id in its column type: varchar cast for a varchar index, binary scan for nvarchar', () => {
    const seek = exactStatement(
      [
        {
          collection: 'workflows',
          cols: ['workflow_id'],
          nums: [],
          kinds: { workflow_id: 'ansi' },
          indexed: true
        }
      ],
      'HN26-80378',
      true
    )
    expect(seek?.sql).toContain('WHERE [workflow_id] = CAST(? AS varchar(4000))')
    expect(seek?.bindings).toEqual(['HN26-80378'])
    const scan = exactStatement(
      [
        {
          collection: 'forecasts',
          cols: ['nuvolo_id'],
          nums: [],
          kinds: { nuvolo_id: 'unicode' },
          indexed: false
        }
      ],
      'pw26-1',
      true
    )
    expect(scan?.sql).toContain(`UPPER([nuvolo_id]) COLLATE ${BINARY_COLLATION} = ?`)
    expect(scan?.bindings).toEqual(['PW26-1'])
  })
})

describe('typo pass statement', () => {
  it('uses the binary form on nvarchar name columns', () => {
    const s = fuzzyStatement(
      [{ collection: 'vendors', cols: ['name'], kinds: { name: 'unicode' } }],
      'cantn',
      true
    )
    expect(s?.sql).toContain(`UPPER(t.[name]) COLLATE ${BINARY_COLLATION} LIKE ?`)
    expect(s?.bindings).toEqual(['%CAN%', '%ANT%', '%NTN%'])
  })
})

describe('searchBudgetMs', () => {
  it('defaults, reads SEARCH_BUDGET_MS and clamps it', () => {
    expect(searchBudgetMs(undefined)).toBe(1_800)
    expect(searchBudgetMs('2500')).toBe(2_500)
    expect(searchBudgetMs('10')).toBe(300)
    expect(searchBudgetMs('999999')).toBe(15_000)
    expect(searchBudgetMs('nope')).toBe(1_800)
  })
})
