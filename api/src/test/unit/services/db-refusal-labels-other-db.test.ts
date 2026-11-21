import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { refusalDetail } from '../../../lib/db-refusal.js'

// Postgres and MariaDB name only the index of a duplicate: the table comes from the catalogue.
let dialect = 'pg'
vi.mock('../../../db/dialect/items-query.js', () => ({ dialectOf: () => dialect }))
vi.mock('../../../services/collections.js', () => ({
  getFields: vi.fn(async (collection: string) =>
    collection === 'nivaro_blackout_dates'
      ? [{ field: 'date', db_column: null, label: 'Date' }]
      : []
  ),
  getCollection: vi.fn(async () => null)
}))

const { _resetRefusalLabelCache, labelDbRefusal } = await import(
  '../../../services/db-refusal-labels.js'
)
const raw = (db as unknown as { raw: ReturnType<typeof vi.fn<(...args: any[]) => any>> }).raw

beforeEach(() => {
  _resetRefusalLabelCache()
  raw.mockReset()
  raw.mockResolvedValue([])
})

describe('duplicate refusals that name no table', () => {
  it('Postgres: the index name finds the table and its column', async () => {
    dialect = 'pg'
    const err = Object.assign(
      new Error(
        'insert into "nivaro_blackout_dates" ("date") values ($1) - duplicate key value violates unique constraint "nivaro_blackout_dates_date_unique"'
      ),
      { detail: 'Key (date)=(2026-12-25) already exists.' }
    )
    const detail = refusalDetail(err)!
    expect(detail).toMatchObject({ kind: 'duplicate', value: '2026-12-25' })
    expect(detail.table).toBeUndefined()
    raw.mockResolvedValueOnce({ rows: [{ tbl: 'nivaro_blackout_dates', col: 'date' }] })
    const out = await labelDbRefusal(detail, { collection: 'nivaro_blackout_dates' })
    expect(out).toEqual({
      message: 'Another record already has this Date (2026-12-25)',
      hint: 'Use a different Date, or open the existing record instead.',
      fields: ['date']
    })
    expect(String(raw.mock.calls[0][0])).toContain('pg_index')
    expect(raw.mock.calls[0][1]).toEqual(['nivaro_blackout_dates_date_unique'])
  })

  it('MariaDB: taken only when one table has an index of that name', async () => {
    dialect = 'mysql'
    const err = new Error(
      "insert into `nivaro_blackout_dates` (`date`) values (?) - Duplicate entry '2026-12-25' for key 'nivaro_blackout_dates_date_unique'"
    )
    const detail = refusalDetail(err)!
    expect(detail.table).toBeUndefined()
    raw.mockResolvedValueOnce([[{ tbl: 'nivaro_blackout_dates', col: 'date' }], []])
    expect((await labelDbRefusal(detail, {}))?.fields).toEqual(['date'])

    _resetRefusalLabelCache()
    raw.mockResolvedValueOnce([
      [
        { tbl: 'a', col: 'x' },
        { tbl: 'b', col: 'y' }
      ],
      []
    ])
    expect(await labelDbRefusal(detail, {})).toBeNull()
  })

  it('SQL Server keeps its table-scoped lookup only', async () => {
    dialect = 'mssql'
    const detail = refusalDetail(
      new Error(
        "Cannot insert duplicate key row in object 'dbo.nivaro_blackout_dates' with unique index 'ux_d'. The duplicate key value is (2026-12-25)."
      )
    )!
    raw.mockResolvedValueOnce([{ col: 'date' }])
    await labelDbRefusal(detail, {})
    expect(raw).toHaveBeenCalledTimes(1)
    expect(String(raw.mock.calls[0][0])).toContain('sys.indexes')
  })
})
