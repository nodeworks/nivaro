import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/run-long.js', () => ({ runLongSql: vi.fn(async () => []) }))

import type { Knex } from 'knex'
import { up } from '../../../db/migrations/351_integration_event_chains.js'
import { runLongSql } from '../../../services/run-long.js'

/** A migration knex stand-in: every table and column already exists. */
function fakeKnex(client: string) {
  const raw = vi.fn(async (_sql: string) => [])
  const indexed: string[] = []
  const knex = {
    client: { config: { client } },
    raw,
    schema: {
      hasTable: vi.fn(async () => true),
      hasColumn: vi.fn(async () => true),
      alterTable: vi.fn(async (_t: string, fn: (t: unknown) => void) => {
        fn({ index: (_cols: string[], name: string) => indexed.push(name) })
      }),
      createTable: vi.fn()
    }
  }
  return { knex: knex as unknown as Knex, raw, indexed }
}

beforeEach(() => vi.mocked(runLongSql).mockClear())

describe('migration 351 chain indexes', () => {
  it('mssql: a filtered index on the MIGRATION connection, never the app handle', async () => {
    const { knex, raw } = fakeKnex('mssql')
    await up(knex)
    expect(runLongSql).toHaveBeenCalledTimes(7)
    for (const [sql, opts] of vi.mocked(runLongSql).mock.calls) {
      expect(sql).toMatch(
        /IF NOT EXISTS .*sys\.indexes.*\n\s*CREATE INDEX ix_\w+_chain_id ON \w+ \(chain_id\) WHERE chain_id IS NOT NULL/
      )
      expect(opts).toEqual({ knex, timeoutMs: 60 * 60 * 1000 })
    }
    expect(raw).not.toHaveBeenCalled()
  })

  it('postgres: an idempotent partial index', async () => {
    const { knex, raw } = fakeKnex('pg')
    await up(knex)
    expect(runLongSql).not.toHaveBeenCalled()
    expect(raw).toHaveBeenCalledTimes(7)
    expect(raw.mock.calls[0][0]).toBe(
      'CREATE INDEX IF NOT EXISTS ix_nivaro_activity_chain_id ON nivaro_activity (chain_id) WHERE chain_id IS NOT NULL'
    )
  })

  it('any other dialect: a plain index, and a rerun that finds it is not an error', async () => {
    const { knex, indexed } = fakeKnex('mysql2')
    await up(knex)
    expect(runLongSql).not.toHaveBeenCalled()
    expect(indexed).toContain('ix_nivaro_flow_runs_chain_id')

    const again = fakeKnex('mysql2')
    vi.mocked(again.knex.schema.alterTable).mockRejectedValue(
      new Error("Duplicate key name 'ix_nivaro_activity_chain_id'")
    )
    await expect(up(again.knex)).resolves.toBeUndefined()
  })
})
