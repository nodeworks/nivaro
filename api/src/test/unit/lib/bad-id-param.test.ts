import { describe, expect, it } from 'vitest'
import { hasMalformedIdParam, isMalformedIdRefusal } from '../../../lib/bad-id-param.js'

const MSSQL_NAN = new Error(
  "select top (@p0) * from [nivaro_tasks] where [id] = @p1 - Validation failed for parameter 'p1'. Invalid number."
)
const MSSQL_TEXT = new Error(
  "Conversion failed when converting the nvarchar value 'abc' to data type int."
)
const PG = new Error(
  'select * from "nivaro_tasks" where "id" = $1 limit $2 - invalid input syntax for type integer: "NaN"'
)
const PG_UUID = new Error('invalid input syntax for type uuid: "abc"')
const MYSQL = new Error(
  "select * from `nivaro_tasks` where `id` = NaN limit 1 - Unknown column 'NaN' in 'where clause'"
)

describe('malformed path ids', () => {
  it('reads only id-named path parameters that are neither integers nor uuids', () => {
    expect(hasMalformedIdParam({ id: 'undefined' })).toBe(true)
    expect(hasMalformedIdParam({ userId: 'abc' })).toBe(true)
    expect(hasMalformedIdParam({ collection: 'p5_items', item_id: 'x1' })).toBe(true)
    expect(hasMalformedIdParam({ id: '42' })).toBe(false)
    expect(hasMalformedIdParam({ id: '22222222-2222-4222-8222-222222222222' })).toBe(false)
    expect(hasMalformedIdParam({ collection: 'p5_items', key: 'abc' })).toBe(false)
    expect(hasMalformedIdParam(undefined)).toBe(false)
  })

  it('answers 404 for a refused conversion on every engine, only with a malformed id', () => {
    const MYSQL_STRICT = new Error(
      "update `t` set `name` = 'x' where `id` = 'abc' - Truncated incorrect DOUBLE value: 'abc'"
    )
    for (const err of [MSSQL_NAN, MSSQL_TEXT, PG, PG_UUID, MYSQL, MYSQL_STRICT]) {
      expect(isMalformedIdRefusal(err, { id: 'abc' })).toBe(true)
      expect(isMalformedIdRefusal(err, { id: '7' })).toBe(false)
    }
    expect(isMalformedIdRefusal(new Error('Deadlock victim'), { id: 'abc' })).toBe(false)
    const wrapped = Object.assign(new Error('select …'), {
      errors: [{ message: MSSQL_TEXT.message }]
    })
    expect(isMalformedIdRefusal(wrapped, { id: 'abc' })).toBe(true)
  })
})
