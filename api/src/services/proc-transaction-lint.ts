/**
 * Stored procedures that open a transaction without SET XACT_ABORT ON (#779).
 *
 * With XACT_ABORT off, a runtime error inside BEGIN TRAN … COMMIT does not
 * end the transaction: the batch stops, the connection goes back to the
 * pool mid-transaction, and the next caller on that connection inherits it
 * (sync_nami_locations did exactly this). Every raw EXEC path now rolls an
 * open transaction back before releasing, but the procedure itself is the
 * right place for the fix — this lint names the ones that need it.
 */
import { db, isMssql } from '../db/index.js'

export interface ProcTransactionFinding {
  procedure: string
  opens_transaction: boolean
  xact_abort: boolean
  /** A TRY/CATCH that rolls back covers the same failure. */
  catch_rollback: boolean
}

const stripComments = (sql: string) =>
  sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Pure: judge one procedure body. */
export function judgeProcTransaction(name: string, definition: string): ProcTransactionFinding {
  const text = stripComments(definition)
  const opens = /\bBEGIN\s+TRAN(?:SACTION)?\b/i.test(text)
  const xact = /\bSET\s+XACT_ABORT\s+ON\b/i.test(text)
  const catchRollback = /\bBEGIN\s+CATCH\b[\s\S]*?\bROLLBACK\b[\s\S]*?\bEND\s+CATCH\b/i.test(text)
  return {
    procedure: name,
    opens_transaction: opens,
    xact_abort: xact,
    catch_rollback: catchRollback
  }
}

export function isUnguarded(f: ProcTransactionFinding): boolean {
  return f.opens_transaction && !f.xact_abort && !f.catch_rollback
}

/** Every procedure that opens a transaction, judged. MSSQL only. */
export async function procTransactionLint(): Promise<ProcTransactionFinding[]> {
  if (!isMssql()) return []
  const rows = (await db.raw(`
    SELECT p.name, m.definition
    FROM sys.procedures p
    JOIN sys.sql_modules m ON m.object_id = p.object_id
    WHERE m.definition LIKE '%BEGIN TRAN%'
  `)) as Array<{ name: string; definition: string }>
  return (Array.isArray(rows) ? rows : [])
    .map((r) => judgeProcTransaction(String(r.name), String(r.definition ?? '')))
    .filter((f) => f.opens_transaction)
    .sort((a, b) => a.procedure.localeCompare(b.procedure))
}
