import { describe, expect, it, vi } from 'vitest'
import { down, up } from '../../../db/migrations/456_layout_versions_keep_history.js'

/** Just enough knex for the migration: schema.hasTable + raw (sys.* lookup, DROP). */
function fakeKnex(opts: { client: string; hasTable: boolean; fks: string[] }) {
  const raw = vi.fn(async (sql: string) => {
    if (/sys\.foreign_keys/.test(sql)) return opts.fks.map((name) => ({ name }))
    if (/information_schema/.test(sql)) return { rows: opts.fks.map((name) => ({ name })) }
    return undefined
  })
  const knex = {
    raw,
    client: { config: { client: opts.client } },
    schema: { hasTable: vi.fn(async () => opts.hasTable) }
  }
  return { knex: knex as never, raw }
}

const drops = (raw: ReturnType<typeof vi.fn>) =>
  raw.mock.calls.filter(([sql]) => /DROP CONSTRAINT/.test(String(sql))).map(([, b]) => b)

describe('migration 456 — layout versions keep history', () => {
  it('drops the looked-up layout_id FK on SQL Server', async () => {
    const { knex, raw } = fakeKnex({
      client: 'mssql',
      hasTable: true,
      fks: ['nivaro_layout_versions_layout_id_foreign']
    })
    await up(knex)
    expect(drops(raw)).toEqual([
      ['nivaro_layout_versions', 'nivaro_layout_versions_layout_id_foreign']
    ])
  })

  it('does nothing when the FK is already gone (re-run safe)', async () => {
    const { knex, raw } = fakeKnex({ client: 'mssql', hasTable: true, fks: [] })
    await up(knex)
    expect(drops(raw)).toEqual([])
  })

  it('does nothing when the versions table does not exist', async () => {
    const { knex, raw } = fakeKnex({ client: 'mssql', hasTable: false, fks: ['x'] })
    await up(knex)
    expect(raw).not.toHaveBeenCalled()
  })

  it('drops it on Postgres through information_schema', async () => {
    const { knex, raw } = fakeKnex({ client: 'pg', hasTable: true, fks: ['fk_lv'] })
    await up(knex)
    expect(drops(raw)).toEqual([['nivaro_layout_versions', 'fk_lv']])
  })

  it('down re-adds nothing', async () => {
    await expect(down()).resolves.toBeUndefined()
  })
})
