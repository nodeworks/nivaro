import { describe, expect, it, vi } from 'vitest'
import { down, up } from '../../../db/migrations/526_group_form_width.js'

/** Fake knex schema: which nivaro_field_groups columns exist, and what each alter did. */
function fakeKnex(columns: string[]) {
  const have = new Set(columns)
  const added: Array<{ name: string; length?: number; nullable: boolean }> = []
  const dropped: string[] = []
  const schema = {
    hasColumn: vi.fn(async (_t: string, c: string) => have.has(c)),
    alterTable: vi.fn(async (_t: string, cb: (t: unknown) => void) => {
      cb({
        string(name: string, length?: number) {
          const col = { name, length, nullable: false }
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

describe('migration 526 — nivaro_field_groups.form_width', () => {
  it('adds a nullable form_width once and leaves read_width alone', async () => {
    const f = fakeKnex(['id', 'read_width'])
    await up(f.knex)
    expect(f.added).toEqual([{ name: 'form_width', length: 12, nullable: true }])
    await up(f.knex)
    expect(f.added.length).toBe(1)
    expect(f.have.has('read_width')).toBe(true)
  })

  it('down drops only form_width, and only when it is there', async () => {
    const f = fakeKnex(['id', 'read_width', 'form_width'])
    await down(f.knex)
    expect(f.dropped).toEqual(['form_width'])
    await down(f.knex)
    expect(f.dropped).toEqual(['form_width'])
    expect(f.have.has('read_width')).toBe(true)
  })
})
