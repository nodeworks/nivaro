import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/run-long.js', () => ({ runLongSql: vi.fn(async () => []) }))

import type { Knex } from 'knex'
import { down, up } from '../../../db/migrations/535_notifications_timestamp_index.js'
import { runLongSql } from '../../../services/run-long.js'

function fakeKnex(client: string, columns: string[] | null) {
  const raw = vi.fn(async (_sql: string) => [])
  const have = new Set(columns ?? [])
  const knex = {
    client: { config: { client } },
    raw,
    schema: {
      hasTable: vi.fn(async () => columns != null),
      hasColumn: vi.fn(async (_t: string, c: string) => have.has(c)),
      alterTable: vi.fn()
    }
  }
  return { knex: knex as unknown as Knex, raw, schema: knex.schema }
}

beforeEach(() => vi.mocked(runLongSql).mockClear())

describe('migration 535 — nivaro_notifications timestamp index', () => {
  it('builds one guarded CREATE INDEX with the INCLUDE columns the table has, on its own long request', async () => {
    const f = fakeKnex('mssql', ['timestamp', 'status', 'read_at', 'recipient', 'category'])
    await up(f.knex)
    expect(runLongSql).toHaveBeenCalledTimes(1)
    const [sql, opts] = vi.mocked(runLongSql).mock.calls[0] as [string, unknown]
    expect(sql).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = 'ix_nivaro_notifications_timestamp'/
    )
    expect(sql).toMatch(
      /CREATE INDEX ix_nivaro_notifications_timestamp ON nivaro_notifications \(\[timestamp\]\) INCLUDE \(\[status\], \[read_at\], \[recipient\], \[category\]\)$/
    )
    // An index only: nothing alters a column (production is a replication publisher).
    expect(sql).not.toMatch(/ALTER|DROP|ADD /i)
    expect(f.schema.alterTable).not.toHaveBeenCalled()
    expect(opts).toEqual({ knex: f.knex, timeoutMs: 60 * 60 * 1000 })
  })

  it('does nothing without the table or the column', async () => {
    await up(fakeKnex('mssql', null).knex)
    await up(fakeKnex('mssql', ['status']).knex)
    await up(fakeKnex('pg', null).knex)
    expect(runLongSql).not.toHaveBeenCalled()
  })

  it('builds the same index on Postgres through knex, INCLUDE columns kept', async () => {
    const f = fakeKnex('pg', ['timestamp', 'status', 'recipient'])
    f.raw.mockImplementation((async () => ({ rows: [] })) as never)
    await up(f.knex)
    expect(runLongSql).not.toHaveBeenCalled()
    const create = f.raw.mock.calls.map((c) => String(c[0])).find((q) => /CREATE INDEX/.test(q))
    expect(create).toBe(
      'CREATE INDEX "ix_nivaro_notifications_timestamp" ON "nivaro_notifications" ("timestamp") INCLUDE ("status", "recipient")'
    )
  })

  it('down drops only that index, only if it is there', async () => {
    const f = fakeKnex('mssql', ['timestamp'])
    await down(f.knex)
    expect(f.raw.mock.calls[0]?.[0]).toMatch(
      /IF EXISTS .*ix_nivaro_notifications_timestamp[\s\S]*DROP INDEX ix_nivaro_notifications_timestamp ON nivaro_notifications/
    )
  })
})
