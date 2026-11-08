import { describe, expect, it } from 'vitest'
import {
  EXACT_GROUP_TOP,
  exactStatement,
  fuzzyStatement,
  groupsMayHaveMore,
  hideInternalMatch,
  newestFirst,
  numberPartArms,
  numberPartSpecs,
  prefixStatement,
  splitExactSpecs,
  tabSeekStatement,
  textArm,
  withGroupDetail
} from '../../../routes/global-search.js'
import { searchGroupDetailOf, searchInternalFieldsOf } from '../../../services/search-fields.js'

// The caller's read gate as the candidate statements carry it (services/search-access.ts).
const gate = {
  sql: '[id] IN (select [workflows].[id] from [workflows] where [workflows].[zone] in (?, ?))',
  bindings: [1, 2]
}

// army 11 Q2-3: a scoped person (Zones 1-3) searching "HN26" got "Nothing matches" — the
// TOP 8 newest HN26 workflows were all National and the read as the caller dropped them.
// The gate now sits inside each statement, BEFORE the TOP.
describe('candidate statements judge access before the TOP', () => {
  it('textArm: the gate ANDs the whole match, bound between the match and the rank', () => {
    const arm = textArm(
      { collection: 'workflows', kinds: { workflow_id: 'other' } },
      ['workflow_id'],
      'HN26',
      ['%HN26%'],
      null,
      8,
      false,
      gate
    )
    expect(arm.sql).toContain(`WHERE ([workflow_id] LIKE ? ESCAPE '\\') AND ${gate.sql} ORDER BY`)
    expect(arm.bindings).toEqual(['%HN26%', 1, 2, 'HN26', 'HN26%'])
  })

  it('textArm without a gate is the statement it always was', () => {
    const arm = textArm({ collection: 'w', kinds: {} }, ['name'], 'ab', ['%ab%'], null, 8, false)
    expect(arm.sql).toContain(`WHERE [name] LIKE ? ESCAPE '\\' ORDER BY`)
    expect(arm.sql).not.toContain(' IN (')
  })

  it('textArm with synonyms keeps the gate inside the arm (after the EXISTS)', () => {
    const arm = textArm(
      { collection: 'w', kinds: {} },
      ['name'],
      'po',
      ['%po%', '%purchase order%'],
      null,
      8,
      false,
      gate
    )
    expect(arm.sql).toMatch(/WHERE \(EXISTS \(SELECT 1 FROM nvr_syn s WHERE .*\)\) AND \[id\] IN/)
    expect(arm.bindings.slice(0, 2)).toEqual([1, 2])
  })

  it('exactStatement: each collection carries its own gate after its id bindings', () => {
    const s = exactStatement(
      [
        { collection: 'workflows', cols: ['workflow_id'], nums: [], access: gate },
        { collection: 'projects', cols: ['project_id'], nums: [] }
      ],
      'HN26-77520',
      false
    )
    expect(s?.sql).toContain(`WHERE ([workflow_id] = ?) AND ${gate.sql}) AS [x_workflows]`)
    expect(s?.sql).toContain('WHERE [project_id] = ?) AS [x_projects]')
    expect(s?.bindings).toEqual(['HN26-77520', 1, 2, 'HN26-77520'])
  })

  it('prefixStatement and tabSeekStatement carry the gate per column', () => {
    const p = prefixStatement(
      [{ collection: 'invoices', cols: ['number'], access: gate }],
      'HN26-799',
      false
    )
    expect(p?.sql).toContain(`LIKE ? ESCAPE '\\' AND ${gate.sql}) AS [p_invoices_number]`)
    expect(p?.bindings).toEqual(['HN26-799%', 1, 2])
    const t = tabSeekStatement({ collection: 'invoices' }, ['number'], 'HN26', 100, false, gate)
    expect(t?.sql).toContain(`AND ${gate.sql}) AS [t_number]`)
    expect(t?.bindings).toEqual(['HN26%', 1, 2])
  })

  it('fuzzyStatement re-points the gate at the aliased row (t.[id])', () => {
    const s = fuzzyStatement([{ collection: 'vendors', cols: ['name'], access: gate }], 'cantn')
    expect(s?.sql).toContain('AND t.[id] IN (select')
    expect(s?.bindings).toEqual(['%can%', '%ant%', '%ntn%', 1, 2])
  })

  it('splitExactSpecs keeps each spec gate and its row cap', () => {
    const { seek } = splitExactSpecs(
      [
        {
          collection: 'invoices',
          cols: ['number'],
          nums: [],
          rows: 10,
          indexedCols: ['number'],
          access: gate,
          top: EXACT_GROUP_TOP
        }
      ],
      '10020'
    )
    expect(seek[0].access).toBe(gate)
    expect(seek[0].top).toBe(EXACT_GROUP_TOP)
  })
})

