import { describe, expect, it, vi } from 'vitest'
import { down } from '../../../db/migrations/391_db_tuning.js'

/** A knex whose schema has the tables and columns named, recording what down() drops. */
function fakeKnex(tables: string[], columns: Record<string, string[]>) {
  const dropped: string[] = []
  const dropColumn = vi.fn((table: string, col: string) => dropped.push(`${table}.${col}`))
  const schema = {
    hasTable: async (t: string) => tables.includes(t),
    hasColumn: async (t: string, c: string) => (columns[t] ?? []).includes(c),
    dropTable: async (t: string) => {
      dropped.push(t)
    },
    alterTable: async (t: string, cb: (b: { dropColumn: (c: string) => void }) => void) =>
      cb({ dropColumn: (c) => dropColumn(t, c) })
  }
  return { knex: { schema } as never, dropped }
}

describe('migration 391 down', () => {
  it('drops both tables and the nivaro_settings.db_tuning column', async () => {
    const { knex, dropped } = fakeKnex(['nivaro_tuning_param_sets', 'nivaro_tuning_proposals'], {
      nivaro_settings: ['id', 'db_tuning']
    })
    await down(knex)
    expect(dropped).toEqual([
      'nivaro_tuning_param_sets',
      'nivaro_tuning_proposals',
      'nivaro_settings.db_tuning'
    ])
  })
  it('is guarded: nothing there, nothing dropped', async () => {
    const { knex, dropped } = fakeKnex([], { nivaro_settings: ['id'] })
    await down(knex)
    expect(dropped).toEqual([])
  })
})
