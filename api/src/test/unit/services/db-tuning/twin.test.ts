import { describe, expect, it } from 'vitest'
import {
  execStatement,
  judgeTiming,
  provability,
  proveProcedureRewrite,
  renameProcHeader
} from '../../../../services/db-tuning/twin.js'

const READ = `CREATE PROCEDURE dbo.rpt_spend @Zone NVARCHAR(50) = NULL AS
BEGIN
  SET NOCOUNT ON;
  SELECT p.id, SUM(i.amount) AS total FROM invoices i JOIN projects p ON p.id = i.project
  WHERE (@Zone IS NULL OR p.zone = @Zone) GROUP BY p.id
END`

describe('provability', () => {
  it('accepts a read-only body', () => expect(provability('rpt_spend', READ)).toBeNull())
  it('refuses a body that writes a real table', () =>
    expect(provability('x', 'CREATE PROC x AS UPDATE invoices SET amount = 0')).toMatch(/writes/))
  it('allows temp-table writes', () =>
    expect(
      provability(
        'x',
        'CREATE PROC x AS SELECT 1 AS a INTO #t; INSERT INTO #t VALUES (2); SELECT * FROM #t'
      )
    ).toBeNull())
  it('refuses SELECT INTO a real table', () =>
    expect(provability('x', 'CREATE PROC x AS SELECT 1 AS a INTO realtable')).toMatch(/writes/))
  it('ignores temp deletes/drops, join hints and string literals', () => {
    expect(
      provability(
        'x',
        "CREATE PROC x AS DELETE FROM #t; DROP TABLE IF EXISTS #t; UPDATE @v SET a = 1; SELECT N'update invoices' AS s FROM a OPTION (MERGE JOIN)"
      )
    ).toBeNull()
  })
  it('refuses EXEC of a variable and a self-call through a return value', () => {
    expect(provability('x', 'CREATE PROC x AS EXEC @sql')).toMatch(/dynamic/)
    expect(provability('x', 'CREATE PROC x AS EXEC @rc = dbo.x')).toMatch(/itself/)
    expect(provability('x', 'CREATE PROC x AS EXEC xy')).toBeNull()
  })
  it('refuses dynamic SQL, self-reference and linked servers', () => {
    expect(provability('x', "CREATE PROC x AS EXEC sp_executesql N'select 1'")).toMatch(/dynamic/)
    expect(provability('x', 'CREATE PROC x AS EXEC x')).toMatch(/itself/)
    expect(provability('x', 'CREATE PROC x AS SELECT * FROM srv.db.dbo.t')).toMatch(/linked/)
  })
})

describe('renameProcHeader / execStatement', () => {
  it('renames CREATE / CREATE OR ALTER / ALTER headers with or without schema and brackets', () => {
    expect(
      renameProcHeader('CREATE PROCEDURE dbo.rpt_spend AS SELECT 1', 'rpt_spend', 'rpt_spend__tune')
    ).toMatch(/^CREATE OR ALTER PROCEDURE \[dbo\]\.\[rpt_spend__tune\] AS SELECT 1$/)
    expect(
      renameProcHeader('ALTER PROC [rpt_spend]\nAS\nSELECT 1', 'rpt_spend', 'rpt_spend__tune')
    ).toMatch(/^CREATE OR ALTER PROCEDURE \[dbo\]\.\[rpt_spend__tune\]\nAS/)
    expect(renameProcHeader('SELECT 1', 'rpt_spend', 'x')).toBeNull()
  })
  it('binds params as named literals', () => {
    expect(execStatement('rpt_spend', { Zone: "Zone 1's", N: 3, B: true, X: null })).toBe(
      "EXEC [dbo].[rpt_spend] @Zone = N'Zone 1''s', @N = 3, @B = 1, @X = NULL"
    )
  })
})

describe('judgeTiming', () => {
  it('passes when the new median is ≤ 75% and no set is slower', () => {
    expect(
      judgeTiming(
        [
          [1000, 1100],
          [800, 900]
        ],
        [
          [500, 520],
          [400, 410]
        ]
      ).passed
    ).toBe(true)
  })
  it('fails when one set is slower even though the median improved', () => {
    const r = judgeTiming(
      [
        [1000, 1000],
        [300, 300]
      ],
      [
        [100, 100],
        [900, 900]
      ]
    )
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/set 2/)
  })
  it('fails when the median only improved 10%', () => {
    expect(judgeTiming([[1000, 1000]], [[900, 900]]).passed).toBe(false)
  })
})