// army 11 a3 G: four vendors' invoices are all numbered 10020 and every invoice is many
// line rows. TOP 2 (arbitrary order) offered a 2025 invoice and hid the held 2026 one.
describe('grouped collections keep every invoice that carries the number', () => {
  it('exactStatement: a grouped spec keeps EXACT_GROUP_TOP rows, newest first', () => {
    const s = exactStatement(
      [{ collection: 'invoices', cols: ['number'], nums: [], top: EXACT_GROUP_TOP }],
      '10020',
      false
    )
    expect(s?.sql).toContain(`SELECT TOP ${EXACT_GROUP_TOP} 'invoices'`)
    expect(s?.sql).toContain('ORDER BY id DESC) AS [x_invoices]')
    const plain = exactStatement(
      [{ collection: 'w', cols: ['workflow_id'], nums: [] }],
      'A1',
      false
    )
    expect(plain?.sql).toContain('SELECT TOP 2')
    expect(plain?.sql).not.toContain('ORDER BY')
  })

  it('newestFirst orders numeric ids high to low', () => {
    const rows = [{ id: 1693559 }, { id: 5373745 }, { id: 853073 }]
    expect([...rows].sort(newestFirst).map((r) => r.id)).toEqual([5373745, 1693559, 853073])
  })

  it('a grouped exact pass is only "maybe more" when it filled its own cap', () => {
    const exact = Array.from({ length: 11 }, () => ({ collection: 'invoices' }))
    const top = (c: string) => (c === 'invoices' ? EXACT_GROUP_TOP : 2)
    expect(
      groupsMayHaveMore({ found: exact, exact, per: 100, cut: false, grouped: [], exactTop: top })
    ).toEqual(new Set())
  })

  it('search_group_detail: field names or one relation hop, at most three', () => {
    expect(
      searchGroupDetailOf({ search_group_detail: ['vendor.name', 'create_date', 'a.b.c', 'x;y'] })
    ).toEqual(['vendor.name', 'create_date'])
    expect(searchGroupDetailOf(null)).toEqual([])
  })

  it('withGroupDetail names the vendor and date on rows that only repeat the label', async () => {
    const hits = [
      {
        collection: 'invoices',
        display_name: 'Invoices',
        id: 5373745,
        label: '10020',
        snippet: '10020',
        matched_value: '10020'
      },
      {
        collection: 'invoices',
        display_name: 'Invoices',
        id: 1693559,
        label: '10020',
        snippet: '10020',
        matched_value: '10020'
      },
      {
        collection: 'workflows',
        display_name: 'Workflows',
        id: 1,
        label: 'HQ26-1',
        snippet: 'HQ26-1'
      }
    ]
    const out = await withGroupDetail(
      {} as never,
      [
        {
          collection: 'invoices',
          groupBy: 'invoice_id',
          groupDetail: ['vendor.name', 'create_date']
        }
      ],
      hits,
      async (_c, ids) =>
        ids.map((id) =>
          id === '5373745'
            ? {
                id: 5373745,
                vendor: { name: 'DEPLOYMENT TECHNOLOGIES INC' },
                create_date: '2026-10-12T00:00:00.000Z'
              }
            : { id: 1693559, vendor: null, create_date: '2025-06-16T00:00:00.000Z' }
        ),
      async () => [{ field: 'create_date', type: 'date' }]
    )
    expect(out[0].snippet).toBe('DEPLOYMENT TECHNOLOGIES INC · Oct 12, 2026')
    expect(out[1].snippet).toBe('Jun 16, 2025')
    expect(out[2].snippet).toBe('HQ26-1')
  })
})

