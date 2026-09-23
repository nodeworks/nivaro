import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/queues.js', () => ({ getLabels: vi.fn() }))

const { db } = await import('../../../db/index.js')
const { getLabels } = await import('../../../services/queues.js')
const { resolveFriendlyId, resolveFriendlyIds } = await import(
  '../../../services/workflow-transitions.js'
)

/** Minimal knex stand-in: where().first() for the registry lookup,
 *  whereIn().select() for the business-table batch — same shape as the
 *  pipeline-subject fakeDb, configured fresh per test via mockImplementation
 *  (never inside the vi.mock factory, which runs before a test's own data
 *  exists). */
function fakeDb(
  roomTypes: Record<string, { match_field: string } | undefined>,
  tables: Record<string, Array<Record<string, unknown>>>
) {
  return ((table: string) => ({
    where: (cond: Record<string, unknown>) => ({
      first: async () => {
        if (table === 'nivaro_chat_room_types') return roomTypes[cond.collection as string]
        return (tables[table] ?? []).find((r) =>
          Object.entries(cond).every(([k, v]) => String(r[k]) === String(v))
        )
      }
    }),
    whereIn: (col: string, ids: unknown[]) => ({
      select: async () =>
        (tables[table] ?? []).filter((r) =>
          ids.some((id) => String(id).toUpperCase() === String(r[col]).toUpperCase())
        )
    })
  })) as unknown as typeof db
}

describe('resolveFriendlyIds', () => {
  it('resolves via the entity-room registry match_field, falling back to the id when a row is missing', async () => {
    vi.mocked(db).mockImplementation(
      fakeDb(
        { workflows: { match_field: 'workflow_id' } },
        { workflows: [{ id: 1, workflow_id: 'CR26-1' }] }
      )
    )
    const out = await resolveFriendlyIds('workflows', ['1', '2'])
    expect(out).toEqual(
      new Map([
        ['1', 'CR26-1'],
        ['2', '2']
      ])
    )
  })

  it('falls back to the display label, then the id, for an unregistered collection', async () => {
    vi.mocked(db).mockImplementation(fakeDb({}, {}))
    vi.mocked(getLabels).mockResolvedValue({ 'projects:1': 'Site build-out' })
    const out = await resolveFriendlyIds('projects', ['1', '2'])
    expect(out).toEqual(
      new Map([
        ['1', 'Site build-out'],
        ['2', '2']
      ])
    )
  })

  it('resolves an addendum to its parent friendly id plus title', async () => {
    vi.mocked(db).mockImplementation(
      fakeDb(
        { workflows: { match_field: 'workflow_id' } },
        {
          nivaro_addendums: [
            {
              id: 'ADD-1',
              parent_collection: 'workflows',
              parent_id: '370880',
              title: 'Extra scope'
            }
          ],
          workflows: [{ id: '370880', workflow_id: 'CR26-80361' }]
        }
      )
    )
    const out = await resolveFriendlyIds('nivaro_addendums', ['ADD-1'])
    expect(out.get('ADD-1')).toBe('Addendum "Extra scope" · CR26-80361')
  })

  it('addendum with no parent falls through like the singular resolver — never a bare title', async () => {
    const mockDb = fakeDb(
      {},
      {
        nivaro_addendums: [
          {
            id: 'ADD-2',
            parent_collection: null,
            parent_id: null,
            title: 'Standalone note'
          }
        ]
      }
    )
    vi.mocked(db).mockImplementation(mockDb)
    vi.mocked(getLabels).mockResolvedValue({})
    const singular = await resolveFriendlyId('nivaro_addendums', 'ADD-2')
    const batch = await resolveFriendlyIds('nivaro_addendums', ['ADD-2'])
    expect(batch.get('ADD-2')).toBe(singular)
    expect(batch.get('ADD-2')).toBe('ADD-2')
  })

  it('never throws and always returns every requested id', async () => {
    vi.mocked(db).mockImplementation(() => {
      throw new Error('db down')
    })
    vi.mocked(getLabels).mockRejectedValue(new Error('boom'))
    const out = await resolveFriendlyIds('workflows', ['9'])
    expect(out).toEqual(new Map([['9', '9']]))
  })
})
