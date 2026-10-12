import type { Knex } from 'knex'
import { describe, expect, it, vi } from 'vitest'
import { up } from '../../../db/migrations/427_realtime_event_pipeline.js'

/** A migration knex stand-in; `existing` = the tables already there. */
function fakeKnex(client: string, existing: string[]) {
  const raw = vi.fn(async (_sql: string) => [])
  const created: string[] = []
  const knex = {
    client: { config: { client } },
    raw,
    schema: {
      hasTable: vi.fn(async (t: string) => existing.includes(t)),
      createTable: vi.fn(async (t: string) => {
        created.push(t)
      })
    }
  }
  return { knex: knex as unknown as Knex, raw, created }
}

describe('migration 427 realtime event pipeline', () => {
  it('creates both tables and the announce procedure on SQL Server', async () => {
    const { knex, raw, created } = fakeKnex('mssql', [])
    await up(knex)
    expect(created).toEqual(['nivaro_event_journal', 'nivaro_raw_writes'])
    const procSql = raw.mock.calls.map((c) => String(c[0])).find((s) => /PROCEDURE/.test(s))
    expect(procSql).toMatch(/CREATE OR ALTER PROCEDURE nivaro_announce_writes/)
  })

  it('a rerun that finds the tables creates nothing', async () => {
    const { knex, created } = fakeKnex('mssql', ['nivaro_event_journal', 'nivaro_raw_writes'])
    await up(knex)
    expect(created).toEqual([])
  })

  it('other dialects get the tables without the procedure', async () => {
    const { knex, raw, created } = fakeKnex('pg', [])
    await up(knex)
    expect(created).toHaveLength(2)
    expect(raw.mock.calls.some((c) => /PROCEDURE/.test(String(c[0])))).toBe(false)
  })
})
