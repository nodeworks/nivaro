import { describe, expect, it } from 'vitest'
import { describeDbRefusal, reasonWithoutSql } from '../../../lib/db-refusal.js'

describe('database refusals', () => {
  it('reads a foreign key refusal on write as a missing link', () => {
    const r = describeDbRefusal(
      new Error(
        'insert into [regions] ([name]) values (@p0) - The INSERT statement conflicted with the FOREIGN KEY constraint "fk_regions_divisions". The conflict occurred in database "prod", table "dbo.divisions", column \'id\'.'
      )
    )
    expect(r).toEqual({
      status: 422,
      code: 'LINKED_RECORD_MISSING',
      message: 'A linked record does not exist (fk_regions_divisions)'
    })
  })

  it('reads a refused delete as a record still in use', () => {
    const r = describeDbRefusal(
      new Error(
        'The DELETE statement conflicted with the REFERENCE constraint "fk_lines_orders". The conflict occurred in database "prod", table "dbo.lines", column \'order\'.'
      )
    )
    expect(r?.status).toBe(409)
    expect(r?.code).toBe('RECORD_IN_USE')
    expect(r?.message).not.toMatch(/prod|dbo/)
  })

  it('reads unique violations, both wordings', () => {
    expect(
      describeDbRefusal(
        new Error(
          "Violation of UNIQUE KEY constraint 'uq_orders_number'. Cannot insert duplicate key in object 'dbo.orders'. The duplicate key value is (12)."
        )
      )?.code
    ).toBe('DUPLICATE_RECORD')
    const r = describeDbRefusal(
      new Error(
        "Cannot insert duplicate key row in object 'dbo.forecasts' with unique index 'UX_forecasts_workflow_year'. The duplicate key value is (5, 2026)."
      )
    )
    expect(r?.message).toBe(
      'A record with these values already exists (UX_forecasts_workflow_year)'
    )
    expect(r?.message).not.toMatch(/2026|dbo/)
  })

  it('finds the message inside an aggregate error', () => {
    const agg = Object.assign(new Error('insert into [x] - '), {
      errors: [
        {
          message:
            'The INSERT statement conflicted with the FOREIGN KEY constraint "fk_a". The conflict occurred in database "d", table "dbo.t".'
        }
      ]
    })
    expect(describeDbRefusal(agg)?.code).toBe('LINKED_RECORD_MISSING')
  })

  it('names the column of a value that does not fit', () => {
    expect(
      describeDbRefusal(
        new Error(
          "String or binary data would be truncated in table 'db.dbo.orders', column 'code'. Truncated value: 'ABCDEFG'."
        )
      )
    ).toEqual({ status: 422, code: 'VALUE_TOO_LONG', message: 'The value for code is too long' })
  })

  it('leaves everything else alone', () => {
    expect(
      describeDbRefusal(new Error('Timeout: Request failed to complete in 15000ms'))
    ).toBeNull()
    expect(describeDbRefusal(new Error("Invalid column name 'x'."))).toBeNull()
    expect(describeDbRefusal(null)).toBeNull()
  })

  it('strips a leading statement from a driver message', () => {
    expect(reasonWithoutSql("select * from [t] where [a] = @p0 - Invalid column name 'a'.")).toBe(
      "Invalid column name 'a'."
    )
    expect(reasonWithoutSql('Budget - over the cap')).toBe('Budget - over the cap')
  })
})
