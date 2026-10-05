import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../../db/index.js'
import {
  execStatement,
  judgeTiming,
  provability,
  proveProcedureRewrite,
  renameProcHeader,
  sweepMinAgeMinutes,
  sweepTwinLeftovers
} from '../../../../services/db-tuning/twin.js'

vi.mock('../../../../db/dialect.js', () => ({ isMssql: () => true }))

const READ = `CREATE PROCEDURE dbo.rpt_spend @Zone NVARCHAR(50) = NULL AS
BEGIN
  SET NOCOUNT ON;
  SELECT p.id, SUM(i.amount) AS total FROM invoices i JOIN projects p ON p.id = i.project
  WHERE (@Zone IS NULL OR p.zone = @Zone) GROUP BY p.id
END`

const proc = (body: string) => provability('x', `CREATE PROC x AS ${body}`)

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
    expect(proc('SELECT 1 AS a INTO realtable')).toMatch(/writes realtable/))
  it('ignores temp deletes/drops, join hints and string literals', () => {
    expect(
      proc(
        "DELETE FROM #t; DROP TABLE IF EXISTS #t; UPDATE @v SET a = 1; SELECT N'update invoices' AS s FROM a OPTION (MERGE JOIN)"
      )
    ).toBeNull()
  })
  it('ignores writes inside comments (nested too) and bracketed column names', () => {
    expect(proc('-- UPDATE invoices SET a = 1\nSELECT 1')).toBeNull()
    expect(proc('/* outer /* DELETE FROM invoices */ still a comment */ SELECT 1')).toBeNull()
    expect(proc('SELECT [update], [delete] FROM t')).toBeNull()
  })
  it('is not fooled by comment markers in literals or quotes in bracketed names', () => {
    expect(proc("SELECT ISNULL(code, '--') AS code INTO dbo.report_cache FROM t")).toMatch(
      /writes dbo\.report_cache/
    )
    expect(
      proc("SELECT ISNULL(code,'--') AS c FROM t\nUPDATE invoices SET amount = 0 WHERE note = 'x'")
    ).toMatch(/writes invoices/)
    expect(
      proc(
        "SELECT v.name AS [Vendor's Name] FROM vendors v\nUPDATE invoices SET amount = 0\nSELECT 'done'"
      )
    ).toMatch(/writes invoices/)
    expect(proc("SELECT 1 FROM t WHERE p LIKE '%/*%'\nDELETE FROM invoices\nSELECT '*/'")).toMatch(
      /writes invoices/
    )
  })
  it('refuses writes with no space before a bracketed or quoted name', () => {
    expect(proc('UPDATE[invoices] SET a=1')).toMatch(/writes invoices/)
    expect(proc('DELETE[invoices]')).toMatch(/writes invoices/)
    expect(proc('INSERT INTO[invoices] VALUES (1)')).toMatch(/writes invoices/)
    expect(proc('TRUNCATE TABLE[invoices]')).toMatch(/writes invoices/)
    expect(proc('UPDATE "invoices" SET a=1')).toMatch(/writes invoices/)
    expect(proc("BULK INSERT invoices FROM 'f.csv'")).toMatch(/writes invoices/)
  })
  it('refuses DDL on real objects and admin statements, allows #temp DDL', () => {
    expect(proc('CREATE INDEX ix ON invoices(a)')).toMatch(/runs DDL \(CREATE INDEX\)/)
    expect(proc('DROP INDEX ix ON invoices')).toMatch(/runs DDL \(DROP INDEX\)/)
    expect(proc('ALTER INDEX ALL ON invoices REBUILD')).toMatch(/runs DDL \(ALTER INDEX\)/)
    expect(proc('DROP PROCEDURE dbo.other')).toMatch(/runs DDL \(DROP PROCEDURE\)/)
    expect(proc('CREATE TABLE dbo.keep (a int)')).toMatch(/writes dbo\.keep/)
    expect(proc('GRANT SELECT ON t TO someone')).toMatch(/runs GRANT/)
    expect(proc('DBCC FREEPROCCACHE')).toMatch(/runs DBCC/)
    expect(proc("BACKUP DATABASE d TO DISK = 'x'")).toMatch(/runs BACKUP/)
    expect(
      proc('CREATE TABLE #t (a int); CREATE INDEX ix ON #t(a); SELECT a FROM #t; DROP TABLE #t')
    ).toBeNull()
  })
  it('refuses EXEC of a variable and a self-call through a return value', () => {
    expect(proc('EXEC @sql')).toMatch(/dynamic/)
    expect(proc('EXEC @rc = @p')).toMatch(/dynamic/)
    expect(proc("EXEC ('select 1')")).toMatch(/dynamic/)
    expect(proc('EXEC @rc = dbo.x')).toMatch(/itself/)
    expect(proc('EXEC xy')).toBeNull()
    expect(proc('EXEC sp_rename t, u')).toMatch(/system procedure sp_rename/)
  })
  it('refuses EXEC of a procedure in another database, keeps a 2-part callee', () => {
    expect(proc("EXEC master.dbo.xp_cmdshell 'dir'")).toMatch(
      /another database master\.dbo\.xp_cmdshell/
    )
    expect(proc("EXEC master..xp_cmdshell 'dir'")).toMatch(/another database master\.\.xp_cmdshell/)
    expect(proc("EXEC [master].[dbo].[xp_cmdshell] 'dir'")).toMatch(/another database/)
    expect(proc("EXEC msdb.dbo.sp_send_dbmail @recipients = 'a@b.c'")).toMatch(/another database/)
    expect(proc('EXEC @rc = otherdb.dbo.writer')).toMatch(/another database otherdb\.dbo\.writer/)
    expect(proc('EXEC dbo.xp_cmdshell')).toMatch(/system procedure xp_cmdshell/)
    expect(proc('EXEC dbo.helper @a = 1')).toBeNull()
  })
  it('refuses dynamic SQL, self-reference and linked servers', () => {
    expect(provability('x', "CREATE PROC x AS EXEC sp_executesql N'select 1'")).toMatch(/dynamic/)
    expect(provability('x', 'CREATE PROC x AS EXEC x')).toMatch(/itself/)
    expect(provability('x', 'CREATE PROC x AS SELECT * FROM srv.db.dbo.t')).toMatch(/linked/)
  })
  it('refuses four-part names anywhere: EXEC, comma joins, quoted parts', () => {
    expect(proc('EXEC srv.db.dbo.writer')).toMatch(/linked/)
    expect(proc('SELECT * FROM a, srv.db.dbo.t')).toMatch(/linked/)
    expect(proc('SELECT * FROM "srv"."db"."dbo"."t"')).toMatch(/linked/)
    expect(proc('SELECT * FROM srv.db..t')).toMatch(/linked/)
    expect(proc("SELECT * FROM OPENQUERY(srv, 'select 1')")).toMatch(/linked/)
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
  it('binds dates as ISO text and refuses objects and unsafe names', () => {
    expect(execStatement('p', { D: new Date('2026-01-02T03:04:05.000Z') })).toBe(
      "EXEC [dbo].[p] @D = N'2026-01-02T03:04:05.000Z'"
    )
    expect(() => execStatement('p', { O: { a: 1 } })).toThrow(/object/)
    expect(() => execStatement('a]; DROP TABLE x;--', {})).toThrow(/plain procedure name/)
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

const isExec = (sql: string) => sql.includes('EXEC [dbo]')

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
  const base = { proc: 'rpt_spend', oldBody: READ, newBody: READ, timeoutMs: 1000 }

  it('passes an identical, faster twin and deploys/drops it around the runs', async () => {
    const r = runner(
      () => [{ id: 1, total: 5 }],
      (sql) => (sql.includes('__tune') && isExec(sql) ? 2 : isExec(sql) ? 20 : 0)
    )
    const proof = await proveProcedureRewrite({
      ...base,
      paramSets: [{ Zone: 'Zone 1' }],
      runner: r.run
    })
    expect(proof.passed).toBe(true)
    expect(proof.method).toBe('twin')
    expect(r.calls[0]).toMatch(/CREATE OR ALTER PROCEDURE \[dbo\]\.\[rpt_spend__tune\]/)
    expect(r.calls.at(-1)).toMatch(
      /^IF @@TRANCOUNT > 0 ROLLBACK;\nDROP PROCEDURE IF EXISTS \[dbo\]\.\[rpt_spend__tune\]$/
    )
    const execs = r.calls.filter(isExec)
    expect(execs.map((c) => c.includes('__tune'))).toEqual([false, true, true, false]) // A B B A
    for (const e of execs) expect(e).toMatch(/^BEGIN TRAN;\nEXEC .*;\nIF @@TRANCOUNT > 0 ROLLBACK$/)
  })
  it('rejects a twin whose rows differ, naming the differing rows', async () => {
    const r = runner(
      (sql) => (sql.includes('__tune') ? [{ id: 1, total: 6 }] : [{ id: 1, total: 5 }]),
      () => 1
    )
    const proof = await proveProcedureRewrite({ ...base, paramSets: [{}], runner: r.run })
    expect(proof.passed).toBe(false)
    expect(proof.rows_diff?.[0].added[0]).toContain('6')
    expect(r.calls.at(-1)).toMatch(/DROP PROCEDURE IF EXISTS/)
  })
  it('rejects a rewrite that only differs on its second run (a2 vs b2)', async () => {
    let twinRuns = 0
    const r = runner(
      (sql) => {
        if (!sql.includes('__tune') || !isExec(sql)) return [{ id: 1 }]
        twinRuns++
        return twinRuns === 2 ? [{ id: 2 }] : [{ id: 1 }]
      },
      () => 0
    )
    const proof = await proveProcedureRewrite({ ...base, paramSets: [{}], runner: r.run })
    expect(proof.passed).toBe(false)
    expect(proof.detail).toMatch(/rows differ/)
  })
  it('refuses a nondeterministic original (a1 differs from a2)', async () => {
    let oldRuns = 0
    const r = runner(
      (sql) => {
        if (isExec(sql) && !sql.includes('__tune')) oldRuns++
        return [{ id: oldRuns }]
      },
      () => 0
    )
    const proof = await proveProcedureRewrite({ ...base, paramSets: [{}], runner: r.run })
    expect(proof.passed).toBe(false)
    expect(proof.method).toBe('refused')
    expect(proof.detail).toMatch(/^nondeterministic: results differ between identical runs/)
    expect(r.calls.at(-1)).toMatch(/DROP PROCEDURE IF EXISTS/)
  })
  it('refuses without a single statement when the current body writes', async () => {
    const r = runner(
      () => [],
      () => 0
    )
    const proof = await proveProcedureRewrite({
      ...base,
      oldBody: 'CREATE PROCEDURE dbo.rpt_spend AS UPDATE invoices SET amount = 0',
      paramSets: [{}],
      runner: r.run
    })
    expect(proof.method).toBe('refused')
    expect(proof.detail).toMatch(/current body writes invoices/)
    expect(r.calls).toEqual([])
  })
  it('refuses a proof without a positive timeout', async () => {
    const r = runner(
      () => [],
      () => 0
    )
    const proof = await proveProcedureRewrite({
      ...base,
      timeoutMs: 0,
      paramSets: [{}],
      runner: r.run
    })
    expect(proof.method).toBe('refused')
    expect(r.calls).toEqual([])
  })
  it('fails when one set is slower on the rewrite though the median improved', async () => {
    const r = runner(
      (sql) => [{ id: sql.includes('Zone 2') ? 2 : 1 }],
      (sql) => {
        if (!isExec(sql)) return 0
        const twin = sql.includes('__tune')
        if (sql.includes('Zone 2')) return twin ? 30 : 5 // set 2: the rewrite is slower
        return twin ? 2 : 60
      }
    )
    const proof = await proveProcedureRewrite({
      ...base,
      paramSets: [{ Zone: 'Zone 1' }, { Zone: 'Zone 2' }],
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
      if (isExec(sql)) throw new Error('boom')
      return []
    }
    const proof = await proveProcedureRewrite({
      // The body's header names rpt_spend: a different proc name is refused before any deploy.
      ...base,
      timeoutMs: 10,
      paramSets: [{}],
      runner: run
    })
    expect(proof.passed).toBe(false)
    expect(proof.detail).toBe('proof run failed: boom')
    expect(calls.at(-1)).toMatch(/DROP PROCEDURE IF EXISTS/)
  })
  it('still attempts the drop when the deploy itself throws', async () => {
    const calls: string[] = []
    const run = async (sql: string) => {
      calls.push(sql)
      if (sql.startsWith('CREATE OR ALTER')) throw new Error('deploy refused')
      return []
    }
    const proof = await proveProcedureRewrite({ ...base, paramSets: [{}], runner: run })
    expect(proof.passed).toBe(false)
    expect(proof.detail).toMatch(/proof run failed: deploy refused/)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatch(/DROP PROCEDURE IF EXISTS \[dbo\]\.\[rpt_spend__tune\]/)
  })
  it('retries a failed drop once and reports it when the retry fails too', async () => {
    const calls: string[] = []
    const run = async (sql: string) => {
      calls.push(sql)
      if (sql.includes('DROP PROCEDURE')) throw new Error('connection lost')
      return [{ id: 1 }]
    }
    const proof = await proveProcedureRewrite({ ...base, paramSets: [{}], runner: run })
    expect(calls.filter((c) => c.includes('DROP PROCEDURE'))).toHaveLength(2)
    expect(proof.detail).toMatch(
      /twin drop failed \(connection lost\) — \[dbo\]\.\[rpt_spend__tune\] is left for the boot sweep/
    )
  })
  it('a body that leaves a transaction open still loses its twin and its writes', async () => {
    const leaky =
      'CREATE PROCEDURE dbo.rpt_spend AS BEGIN TRAN; SELECT 1 AS a INTO #t; SELECT a FROM #t'
    expect(provability('rpt_spend', leaky)).toBeNull()
    // A tiny server: transactions nest, a DROP inside an open transaction is undone when the
    // connection rolls back on release, and the twin's EXEC leaks a transaction then aborts.
    const server = { tran: 0, twin: false, dropInTran: false }
    const run = async (sql: string) => {
      if (sql.startsWith('CREATE OR ALTER')) {
        server.twin = true
        return []
      }
      for (const stmt of sql.split(/;\n?|\n/).map((s) => s.trim())) {
        if (stmt === 'BEGIN TRAN') server.tran++
        else if (stmt === 'IF @@TRANCOUNT > 0 ROLLBACK') {
          if (server.tran > 0 && server.dropInTran) server.twin = true
          server.tran = 0
          server.dropInTran = false
        } else if (stmt.startsWith('DROP PROCEDURE')) {
          server.twin = false
          server.dropInTran = server.tran > 0
        } else if (stmt.startsWith('EXEC [dbo].[rpt_spend__tune]')) {
          server.tran++
          throw new Error('Transaction count after EXECUTE indicates a mismatching number')
        }
      }
      return [{ a: 1 }]
    }
    const proof = await proveProcedureRewrite({
      ...base,
      newBody: leaky,
      paramSets: [{}],
      runner: run
    })
    // Connection release: an open transaction would roll the DROP back.
    if (server.tran > 0 && server.dropInTran) server.twin = true
    expect(proof.passed).toBe(false)
    expect(proof.detail).toMatch(/mismatching/)
    expect(server.tran).toBe(0)
    expect(server.twin).toBe(false)
  })
})

describe('sweepTwinLeftovers', () => {
  afterEach(() => vi.mocked(db.raw).mockReset())

  it('drops only dbo twins whose names really end in __tune', async () => {
    const raw = vi.mocked(db.raw)
    raw.mockImplementation(((sql: string) =>
      Promise.resolve(
        sql.startsWith('SELECT')
          ? [{ name: 'rpt_spend__tune' }, { name: 'retune' }, { name: 'bad]name__tune' }]
          : []
      )) as unknown as typeof db.raw)
    expect(await sweepTwinLeftovers(10)).toEqual(['rpt_spend__tune'])
    const sqls = raw.mock.calls.map((c) => String(c[0]))
    expect(sqls[0]).toMatch(/LIKE '%\[_\]\[_\]tune'/)
    expect(sqls.slice(1)).toEqual(['DROP PROCEDURE IF EXISTS [dbo].[rpt_spend__tune]'])
  })
  it('leaves a twin a live proof elsewhere may still be running (server-local modify_date)', async () => {
    const raw = vi.mocked(db.raw)
    raw.mockImplementation((() => Promise.resolve([])) as unknown as typeof db.raw)
    await sweepTwinLeftovers(10)
    expect(String(raw.mock.calls[0]?.[0])).toMatch(
      /p\.modify_date < DATEADD\(minute, -30, GETDATE\(\)\)/
    )
    raw.mockClear()
    await sweepTwinLeftovers(60)
    expect(String(raw.mock.calls[0]?.[0])).toMatch(/DATEADD\(minute, -65, GETDATE\(\)\)/)
  })
  it('the minimum age is max(30, timeout + 5) and never NaN', () => {
    expect(sweepMinAgeMinutes(10)).toBe(30)
    expect(sweepMinAgeMinutes(25)).toBe(30)
    expect(sweepMinAgeMinutes(26)).toBe(31)
    expect(sweepMinAgeMinutes(Number.NaN)).toBe(30)
  })
})
