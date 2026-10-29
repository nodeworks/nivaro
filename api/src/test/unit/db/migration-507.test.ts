import { describe, expect, it } from 'vitest'
import * as m from '../../../db/migrations/507_managed_procedures.js'

// Minimal fake knex: records the tables and columns created / dropped.
function fake(tables: string[]) {
  const log = { created: [] as string[], cols: [] as string[], dropped: [] as string[] }
  const tb = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: unknown[]) => {
            if (['string', 'text', 'integer', 'uuid', 'dateTime', 'increments'].includes(prop)) {
              log.cols.push(`${prop}:${String(args[0])}${args[1] != null ? `:${args[1]}` : ''}`)
            }
            if (prop === 'unique' && Array.isArray(args[0])) {
              log.cols.push(`unique:${(args[0] as string[]).join(',')}`)
            }
            return tb()
          }
        }
      }
    )
  const knex = {
    client: { config: { client: 'mssql' } },
    raw: (sql: string) => ({ sql }),
    fn: { now: () => 'now' },
    schema: {
      hasTable: async (t: string) => tables.includes(t),
      createTable: async (t: string, cb: (b: unknown) => void) => {
        log.created.push(t)
        cb(tb())
      },
      dropTableIfExists: async (t: string) => void log.dropped.push(t)
    }
  }
  return { knex: knex as never, log }
}

describe('migration 507 — managed procedures', () => {
  it('creates both tables with the agreed columns', async () => {
    const { knex, log } = fake(['nivaro_users'])
    await m.up(knex)
    expect(log.created).toEqual(['nivaro_managed_procedures', 'nivaro_managed_procedure_versions'])
    for (const c of [
      'string:name:128',
      'text:body',
      'string:body_hash:64',
      'integer:version',
      'string:deployed_hash:64',
      'dateTime:deployed_at',
      'string:deployed_by:120',
      'string:description:500',
      'string:owner:120',
      'dateTime:updated_at',
      'uuid:updated_by',
      'dateTime:dropped_at',
      'integer:procedure_id',
      'string:note:500',
      'dateTime:created_at',
      'uuid:created_by',
      'unique:procedure_id,version'
    ]) {
      expect(log.cols).toContain(c)
    }
  })

  it('is guarded: an existing table is left alone', async () => {
    const { knex, log } = fake(['nivaro_managed_procedures', 'nivaro_managed_procedure_versions'])
    await m.up(knex)
    expect(log.created).toEqual([])
  })

  it('down drops only its two tables, children first', async () => {
    const { knex, log } = fake([])
    await m.down(knex)
    expect(log.dropped).toEqual(['nivaro_managed_procedure_versions', 'nivaro_managed_procedures'])
  })
})
