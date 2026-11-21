import { describe, expect, it } from 'vitest'
import { runsProcedure, sqliteProcedureRefusal } from '../../../services/staged-imports.js'

// SQLite has no stored procedures: an import that would end in its procedure is refused there
// (upload 501, run error naming the procedure) instead of failing on `near "CALL"`.
describe('runsProcedure', () => {
  const has = (k: string) => k === 'efp-ops:invoices'
  it('is true for a procedure definition with no processor taking the rows', () => {
    expect(runsProcedure({ procedure: 'usp_load', processor: null }, has)).toBe(true)
    expect(runsProcedure({ procedure: 'usp_load', processor: 'proc' }, has)).toBe(true)
    expect(runsProcedure({ procedure: 'usp_load', processor: 'gone:proc' }, has)).toBe(true)
  })
  it('is false when a processor or service mapping takes the rows, or there is no procedure', () => {
    expect(runsProcedure({ procedure: 'usp_load', processor: 'efp-ops:invoices' }, has)).toBe(false)
    expect(runsProcedure({ procedure: 'usp_load', processor: 'service' }, has)).toBe(false)
    expect(runsProcedure({ procedure: null, processor: null }, has)).toBe(false)
  })
  it('names the procedure in the refusal', () => {
    expect(sqliteProcedureRefusal('usp_load')).toMatch(/usp_load.*SQLite has no stored procedures/)
  })
})
