import { describe, expect, it } from 'vitest'
import { diffSchema, recordEffects, summarizeEffects } from '../../../db/migration-effects.js'

describe('migration effects', () => {
  it('reports what a migration added and removed', () => {
    const before = new Set(['table a', 'column a.id int not null', 'index a.ix_old'])
    const after = new Set([
      'table a',
      'column a.id int not null',
      'column a.note nvarchar null',
      'table b'
    ])
    const e = diffSchema(before, after)
    expect(e.added).toEqual(['column a.note nvarchar null', 'table b'])
    expect(e.removed).toEqual(['index a.ix_old'])
    expect(summarizeEffects(e)).toBe('+1 table · +1 column · −1 index')
  })

  it('says so when nothing in the schema moved', () => {
    const same = new Set(['table a'])
    expect(summarizeEffects(diffSchema(same, new Set(same)))).toMatch(/^No schema change/)
  })

  it('never counts its own bookkeeping table as the migration’s work', () => {
    const e = diffSchema(
      new Set(),
      new Set(['table nivaro_migration_effects', 'column nivaro_migration_effects.id int not null'])
    )
    expect(e.added).toEqual([])
  })

  it('pluralises indexes', () => {
    expect(summarizeEffects({ added: ['index a.x', 'index a.y'], removed: [] })).toBe('+2 indexes')
  })

  it('runs the migration and returns its result even when the schema cannot be listed', async () => {
    let ran = false
    const knex = {
      client: { config: { client: 'mssql' } },
      raw: async () => {
        throw new Error('no connection')
      }
    }
    const wrapped = recordEffects('001_x.ts', 'up', async () => {
      ran = true
      return 'done'
    })
    // biome-ignore lint/suspicious/noExplicitAny: minimal knex stand-in
    await expect(wrapped(knex as any)).resolves.toBe('done')
    expect(ran).toBe(true)
  })

  it('lets a failing migration fail', async () => {
    const knex = { client: { config: { client: 'mssql' } }, raw: async () => [] }
    const wrapped = recordEffects('002_x.ts', 'up', async () => {
      throw new Error('boom')
    })
    // biome-ignore lint/suspicious/noExplicitAny: minimal knex stand-in
    await expect(wrapped(knex as any)).rejects.toThrow('boom')
  })
})
