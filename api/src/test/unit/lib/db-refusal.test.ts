import { describe, expect, it } from 'vitest'
import {
  describeDbRefusal,
  describeValueRefusal,
  messageWithoutSql,
  reasonWithoutSql
} from '../../../lib/db-refusal.js'

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

  it("never reads a conversion or overflow error as the caller's fault on its own", () => {
    // The global handler keeps these 5xx (a SUM overflow is a server bug).
    expect(
      describeDbRefusal(
        new Error('Arithmetic overflow error converting expression to data type int.')
      )
    ).toBeNull()
    expect(
      describeDbRefusal(
        new Error("Conversion failed when converting the nvarchar value 'abc' to data type int.")
      )
    ).toBeNull()
  })
})

describe('describeValueRefusal (caller-sourced paths only)', () => {
  it('reads a conversion error as a value of the wrong type, without the statement', () => {
    expect(
      describeValueRefusal(
        new Error(
          "select top (@p0) [name] from [workflows] where [id] = @p1 - Conversion failed when converting the nvarchar value 'abc' to data type int."
        )
      )
    ).toEqual({
      status: 400,
      code: 'VALUE_TYPE_MISMATCH',
      message: "A value does not match its field's type"
    })
    expect(
      describeValueRefusal(
        new Error('Conversion failed when converting from a character string to uniqueidentifier.')
      )?.code
    ).toBe('VALUE_TYPE_MISMATCH')
  })

  it('reads an overflowing number as out of range', () => {
    expect(
      describeValueRefusal(
        new Error(
          'workflow_lines[0]: Bigint must be safe integer or must be passed as string, saw 1e+308'
        )
      )?.code
    ).toBe('VALUE_OUT_OF_RANGE')
    expect(
      describeValueRefusal(
        new Error('Arithmetic overflow error converting expression to data type int.')
      )?.status
    ).toBe(400)
    expect(describeValueRefusal(new Error('Deadlock victim'))).toBeNull()
  })
})

describe('messageWithoutSql', () => {
  it('keeps the reason and drops the statement, also behind a nested-write label', () => {
    expect(
      messageWithoutSql(new Error("select * from [t] where [a] = @p0 - Invalid column name 'a'."))
    ).toBe("Invalid column name 'a'.")
    expect(
      messageWithoutSql(
        new Error('workflow_lines[0]: insert into [workflow_lines] ([qty]) values (@p0) - Boom')
      )
    ).toBe('workflow_lines[0]: Boom')
  })

  it('strips unbracketed statements and labels with spaces too', () => {
    expect(messageWithoutSql(new Error('select name from workflows where id = 5 - Boom'))).toBe(
      'Boom'
    )
    expect(
      messageWithoutSql(new Error('Line 3 of 4: update t set qty = 1 where id = 2 - Overflow'))
    ).toBe('Line 3 of 4: Overflow')
  })

  it('prefers the reasons of an aggregate error', () => {
    const err = Object.assign(new Error('select [x] from [t] - '), {
      errors: [new Error('Deadlock victim'), new Error('Deadlock victim')]
    })
    expect(messageWithoutSql(err)).toBe('Deadlock victim')
  })

  it('leaves prose alone', () => {
    expect(messageWithoutSql(new Error('Update failed - try again'))).toBe(
      'Update failed - try again'
    )
    expect(messageWithoutSql(new Error('Something broke'))).toBe('Something broke')
  })
})

describe('errorText', () => {
  it('puts the reason before the statement', async () => {
    const { errorText } = await import('../../../lib/db-refusal.js')
    const err = Object.assign(new Error('insert into [orders] ([a]) values (@p0) - '), {
      errors: [new Error("Invalid column name 'a'."), new Error("Invalid column name 'a'.")]
    })
    expect(errorText(err)).toBe(
      "Invalid column name 'a'. — while running: insert into [orders] ([a]) values (@p0)"
    )
  })

  it('keeps a plain error as it is and cuts to the limit', async () => {
    const { errorText } = await import('../../../lib/db-refusal.js')
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('text')).toBe('text')
    expect(errorText(new Error('x'.repeat(50)), 10)).toHaveLength(10)
  })
})
