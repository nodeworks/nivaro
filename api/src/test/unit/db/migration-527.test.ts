import { describe, expect, it, vi } from 'vitest'
import { down, up } from '../../../db/migrations/527_change_proposals.js'

/** Fake knex schema recording the table built by createTable. */
function fakeKnex(exists: boolean) {
  let have = exists
  const columns: Array<{ name: string; kind: string; nullable: boolean }> = []
  const indexes: string[] = []
  const col = (name: string, kind: string) => {
    const c = { name, kind, nullable: true }
    columns.push(c)
    const chain = {
      notNullable() {
        c.nullable = false
        return chain
      },
      nullable() {
        c.nullable = true
        return chain
      },
      defaultTo() {
        return chain
      },
      primary() {
        c.nullable = false
        return chain
      }
    }
    return chain
  }
  const schema = {
    hasTable: vi.fn(async () => have),
    createTable: vi.fn(async (_t: string, cb: (t: unknown) => void) => {
      cb({
        increments: (n: string) => col(n, 'increments'),
        string: (n: string) => col(n, 'string'),
        text: (n: string) => col(n, 'text'),
        uuid: (n: string) => col(n, 'uuid'),
        datetime: (n: string) => col(n, 'datetime'),
        index: (_c: string[], name: string) => indexes.push(name)
      })
      have = true
    }),
    dropTableIfExists: vi.fn(async () => {
      have = false
    })
  }
  return { knex: { schema } as never, schema, columns, indexes }
}

describe('migration 527 — nivaro_change_proposals', () => {
  it('creates the table once with its record index', async () => {
    const f = fakeKnex(false)
    await up(f.knex)
    expect(f.schema.createTable).toHaveBeenCalledTimes(1)
    const names = f.columns.map((c) => c.name)
    expect(names).toEqual([
      'id',
      'collection',
      'item',
      'status',
      'changes',
      'reason',
      'state_key',
      'created_by',
      'created_at',
      'decided_by',
      'decided_at',
      'decision_note'
    ])
    expect(f.columns.find((c) => c.name === 'decided_by')?.nullable).toBe(true)
    expect(f.columns.find((c) => c.name === 'created_by')?.nullable).toBe(false)
    expect(f.indexes).toEqual(['ix_change_proposals_record', 'ix_change_proposals_status'])
    await up(f.knex)
    expect(f.schema.createTable).toHaveBeenCalledTimes(1)
  })

  it('leaves an existing table alone; down drops it', async () => {
    const f = fakeKnex(true)
    await up(f.knex)
    expect(f.schema.createTable).not.toHaveBeenCalled()
    await down(f.knex)
    expect(f.schema.dropTableIfExists).toHaveBeenCalledWith('nivaro_change_proposals')
  })
})
