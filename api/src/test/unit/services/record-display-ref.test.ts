// recordDisplayRef (#776 readable ids, display only): the friendly id when the
// collection names one and the reader may see it, else `#id` — never the
// display label, never a value the recipient could not read.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TABLES: Record<string, Array<Record<string, unknown>>> = {
  workflows: [
    { id: 7, workflow_id: 'CM26-7' },
    { id: 8, workflow_id: '' }
  ]
}

vi.mock('../../../db/index.js', () => ({
  db: (table: string) => ({
    whereIn: (_col: string, ids: unknown[]) => ({
      select: async () =>
        (TABLES[table] ?? []).filter((r) => ids.map(String).includes(String(r.id)))
    })
  })
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  friendlyIdField: vi.fn(async (c: string) => (c === 'workflows' ? 'workflow_id' : null))
}))
vi.mock('../../../services/items.js', () => ({ readItems: vi.fn() }))
vi.mock('../../../services/users.js', () => ({ getUser: vi.fn() }))

const { readItems } = await import('../../../services/items.js')
const { getUser } = await import('../../../services/users.js')
const { recordDisplayRef, recordDisplayRefs, fallbackDisplayRef } = await import(
  '../../../services/record-display-ref.js'
)

const alice = { id: 'a', role: 'r1', email: 'a@x' } as never

beforeEach(() => {
  vi.mocked(readItems).mockReset()
  vi.mocked(getUser).mockReset()
})

describe('recordDisplayRef', () => {
  it('names the record by its friendly id', async () => {
    expect(await recordDisplayRef('workflows', 7)).toBe('CM26-7')
  })

  it('falls back to #id when the collection has no friendly id field', async () => {
    expect(await recordDisplayRef('projects', 12)).toBe('#12')
    expect(fallbackDisplayRef(12)).toBe('#12')
  })

  it('falls back to #id for a blank value or a missing row', async () => {
    const out = await recordDisplayRefs('workflows', [7, 8, 9])
    expect([...out]).toEqual([
      ['7', 'CM26-7'],
      ['8', '#8'],
      ['9', '#9']
    ])
  })

  it('reads as the recipient: their field list and row gates decide', async () => {
    vi.mocked(readItems).mockResolvedValueOnce({
      data: [{ id: 7, workflow_id: 'CM26-7' }]
    } as never)
    expect(await recordDisplayRef('workflows', 7, { recipient: alice })).toBe('CM26-7')
    expect(vi.mocked(readItems).mock.calls[0]?.[0]).toBe(alice)
    expect(vi.mocked(readItems).mock.calls[0]?.[2]).toMatchObject({
      fields: ['id', 'workflow_id'],
      filter: { id: { _in: ['7'] } }
    })

    // The recipient's role strips the id column: the row comes back without it.
    vi.mocked(readItems).mockResolvedValueOnce({ data: [{ id: 7 }] } as never)
    expect(await recordDisplayRef('workflows', 7, { recipient: alice })).toBe('#7')

    // The recipient cannot see the record at all.
    vi.mocked(readItems).mockResolvedValueOnce({ data: [] } as never)
    expect(await recordDisplayRef('workflows', 7, { recipient: alice })).toBe('#7')

    // The read refuses (no access to the collection).
    vi.mocked(readItems).mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), { statusCode: 403 })
    )
    expect(await recordDisplayRef('workflows', 7, { recipient: alice })).toBe('#7')
  })

  it('a recipient id that loads nobody reads the bare id', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(undefined)
    expect(await recordDisplayRef('workflows', 7, { recipient: 'nobody' })).toBe('#7')
    expect(readItems).not.toHaveBeenCalled()
  })

  it('loads a recipient given by id', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(alice)
    vi.mocked(readItems).mockResolvedValueOnce({
      data: [{ id: 7, workflow_id: 'CM26-7' }]
    } as never)
    expect(await recordDisplayRef('workflows', '7', { recipient: 'a' })).toBe('CM26-7')
    expect(getUser).toHaveBeenCalledWith('a')
  })
})