describe('proveProcedureRewrite with an injected runner', () => {
  function runner(
    rowsFor: (sql: string) => Array<Record<string, unknown>>,
    ms: (sql: string) => number
  ) {
    const calls: string[] = []
    return {
      calls,
      run: async (sql: string) => {
        calls.push(sql)
        const t = ms(sql)
        await new Promise((r) => setTimeout(r, t))
        return rowsFor(sql)
      }
    }
  }
  it('passes an identical, faster twin and deploys/drops it around the runs', async () => {
    const r = runner(
      () => [{ id: 1, total: 5 }],
      (sql) =>
        sql.includes('__tune') && sql.startsWith('EXEC') ? 2 : sql.startsWith('EXEC') ? 20 : 0
    )
    const proof = await proveProcedureRewrite({
      proc: 'rpt_spend',
      oldBody: READ,
      newBody: READ,
      paramSets: [{ Zone: 'Zone 1' }],
      timeoutMs: 1000,
      runner: r.run
    })
    expect(proof.passed).toBe(true)
    expect(proof.method).toBe('twin')
    expect(r.calls[0]).toMatch(/CREATE OR ALTER PROCEDURE \[dbo\]\.\[rpt_spend__tune\]/)
    expect(r.calls.at(-1)).toMatch(/DROP PROCEDURE IF EXISTS \[dbo\]\.\[rpt_spend__tune\]/)
    const execs = r.calls.filter((c) => c.startsWith('EXEC'))
    expect(execs.map((c) => c.includes('__tune'))).toEqual([false, true, true, false]) // A B B A
  })
  it('rejects a twin whose rows differ, naming the differing rows', async () => {
    const r = runner(
      (sql) => (sql.includes('__tune') ? [{ id: 1, total: 6 }] : [{ id: 1, total: 5 }]),
      () => 1
    )
    const proof = await proveProcedureRewrite({
      proc: 'rpt_spend',
      oldBody: READ,
      newBody: READ,
      paramSets: [{}],
      timeoutMs: 1000,
      runner: r.run
    })
    expect(proof.passed).toBe(false)
    expect(proof.rows_diff?.[0].added[0]).toContain('6')
    expect(r.calls.at(-1)).toMatch(/DROP PROCEDURE IF EXISTS/)
  })
  it('refuses without a single statement when the current body writes', async () => {
    const r = runner(
      () => [],
      () => 0
    )
    const proof = await proveProcedureRewrite({
      proc: 'rpt_spend',
      oldBody: 'CREATE PROCEDURE dbo.rpt_spend AS UPDATE invoices SET amount = 0',
      newBody: READ,
      paramSets: [{}],
      timeoutMs: 1000,
      runner: r.run
    })
    expect(proof.method).toBe('refused')
    expect(proof.detail).toMatch(/current body writes invoices/)
    expect(r.calls).toEqual([])
  })
  it('fails when one set is slower on the rewrite though the median improved', async () => {
    const r = runner(
      (sql) => [{ id: sql.includes('Zone 2') ? 2 : 1 }],
      (sql) => {
        if (!sql.startsWith('EXEC')) return 0
        const twin = sql.includes('__tune')
        if (sql.includes('Zone 2')) return twin ? 30 : 5 // set 2: the rewrite is slower
        return twin ? 2 : 60
      }
    )
    const proof = await proveProcedureRewrite({
      proc: 'rpt_spend',
      oldBody: READ,
      newBody: READ,
      paramSets: [{ Zone: 'Zone 1' }, { Zone: 'Zone 2' }],
      timeoutMs: 1000,
      runner: r.run
    })
    expect(proof.passed).toBe(false)
    expect(proof.detail).toMatch(/set 2 was slower/)
    expect(r.calls.at(-1)).toMatch(/DROP PROCEDURE IF EXISTS/)
  })
  it('drops the twin even when a run throws', async () => {
    const calls: string[] = []
    const run = async (sql: string) => {
      calls.push(sql)
      if (sql.startsWith('EXEC')) throw new Error('boom')
      return []
    }
    const proof = await proveProcedureRewrite({
      // The body's header names rpt_spend: a different proc name is refused before any deploy.
      proc: 'rpt_spend',
      oldBody: READ,
      newBody: READ,
      paramSets: [{}],
      timeoutMs: 10,
      runner: run
    })
    expect(proof.passed).toBe(false)
    expect(calls.at(-1)).toMatch(/DROP PROCEDURE IF EXISTS/)
  })
})
