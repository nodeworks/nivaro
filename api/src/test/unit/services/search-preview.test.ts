import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /global-search/preview (search program item 8): read as the caller; a row
// they cannot see (or a collection they cannot read) is 404, never a hint.

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  throws: false,
  header: [] as string[]
}))

vi.mock('../../../db/index.js', () => {
  const chain = {
    where: () => chain,
    first: async () => ({ id: 'inst-1', current_state: 'S1', first_name: 'Ann', last_name: 'Lee' }),
    catch: () => chain
  }
  return { db: vi.fn(() => chain), dbRead: vi.fn(() => chain) }
})
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async () => {
    if (state.throws) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    return state.row
  }),
  readItems: vi.fn(async () => ({ data: [{ id: 9, name: 'Canton project' }] }))
}))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async (c: string) =>
    c === 'workflows'
      ? { display_template: '{{workflow_id}} {{name}}' }
      : { display_template: '{{name}}' }
  ),
  getFields: vi.fn(async () => [
    { field: 'workflow_id', label: 'Workflow ID', hidden: false, sort: 1 },
    { field: 'name', label: 'Name', hidden: false, sort: 2 },
    { field: 'project', label: 'Project', hidden: false, sort: 3 },
    { field: 'notes', label: 'Notes', hidden: true, sort: 4 }
  ]),
  getRelations: vi.fn(async () => [
    {
      many_collection: 'workflows',
      many_field: 'project',
      one_collection: 'projects',
      junction_field: null
    }
  ])
}))
vi.mock('../../../services/record-state.js', () => ({
  attachRecordState: vi.fn(async (_c: string, rows: Array<Record<string, unknown>>) => {
    rows[0].$state = {
      label: 'In review',
      color: '#00ceff',
      is_terminal: false,
      instance_id: 'inst-1'
    }
  })
}))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwnersBatch: vi.fn(
    async () => new Map([['r', [{ id: 'u-2', first_name: 'Sam', last_name: 'Ray', email: 's@x' }]]])
  )
}))
vi.mock('../../../routes/collection-layouts.js', () => ({
  resolveLayout: vi.fn(async () => ({ row: { header_fields: JSON.stringify(state.header) } }))
}))

import {
  buildSearchPreview,
  previewFieldOrder,
  previewValue,
  relationLabel
} from '../../../services/search-preview.js'

const user = { id: 'u-1', role: 'r-1' } as never

beforeEach(() => {
  state.row = null
  state.throws = false
  state.header = []
})

describe('search preview', () => {
  it('404s (null) when the caller cannot see the row', async () => {
    expect(await buildSearchPreview(user, 'workflows', '1', false)).toBeNull()
  })

  it('404s (null) when the collection refuses the caller', async () => {
    state.throws = true
    expect(await buildSearchPreview(user, 'workflows', '1', false)).toBeNull()
  })

  it('shows label, state, owners and the layout header fields as the caller read them', async () => {
    state.row = {
      id: 1,
      workflow_id: 'AB26-1',
      name: 'Grounding',
      project: 9,
      date_updated: '2026-10-27T10:00:00Z',
      user_updated: 'u-3'
    }
    state.header = ['project', 'secret', 'name']
    const p = await buildSearchPreview(user, 'workflows', '1', false)
    expect(p).toMatchObject({
      collection: 'workflows',
      id: 1,
      label: 'AB26-1 Grounding',
      state: { label: 'In review', color: '#00ceff' },
      owners: [{ id: 'u-2', name: 'Sam Ray' }],
      updated_at: '2026-10-27T10:00:00Z',
      updated_by: 'Ann Lee'
    })
    // `secret` is not in the caller's row: never shown. The M2O shows its label.
    expect(p?.fields).toEqual([
      { label: 'Project', value: 'Canton project' },
      { label: 'Name', value: 'Grounding' }
    ])
  })
})

