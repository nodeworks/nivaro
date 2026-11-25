import { describe, expect, it } from 'vitest'
import {
  factsJudged,
  judgeCheck,
  runOutcome,
  type SmokeCheck,
  validateSuite
} from '../../../services/hub/verify/checks.js'
import { readOnlySqlRefusal } from '../../../services/hub-link/read-only-sql.js'
import {
  appReadBudgetMs,
  hubReadTimeoutMs,
  MAX_READS
} from '../../../services/hub-link/verify-limits.js'

// Hub verification review fixes: the strict read-only check for smoke queries (M1), the shared
// read limits (M2) and the judged / unverified split that decides what may roll back (H1).

describe('readOnlySqlRefusal', () => {
  it.each([
    'SELECT COUNT(*) AS n FROM workflows WITH (NOLOCK)',
    'select id, name from projects where status = @status;',
    "WITH open_po AS (SELECT * FROM purchase_orders WHERE state = 'open') SELECT COUNT(*) FROM open_po",
    "SELECT 'INSERT INTO x' AS text -- DELETE FROM y",
    'SELECT last_updated, updated_by FROM nivaro_files',
    '(SELECT 1) UNION ALL (SELECT 2)'
  ])('passes a read: %s', (sql) => {
    expect(readOnlySqlRefusal(sql)).toBeNull()
  })

  it.each([
    ['', 'it has no SQL'],
    ['EXEC dbo.refresh_budgets', 'does not start with SELECT or WITH'],
    ['SELECT 1; DELETE FROM workflows', 'more than one statement'],
    ['SELECT * INTO #copy FROM workflows', 'uses INTO'],
    ['WITH x AS (SELECT 1 AS a) UPDATE workflows SET a = 1', 'uses UPDATE'],
    [
      'WITH x AS (SELECT 1 AS a) MERGE workflows AS t USING x ON 1=0 WHEN NOT MATCHED THEN INSERT (a) VALUES (1)',
      'uses MERGE'
    ],
    ["SELECT * FROM OPENROWSET(BULK 'c:\\x', SINGLE_CLOB) r", 'uses OPENROWSET'],
    ['SELECT NEXT VALUE FOR dbo.seq', 'sequence'],
    ["SELECT nextval('s')", 'calls nextval()'],
    ['SELECT * FROM sys.objects WHERE name = xp_cmdshell', 'system procedure'],
    ["SELECT 1 WAITFOR DELAY '00:01'", 'uses WAITFOR'],
    ['SELECT * FROM projects FOR UPDATE', 'uses UPDATE']
  ])('refuses %j', (sql, words) => {
    expect(readOnlySqlRefusal(sql)).toContain(words)
  })
})

describe('the shared read limits', () => {
  it('the Hub refuses to save more reads than the app runs; its wait outlasts the app', () => {
    const reads = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ kind: 'read', name: `r${i}`, path: '/api/items/x' }))
    const ok = validateSuite({ checks: [...reads(MAX_READS), { kind: 'http', path: '/' }] })
    expect('error' in ok).toBe(false)
    const over = validateSuite({ checks: reads(MAX_READS + 1) })
    expect('error' in over && over.error).toContain(`at most ${MAX_READS} signed-in reads`)
    expect(appReadBudgetMs(10)).toBe(4 * 15_000)
    expect(hubReadTimeoutMs(10)).toBeGreaterThan(appReadBudgetMs(10))
  })
})

const read = (over: Partial<SmokeCheck> = {}): SmokeCheck => ({
  id: 'bbbbbbbb',
  name: 'List',
  kind: 'read',
  path: '/api/items/x',
  expect_status: 200,
  min_rows: 1,
  ...over
})

describe('judged or not', () => {
  it('only the app’s own answer is a verdict', () => {
    expect(factsJudged({ status: 200, ms: 1 })).toBe(true)
    expect(factsJudged({ status: 500, ms: 1, code: 'QUERY_FAILED' })).toBe(true)
    for (const f of [
      { status: null, ms: null, error: 'the app did not answer over its link' },
      { status: 0, ms: 15_000, code: 'TIMEOUT' },
      { status: 503, ms: 2, code: 'MAINTENANCE' },
      { status: 409, ms: 2, code: 'SMOKE_IDENTITY_CHANGED' },
      { status: 401, ms: 2, code: 'API_KEY_EXPIRED' }
    ])
      expect(factsJudged(f)).toBe(false)
  })

  it('a run fails only when a judged check failed; otherwise it is unverified', () => {
    const assertion = judgeCheck(read(), { status: 200, ms: 1, rows: 0 })
    const unreachable = judgeCheck(read({ id: 'cccccccc' }), {
      status: null,
      ms: null,
      error: 'the app did not answer over its link'
    })
    const fine = judgeCheck(read({ id: 'dddddddd' }), { status: 200, ms: 1, rows: 4 })
    expect(assertion).toMatchObject({ ok: false, judged: true })
    expect(unreachable).toMatchObject({ ok: false, judged: false })
    expect(runOutcome([assertion, unreachable])).toBe('failed')
    expect(runOutcome([unreachable, fine])).toBe('unverified')
    expect(runOutcome([fine])).toBe('passed')
    expect(runOutcome([])).toBe('unverified')
  })
})
