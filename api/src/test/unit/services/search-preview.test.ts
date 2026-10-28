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

import { buildSearchPreview, previewFieldOrder } from '../../../services/search-preview.js'

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
})