describe('previewFieldOrder', () => {
  const fields = [
    { field: 'a', sort: 2 },
    { field: 'b', sort: 1 },
    { field: 'h', hidden: true, sort: 0 }
  ]
  it('falls back to the template, then the visible fields by sort, capped at six', () => {
    expect(previewFieldOrder({ id: 1, a: 1, b: 2, h: 3 }, [], '{{a}}', fields)).toEqual(['a', 'b'])
    expect(previewFieldOrder({ id: 1, a: 1, b: 2 }, [], null, fields)).toEqual(['b', 'a'])
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, i]))
    expect(previewFieldOrder(many, Object.keys(many), null, [])).toHaveLength(6)
  })

  // Army 6 L70: the Cmd+K preview of a workflow showed "Skip Forecast Cron false".
  it('the fallback skips switches that are off and internal flags', () => {
    const wf = [
      { field: 'skip_forecast_cron', sort: 0 },
      { field: 'is_automated', sort: 1 },
      { field: 'rush', sort: 2 },
      { field: 'name', sort: 3 },
      { field: 'requisition_amount', sort: 4 }
    ]
    const row = {
      id: 1,
      skip_forecast_cron: false,
      is_automated: true,
      rush: false,
      name: 'Fayette',
      requisition_amount: 10
    }
    expect(previewFieldOrder(row, [], null, wf)).toEqual(['name', 'requisition_amount'])
    // a layout's own header fields are the designer's choice and stay
    expect(previewFieldOrder(row, ['skip_forecast_cron'], null, wf)).toEqual(['skip_forecast_cron'])
  })
})

// Army 9 b14/b16: the Cmd+K preview showed "2026-10-19T00:00:00.000Z", "Is Past Due false",
// "Amount 95576", "Key 102-300137883-201943" and "Funding Year: Funding Years".
describe('previewValue', () => {
  it('writes dates the way the record page does', () => {
    const dt = { type: 'datetime' }
    expect(previewValue(dt, '2026-10-19T00:00:00.000Z')).toBe('Oct 19, 2026')
    expect(previewValue(dt, new Date('2026-11-18T00:00:00.000Z'))).toBe('Nov 18, 2026')
    expect(previewValue({ type: 'date' }, '2026-01-02')).toBe('Jan 2, 2026')
    expect(previewValue(dt, '2026-10-19T18:30:00.000Z', 'America/New_York')).toBe(
      'Oct 19, 2026, 2:30 PM'
    )
  })
  it("switches read Yes/No or the field's own labels", () => {
    expect(previewValue({ type: 'boolean' }, false)).toBe('No')
    expect(previewValue({ type: 'boolean' }, 1)).toBe('Yes')
    expect(
      previewValue(
        { type: 'boolean', display_options: { labelOn: 'Past due', labelOff: 'On time' } },
        false
      )
    ).toBe('On time')
  })
  it('money by the field format or a money name, other numbers with separators', () => {
    expect(
      previewValue({ type: 'decimal', field: 'x', options: { format: 'currency' } }, 95576)
    ).toBe('$95,576.00')
    expect(previewValue({ type: 'decimal', field: 'non_recoverable_tax' }, '0')).toBe('$0.00')
    expect(previewValue({ type: 'integer', field: 'payment_terms' }, 12345)).toBe('12,345')
    expect(
      previewValue({ type: 'decimal', field: 'rate', options: { format: 'percent' } }, 12.5)
    ).toBe('12.5%')
  })
  it('choices by their text; objects and blanks are nothing', () => {
    const f = {
      type: 'string',
      options: { choices: [{ text: 'Under Review', value: 'under_review' }] }
    }
    expect(previewValue(f, 'under_review')).toBe('Under Review')
    expect(previewValue({ type: 'string' }, { a: 1 })).toBeNull()
    expect(previewValue({ type: 'string' }, '')).toBeNull()
  })
})

describe('relationLabel', () => {
  it('a field template of {{id}} names the record by its key (a funding year)', () => {
    expect(relationLabel({ id: 2026 }, '{{id}}', null)).toBe('2026')
  })
  it('never falls back to the collection title', () => {
    expect(relationLabel({ id: 7 }, null, null)).toBeNull()
    expect(relationLabel({ id: 7, name: 'Zone 3' }, null, '{{name}}')).toBe('Zone 3')
  })
})

describe('previewFieldOrder internals', () => {
  it('the fallback leaves out internal keys but keeps zeros', () => {
    const fields = [
      { field: 'key', sort: 1 },
      { field: 'number', sort: 2 },
      { field: 'discount_days', sort: 3 },
      { field: 'amount', sort: 4 }
    ]
    expect(
      previewFieldOrder(
        { id: 1, key: 'a-b-c', number: 'N1', discount_days: 0, amount: 5 },
        [],
        null,
        fields
      )
    ).toEqual(['number', 'discount_days', 'amount'])
  })
})
