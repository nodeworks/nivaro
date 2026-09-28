import { describe, expect, it } from 'vitest'
import { isUnguarded, judgeProcTransaction } from '../../../services/proc-transaction-lint.js'

describe('judgeProcTransaction (#779)', () => {
  it('BEGIN TRAN without XACT_ABORT or a rolling-back CATCH is unguarded', () => {
    const f = judgeProcTransaction('p', 'CREATE PROC p AS BEGIN TRAN; UPDATE t SET a = 1; COMMIT')
    expect(f).toMatchObject({ opens_transaction: true, xact_abort: false, catch_rollback: false })
    expect(isUnguarded(f)).toBe(true)
  })
  it('SET XACT_ABORT ON guards it', () => {
    const f = judgeProcTransaction(
      'p',
      'CREATE PROC p AS SET NOCOUNT ON; SET XACT_ABORT ON; BEGIN TRANSACTION; COMMIT'
    )
    expect(isUnguarded(f)).toBe(false)
  })
  it('a CATCH that rolls back guards it; a CATCH that only logs does not', () => {
    const good = judgeProcTransaction(
      'p',
      'BEGIN TRY BEGIN TRAN; COMMIT END TRY BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK; THROW END CATCH'
    )
    expect(isUnguarded(good)).toBe(false)
    const bad = judgeProcTransaction(
      'p',
      'BEGIN TRY BEGIN TRAN; COMMIT END TRY BEGIN CATCH PRINT ERROR_MESSAGE() END CATCH'
    )
    expect(isUnguarded(bad)).toBe(true)
  })
  it('a transaction mentioned only in a comment does not count', () => {
    const f = judgeProcTransaction('p', '-- BEGIN TRAN here would be wrong\nSELECT 1')
    expect(f.opens_transaction).toBe(false)
  })
})
