import { beforeEach, describe, expect, it, vi } from 'vitest'

// army 11 API review #3: count_all trusted caller-supplied $parent values, so a
// zone-restricted person could probe other zones' counts, and inactive layouts
// answered too.
const readOne = vi.fn()
const resolveLayout = vi.fn()
const summaries: Record<string, unknown>[] = []
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({
    where: () => ({ select: async () => summaries })
  }))
}))
vi.mock('../../../services/items.js', () => ({
  readOne: (...a: unknown[]) => readOne(...a),
  applyFilterToQuery: vi.fn()
}))
vi.mock('../../../services/collections.js', () => ({
  getRelations: async () => [
    {
      many_collection: 'inventory_request',
      many_field: 'supporting_warehouse',
      one_collection: 'warehouses'
    }
  ]
}))
vi.mock('../../../services/layout-patch.js', () => ({
  roleAllows: (row: { roles?: string[] }, role: string) => !row.roles || row.roles.includes(role)
}))
vi.mock('../../../services/permissions.js', () => ({ can: async () => true }))
vi.mock('../../../middleware/authenticate.js', () => ({ authenticate: vi.fn() }))
vi.mock('../../../routes/collection-layouts.js', () => ({
  resolveLayout: (...a: unknown[]) => resolveLayout(...a)
}))

import { layoutsForCaller, parentValuesForCaller } from '../../../routes/catalog-related.js'

const req = { user: { id: 'u1', role: 'creator' }, isAdmin: false, workspaceId: null } as never

beforeEach(() => {
  readOne.mockReset()
  resolveLayout.mockReset()
  summaries.length = 0
})

describe('parentValuesForCaller', () => {
  it('a saved record: values come from the record read as the caller, never the request', async () => {
    readOne.mockResolvedValueOnce({ id: 37836, supporting_warehouse: { id: 3 } })
    const out = await parentValuesForCaller(
      req,
      'inventory_request',
      '37836',
      ['supporting_warehouse'],
      {
        supporting_warehouse: 99
      }
    )
    expect(out).toEqual({ supporting_warehouse: 3 })
    expect(readOne).toHaveBeenCalledWith(expect.anything(), 'inventory_request', '37836', undefined)
  })

  it('a record the caller cannot see answers nothing (404)', async () => {
    readOne.mockResolvedValueOnce(null)
    expect(
      await parentValuesForCaller(req, 'inventory_request', '1', ['supporting_warehouse'], {})
    ).toBeNull()
  })

  it('a new form: a warehouse the caller cannot read is refused (probe)', async () => {
    readOne.mockResolvedValueOnce(null)
    expect(
      await parentValuesForCaller(req, 'inventory_request', 'new', ['supporting_warehouse'], {
        supporting_warehouse: 7
      })
    ).toBeNull()
    expect(readOne).toHaveBeenCalledWith(expect.anything(), 'warehouses', 7, undefined)
  })

  it('a new form: a readable warehouse is taken; objects and non-relation fields are refused', async () => {
    readOne.mockResolvedValueOnce({ id: 6 })
    expect(
      await parentValuesForCaller(req, 'inventory_request', 'new', ['supporting_warehouse'], {
        supporting_warehouse: 6
      })
    ).toEqual({ supporting_warehouse: 6 })
    expect(
      await parentValuesForCaller(req, 'inventory_request', 'new', ['supporting_warehouse'], {
        supporting_warehouse: [1, 2]
      })
    ).toBeNull()
    expect(
      await parentValuesForCaller(req, 'inventory_request', 'new', ['request_state'], {
        request_state: 1
      })
    ).toBeNull()
  })
})

describe('layoutsForCaller', () => {
  it('only the layout the record resolves to, its parent and Summary forms the role may open', async () => {
    resolveLayout.mockResolvedValueOnce({ row: { id: 22, parent_layout_id: null } })
    summaries.push({ id: 87 }, { id: 90, roles: ['admin'] })
    expect(await layoutsForCaller(req, 'inventory_request', '37836')).toEqual([22, 87])
    expect(resolveLayout).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'inventory_request', item: '37836', isAdmin: false })
    )
  })
})
