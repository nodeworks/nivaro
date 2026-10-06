import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/workflow-transitions.js', () => ({ resolveFriendlyIds: vi.fn() }))
vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn() }))
vi.mock('../../../services/event-path/record-labels.js', () => ({
  collectionWord: vi.fn(async (c: string) => (c === 'regions' ? 'Region' : c))
}))

const { db } = await import('../../../db/index.js')
const { resolveFriendlyIds } = await import('../../../services/workflow-transitions.js')
const { getCollection } = await import('../../../services/collections.js')
const { headlineFromSnapshot, recordHeadlines } = await import(
  '../../../services/record-headline.js'
)

/** where().first() / whereIn().select() / where().whereIn().orderBy().select()
 *  over in-memory tables — the friendly-ids fakeDb shape plus the trash read. */
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const q = (table: string, conds: Array<(r: Record<string, unknown>) => boolean>) => ({
    where: (cond: Record<string, unknown>) =>
      q(table, [
        ...conds,
        (r) => Object.entries(cond).every(([k, v]) => String(r[k]) === String(v))
      ]),
    whereIn: (col: string, ids: unknown[]) =>
      q(table, [
        ...conds,
        (r) => ids.some((id) => String(id).toUpperCase() === String(r[col]).toUpperCase())
      ]),
    orderBy: () => q(table, conds),
    select: async () => (tables[table] ?? []).filter((r) => conds.every((c) => c(r)))
  })
  return ((table: string) => q(table, [])) as unknown as typeof db
}

beforeEach(() => {
  vi.mocked(getCollection).mockResolvedValue({ display_template: '{{short_name}}' } as never)
})

describe('headlineFromSnapshot', () => {
  it('renders plain tokens, trims separators, and ignores dotted tokens', () => {
    expect(headlineFromSnapshot('{{short_name}}', { short_name: 'PRB1' })).toBe('PRB1')
    expect(headlineFromSnapshot('{{a}} · {{b.name}}', { a: 'X', b: 7 })).toBe('X')
    expect(
      headlineFromSnapshot('{{workflow_id}} - {{name}}', { workflow_id: null, name: 'N' })
    ).toBe('N')
  })
  it('falls back to a name-ish column, then null', () => {
    expect(headlineFromSnapshot(null, { id: 3, title: 'Quote' })).toBe('Quote')
    expect(headlineFromSnapshot('{{missing}}', { name: 'Via name' })).toBe('Via name')
    expect(headlineFromSnapshot(null, { id: 3 })).toBeNull()
    expect(headlineFromSnapshot(null, null)).toBeNull()
  })
})

describe('recordHeadlines', () => {
  it('a resolved friendly id is live and untouched', async () => {
    vi.mocked(resolveFriendlyIds).mockResolvedValue(new Map([['1', 'CM26-80332']]))
    vi.mocked(db).mockImplementation(fakeDb({ workflows: [{ id: 1 }] }) as never)
    const out = await recordHeadlines('workflows', ['1'])
    expect(out.get('1')).toEqual({
      label: 'CM26-80332',
      deleted: false,
      collection_label: 'workflows'
    })
  })

  it('a deleted record is named from its trash snapshot and flagged', async () => {
    vi.mocked(resolveFriendlyIds).mockResolvedValue(new Map([['264', '264']]))
    vi.mocked(db).mockImplementation(
      fakeDb({
        regions: [],
        nivaro_trash: [
          {
            id: 610,
            collection: 'regions',
            item_id: '264',
            data: '{"id":264,"short_name":"PRB1"}'
          },
          { id: 500, collection: 'regions', item_id: '264', data: '{"id":264,"short_name":"OLD"}' }
        ]
      }) as never
    )
    const out = await recordHeadlines('regions', ['264'])
    expect(out.get('264')).toEqual({ label: 'PRB1', deleted: true, collection_label: 'Region' })
  })

  it('a live record nothing names reads "<Singular> #<id>", never bare', async () => {
    vi.mocked(resolveFriendlyIds).mockResolvedValue(new Map([['9', '9']]))
    vi.mocked(db).mockImplementation(fakeDb({ regions: [{ id: 9 }], nivaro_trash: [] }) as never)
    const out = await recordHeadlines('regions', ['9'])
    expect(out.get('9')).toEqual({ label: 'Region #9', deleted: false, collection_label: 'Region' })
  })

  it('a deleted record with no trash row is still flagged, under the fallback name', async () => {
    vi.mocked(resolveFriendlyIds).mockResolvedValue(new Map([['5', '5']]))
    vi.mocked(db).mockImplementation(fakeDb({ regions: [], nivaro_trash: [] }) as never)
    const out = await recordHeadlines('regions', ['5'])
    expect(out.get('5')).toEqual({ label: 'Region #5', deleted: true, collection_label: 'Region' })
  })

  it('never throws and answers every id', async () => {
    vi.mocked(resolveFriendlyIds).mockRejectedValue(new Error('boom'))
    vi.mocked(db).mockImplementation((() => {
      throw new Error('db down')
    }) as never)
    const out = await recordHeadlines('regions', ['1', '2'])
    expect([...out.keys()]).toEqual(['1', '2'])
    expect(out.get('1')?.deleted).toBe(false)
  })
})
