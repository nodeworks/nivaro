import { beforeEach, describe, expect, it, vi } from 'vitest'

// db(table).where().first() — the existence probe for deleted records and the
// relation lookup for o2m parents. Each call returns the configured row.
let existingRow: unknown = null
let relationRow: unknown = null
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const row = table === 'nivaro_relations' ? relationRow : existingRow
    const q = {
      where: () => q,
      whereNotNull: () => q,
      first: () => Promise.resolve(row)
    }
    return q
  })
}))
const can = vi.fn(async () => true)
vi.mock('../../../services/permissions.js', () => ({ can }))
const readOne = vi.fn(async () => ({ id: '1' }))
vi.mock('../../../services/items.js', () => ({ readOne }))

const { recordVisibleTo, o2mParentVisibleTo } = await import('../../../services/revision-access.js')

type Req = Parameters<typeof recordVisibleTo>[0]
const notFound = () => Object.assign(new Error('Item not found'), { statusCode: 404 })
function req(over: Record<string, unknown> = {}): Req {
  return {
    user: { id: 'u1', role: 'r1', ...((over.user as object) ?? {}) },
    isAdmin: over.isAdmin ?? false,
    workspaceId: null
  } as unknown as Req
}

beforeEach(() => {
  existingRow = null
  relationRow = null
  can.mockReset().mockResolvedValue(true)
  readOne.mockReset().mockResolvedValue({ id: '1' })
})

describe('recordVisibleTo', () => {
  it('visible when the caller can open the record', async () => {
    expect(await recordVisibleTo(req(), 'workflows', '7')).toBe(true)
    expect(readOne).toHaveBeenCalledWith(expect.anything(), 'workflows', '7', undefined, ['id'])
  })

  it('hidden when readOne answers null — how it reports a row the scopes hide', async () => {
    readOne.mockResolvedValue(null as unknown as { id: string })
    existingRow = { id: '7' }
    expect(await recordVisibleTo(req(), 'workflows', '7')).toBe(false)
  })

  it('hidden when readOne throws not-found', async () => {
    readOne.mockRejectedValue(notFound())
    existingRow = { id: '7' }
    expect(await recordVisibleTo(req(), 'workflows', '7')).toBe(false)
  })

  it('hidden without collection read permission, readOne never asked', async () => {
    can.mockResolvedValue(false)
    expect(await recordVisibleTo(req(), 'workflows', '7')).toBe(false)
    expect(readOne).not.toHaveBeenCalled()
  })

  it('system tables are admin-only', async () => {
    expect(await recordVisibleTo(req(), 'nivaro_users', 'x')).toBe(false)
    expect(await recordVisibleTo(req({ isAdmin: true }), 'nivaro_users', 'x')).toBe(true)
  })

  it('an unrestricted admin reads a deleted record; never an existing hidden one', async () => {
    readOne.mockResolvedValue(null as unknown as { id: string })
    existingRow = null
    expect(await recordVisibleTo(req({ isAdmin: true }), 'workflows', '7')).toBe(true)
    existingRow = { id: '7' }
    expect(await recordVisibleTo(req({ isAdmin: true }), 'workflows', '7')).toBe(false)
  })

  it('an admin on a scope-restricted key is held to readOne', async () => {
    readOne.mockResolvedValue(null as unknown as { id: string })
    const r = req({
      isAdmin: true,
      user: { api_key_scope_restrictions: [{ dimension: 'division', values: [1] }] }
    })
    expect(await recordVisibleTo(r, 'workflows', '7')).toBe(false)
  })
})

describe('o2mParentVisibleTo', () => {
  it('needs child read AND the parent record visible', async () => {
    relationRow = { one_collection: 'workflows' }
    expect(await o2mParentVisibleTo(req(), 'workflow_line_items', 'workflow', '7')).toBe(true)
    expect(readOne).toHaveBeenCalledWith(expect.anything(), 'workflows', '7', undefined, ['id'])

    readOne.mockResolvedValue(null as unknown as { id: string })
    existingRow = { id: '7' }
    expect(await o2mParentVisibleTo(req(), 'workflow_line_items', 'workflow', '7')).toBe(false)
  })

  it('child read denied short-circuits', async () => {
    can.mockResolvedValue(false)
    expect(await o2mParentVisibleTo(req(), 'workflow_line_items', 'workflow', '7')).toBe(false)
  })

  it('an unknown relation is admin-only', async () => {
    relationRow = null
    expect(await o2mParentVisibleTo(req(), 'lines', 'parent', '7')).toBe(false)
    expect(await o2mParentVisibleTo(req({ isAdmin: true }), 'lines', 'parent', '7')).toBe(true)
  })
})
