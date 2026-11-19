import { describe, expect, it } from 'vitest'
import { readableIssue } from '../../../services/issue-readable.js'
import { deadlockIssue, victimsOnlyRead } from '../../../services/system-issues.js'

// Production 2026-11-18 21:03 ET: two readiness catalog reads lost to the DBA's nightly
// ALTER INDEX job. The issue said "Two database updates blocked each other … whoever was
// saving may have seen an error" — nobody was saving.
const proc = (id: string, attrs: string, buf: string) =>
  `<process id="${id}" ${attrs}><executionStack/><inputbuf>\n${buf}\n</inputbuf></process>`
const READS = `<deadlock><victim-list><victimProcess id="p1"/><victimProcess id="p2"/></victim-list><process-list>${proc(
  'p1',
  'trancount="0" clientapp="nivaro-api@​production" transactionname="WstrObjDefI4I4"',
  'SELECT o.name, o.type, m.definition FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id'
)}${proc(
  'p2',
  'trancount="0" clientapp="nivaro-api@​production" transactionname="WstrObjDefI4I4"',
  '\n    SELECT p.name, m.definition\n    FROM sys.procedures p'
)}${proc(
  'p3',
  'trancount="1" clientapp="SQLAgent - TSQL JobStep (Job 0xBA1242B92CBA32458CF6108A80E90526 : Step 1)" transactionname="ALTER INDEX"',
  'ALTER INDEX ALL ON dbo.x REBUILD'
)}</process-list></deadlock>`
const WRITE = READS.replace(
  'trancount="0" clientapp="nivaro-api@​production" transactionname="WstrObjDefI4I4"',
  'trancount="1" clientapp="nivaro-api@​production" transactionname="user_transaction"'
)

/** The issue log's reading of a stored server issue (title = "[server] <route>: <message>"). */
const read = (message: string) => readableIssue({ title: `[server] deadlock-sweep: ${message}` })

describe('deadlocks where only reads lost', () => {
  it('knows every victim was a plain read outside a transaction', () => {
    expect(victimsOnlyRead(READS)).toBe(true)
    expect(victimsOnlyRead(WRITE)).toBe(false)
    expect(victimsOnlyRead('<deadlock/>')).toBe(false)
  })

  it('is low severity and names what it lost to', () => {
    const i = deadlockIssue('2026-11-19T02:03:12.822Z', READS)
    expect(i.severity).toBe('low')
    expect(i.message).toMatch(/^SQL deadlock at 2026-11-19T02:03:12\.822Z \(only reads lost\)/)
    expect(i.message).toMatch(/other side: a SQL Server Agent job \(ALTER INDEX\)$/)
    const r = read(i.message)
    expect(r?.title).toMatch(
      /^A database read gave way to a SQL Server Agent job \(ALTER INDEX\) at /
    )
    expect(r?.description).toMatch(/nobody's save was cancelled/)
  })

  it('a write that lost stays high with the old wording', () => {
    const i = deadlockIssue('2026-11-19T02:03:12.822Z', WRITE)
    expect(i.severity).toBe('high')
    expect(i.message).not.toMatch(/only reads lost/)
    expect(read(i.message)?.title).toMatch(/^Two database updates blocked each other/)
  })
})
