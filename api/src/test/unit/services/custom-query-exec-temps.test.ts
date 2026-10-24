import { beforeEach, describe, expect, it, vi } from 'vitest'

// A wrapper's top-level #temp tables outlive the raw batch on a pooled
// connection: the executor drops every #temp the SQL builds before AND after
// the run on that same connection, also when the run fails.
const fake = vi.hoisted(() => ({
  batches: [] as string[],
  failMain: false,
  failCleanup: false,
  released: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../services/traffic-inflight.js', () => ({ trackStatement: () => () => {} }))
vi.mock('../../../db/index.js', () => {
  class Request {
    handlers: Record<string, (...a: unknown[]) => void> = {}
    constructor(
      public sql: string,
      public cb: (err: Error | null) => void
    ) {}
    on(ev: string, h: (...a: unknown[]) => void) {
      this.handlers[ev] = h
    }
    once(ev: string, h: (...a: unknown[]) => void) {
      this.handlers[ev] = h
    }
    setTimeout() {}
  }
  const conn: Record<string, unknown> = {
    execSqlBatch(req: Request) {
      fake.batches.push(req.sql)
      queueMicrotask(() => {
        const isCleanup = req.sql.startsWith('IF OBJECT_ID')
        if (isCleanup && fake.failCleanup) return req.cb(new Error('broken'))
        if (!isCleanup && !req.sql.startsWith('IF @@TRANCOUNT') && fake.failMain) {
          return req.cb(new Error('timeout'))
        }
        req.handlers.row?.([{ metadata: { colName: 'n' }, value: 1 }])
        req.handlers.requestCompleted?.()
        req.cb(null)
      })
    }
  }
  const client = {
    _driver: () => ({ Request }),
    acquireConnection: async () => conn,
    releaseConnection: async (c: Record<string, unknown>) => {
      fake.released.push({ ...c })
    }
  }
  return { db: { client } }
})

import { execCustomQuerySql } from '../../../services/custom-query-exec.js'

const WRAPPER = `CREATE TABLE #f (x int)
INSERT INTO #f EXEC dbo.p :y
SELECT * INTO #w FROM #f
SELECT * FROM #w`

describe('execCustomQuerySql #temp cleanup', () => {
  beforeEach(() => {
    fake.batches = []
    fake.failMain = false
    fake.failCleanup = false
    fake.released = []
  })

  it('drops every #temp before and after a successful run', async () => {
    const rows = await execCustomQuerySql(WRAPPER, { y: 1 })
    expect(rows).toEqual([{ n: 1 }])
    const drop =
      "IF OBJECT_ID('tempdb..#f') IS NOT NULL DROP TABLE #f;\nIF OBJECT_ID('tempdb..#w') IS NOT NULL DROP TABLE #w;"
    expect(fake.batches).toEqual([drop, WRAPPER.replace(':y', '1'), drop])
    expect(fake.released[0]?.__knex__disposed).toBeUndefined()
  })

  it('still drops them after a failed run, then rolls back and rethrows', async () => {
    fake.failMain = true
    await expect(execCustomQuerySql(WRAPPER, { y: 1 })).rejects.toThrow('timeout')
    expect(fake.batches[2]).toBe('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION')
    expect(fake.batches[3]).toContain("IF OBJECT_ID('tempdb..#w')")
    expect(fake.released).toHaveLength(1)
  })

  it('sends nothing extra for SQL without #temps', async () => {
    await execCustomQuerySql('EXEC dbo.report :y', { y: 2 })
    expect(fake.batches).toEqual(['EXEC dbo.report 2'])
  })

  it('retires the connection when the cleanup cannot run', async () => {
    fake.failCleanup = true
    await expect(execCustomQuerySql(WRAPPER, { y: 1 })).rejects.toThrow(/prepare/)
    expect(fake.released[0]?.__knex__disposed).toBeTruthy()
  })
})
