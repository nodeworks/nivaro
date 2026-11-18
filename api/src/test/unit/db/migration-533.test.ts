import { describe, expect, it, vi } from 'vitest'
import { down, up } from '../../../db/migrations/533_transition_open_when.js'

/** Fake knex schema: does the table exist, which columns it has, what each alter did. */
function fakeKnex(columns: string[], table = true) {
  const have = new Set(columns)
  const added: Array<{ name: string; type: string; nullable: boolean }> = []
  const dropped: string[] = []
  const schema = {
    hasTable: vi.fn(async () => table),
    hasColumn: vi.fn(async (_t: string, c: string) => have.has(c)),
    alterTable: vi.fn(async (_t: string, cb: (t: unknown) => void) => {
      cb({
        text(name: string) {
          const col = { name, type: 'text', nullable: false }
          added.push(col)
          have.add(name)
          return {
            nullable() {
              col.nullable = true
              return this
            }
          }
        },
        dropColumn(name: string) {
          dropped.push(name)
          have.delete(name)
        }
      })
    })
  }
  return { knex: { schema } as never, schema, added, dropped, have }
}

describe('migration 533 — nivaro_workflow_transitions.open_when', () => {
  it('adds one nullable text column (nvarchar(max) on MSSQL), once', async () => {
    const f = fakeKnex(['id', 'require_owner', 'allow_creator'])
    await up(f.knex)
    expect(f.added).toEqual([{ name: 'open_when', type: 'text', nullable: true }])
    await up(f.knex)
    expect(f.added.length).toBe(1)
  })

  it('does nothing without the table', async () => {
    const f = fakeKnex([], false)
    await up(f.knex)
    await down(f.knex)
    expect(f.schema.alterTable).not.toHaveBeenCalled()
  })

  it('down drops only open_when, and only when it is there', async () => {
    const f = fakeKnex(['id', 'allow_creator', 'open_when'])
    await down(f.knex)
    expect(f.dropped).toEqual(['open_when'])
    await down(f.knex)
    expect(f.dropped).toEqual(['open_when'])
    expect(f.have.has('allow_creator')).toBe(true)
  })
})