// Rob's rule: never show internal ids — "Invoice Id: 100200585-131222-44915-44930".
describe('search_internal_fields — another system ids are matched whole, never shown', () => {
  it('parses like search_fields', () => {
    expect(
      searchInternalFieldsOf({ search_internal_fields: ['invoice_id', 'key', 'bad;'] })
    ).toEqual(['invoice_id', 'key'])
    expect(searchInternalFieldsOf('{}')).toEqual([])
  })

  it('a tab seek never prefix-matches an internal column', () => {
    const t = tabSeekStatement(
      { collection: 'invoices' },
      ['invoice_id', 'number'],
      '10020',
      100,
      false,
      null,
      ['invoice_id']
    )
    expect(t?.sql).toContain(`WHERE [invoice_id] = ?) AS [t_invoice_id]`)
    expect(t?.sql).toContain(`WHERE [number] LIKE ? ESCAPE`)
    expect(t?.bindings).toEqual(['10020', '10020%'])
  })

  it('hideInternalMatch drops the value and shows the label', () => {
    const hit = {
      label: 'GENMW2251205',
      snippet: '100200585-131222-44915-44930',
      matched_field: 'invoice_id',
      matched_label: 'Invoice Id',
      matched_value: '100200585-131222-44915-44930'
    }
    expect(hideInternalMatch(hit, { internal: ['invoice_id'] })).toEqual({
      label: 'GENMW2251205',
      snippet: 'GENMW2251205',
      matched_field: 'invoice_id'
    })
    expect(hideInternalMatch(hit, {})).toBe(hit)
  })
})

// army 11 a4: approvers quote "81137" for HQ26-81137.
describe('number part of an id', () => {
  const plan = [
    {
      collection: 'workflows',
      display_name: 'Workflows',
      template: '{{workflow_id}}',
      idColumns: ['project_id', 'workflow_id'],
      numIdColumns: [],
      columns: ['workflow_id'],
      labelColumns: ['workflow_id'],
      labelSearch: [],
      rows: 370_000,
      textSearchable: true,
      kinds: { workflow_id: 'other' }
    },
    {
      collection: 'invoices',
      display_name: 'Invoices',
      template: '{{number}}',
      idColumns: ['number'],
      numIdColumns: [],
      columns: [],
      labelColumns: [],
      labelSearch: [],
      rows: 2_700_000,
      textSearchable: false,
      seekOnly: true
    }
  ] as never[]
  const ctx = {
    allowed: new Map<string, string[] | null>(),
    access: new Map([['workflows', gate]])
  }

  it('reads only own id columns (the label template), never a reference or a big table', () => {
    const specs = numberPartSpecs(ctx, plan, '81137')
    expect(specs.map((s) => [s.collection, s.cols])).toEqual([['workflows', ['workflow_id']]])
  })

  it('digits only, three or more', () => {
    expect(numberPartSpecs(ctx, plan, 'HQ26')).toEqual([])
    expect(numberPartSpecs(ctx, plan, '81')).toEqual([])
  })

  it('binds `%-<digits>` behind the caller gate', () => {
    const [arm] = numberPartArms(ctx, plan, '81137', false)
    expect(arm.sql).toContain(
      `WHERE ([workflow_id] LIKE ? ESCAPE '\\') AND ${gate.sql} ORDER BY id DESC`
    )
    expect(arm.bindings).toEqual(['%-81137', 1, 2])
  })

  it('a column the caller may not read is left out', () => {
    const narrow = { ...ctx, allowed: new Map([['workflows', ['id', 'name']]]) }
    expect(numberPartSpecs(narrow, plan, '81137')).toEqual([])
  })
})
