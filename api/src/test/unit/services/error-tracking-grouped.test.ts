import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// trackGroupedIssue over a real knex (mssql dialect) whose statements land in two in-memory
// tables. The guard is the point: several API processes report the same outage in the same
// second, and the six rows production got for one fingerprint on 2026-11-12 came from
// exactly that (read, find nothing, insert), six times at once.

interface IssueRow {
  id: number
  title: string
  severity: string
  status: string
  source: string
  details: string
  fingerprint: string
  occurrence_count: number
}
const store = vi.hoisted(() => ({
  issues: [] as IssueRow[],
  occurrences: [] as Array<{ issue: number; route: string; user_id: string | null }>,
  statements: [] as string[],
  dialect: 'mssql',
  failWrites: false
}))

function answer(q: FakeQuery): unknown {
  const sql = q.sql
  store.statements.push(sql)
  const b = q.bindings
  const openFor = (fingerprint: unknown) =>
    store.issues
      .filter((i) => i.fingerprint === fingerprint && ['open', 'acknowledged'].includes(i.status))
      .sort((x, y) => x.id - y.id)
  /** The value bound to the placeholder a pattern captures ("… = @p3" → b[3]). */
  const bound = (pattern: RegExp) => {
    const m = pattern.exec(sql)
    return m ? b[Number(m[1])] : undefined
  }
  if (/^select .* from \[nivaro_issues\]/i.test(sql))
    return openFor(bound(/\[fingerprint\] = @p(\d+)/))[0]
  if (store.failWrites) throw new Error('Failed to connect to db:1433 in 15000ms')
  if (/^INSERT INTO nivaro_issues/.test(sql)) {
    // INSERT … SELECT … WHERE NOT EXISTS (… WITH (UPDLOCK, HOLDLOCK) …): one statement.
    const [title, severity, details, fingerprint] = b as string[]
    if (openFor(fingerprint).length === 0)
      store.issues.push({
        id: store.issues.length + 1,
        title,
        severity,
        status: 'open',
        source: 'server',
        details,
        fingerprint,
        occurrence_count: 0
      })
    return []
  }
  if (/^insert into \[nivaro_issues\]/i.test(sql)) {
    // The plain insert of a dialect without the guard (column order as knex sorts it).
    const cols = [...sql.matchAll(/\[(\w+)\]/g)].map((m) => m[1]).slice(1)
    const row = Object.fromEntries(cols.map((c, i) => [c, b[i]])) as unknown as IssueRow
    store.issues.push({ ...row, id: store.issues.length + 1 })
    return [1]
  }
  if (/^update \[nivaro_issues\]/i.test(sql)) {
    const row = store.issues.find((i) => i.id === bound(/where \[id\] = @p(\d+)/))
    if (!row) return 0
    row.occurrence_count += Number(bound(/\[occurrence_count\] = occurrence_count \+ @p(\d+)/))
    // The note is appended by the database, so two writers never lose each other's.
    row.details = `${row.details}${String(bound(/CONCAT\(COALESCE\(details, @p\d+\), @p(\d+)\)/))}`
    return 1
  }
  if (/sys\.|information_schema|object_id/i.test(sql)) return [{ object_id: 1 }]
  if (/^insert into \[nivaro_issue_occurrences\]/i.test(sql)) {
    const cols = [...sql.matchAll(/\(([^)]*)\) values/gi)][0][1]
      .split(', ')
      .map((c) => c.replace(/[[\]]/g, ''))
    for (let i = 0; i < b.length; i += cols.length) {
      const row = Object.fromEntries(cols.map((c, j) => [c, b[i + j]]))
      store.occurrences.push({
        issue: Number(row.issue),
        route: String(row.route),
        user_id: (row.user_id as string | null) ?? null
      })
    }
    return [1]
  }
  if (/^select .* from \[nivaro_issue_occurrences\]/i.test(sql)) return []
  if (/^delete from \[nivaro_issue_occurrences\]/i.test(sql)) return 0
  throw new Error(`unexpected statement: ${sql}`)
}

vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  const db = makeFakeDb(answer)
  const client = db.client as unknown as { config: { client: string } }
  Object.defineProperty(client.config, 'client', { get: () => store.dialect })
  return { db }
})
vi.mock('../../../services/ops-live.js', () => ({ emitOps: vi.fn() }))

import { issueFingerprint, trackGroupedIssue } from '../../../services/error-tracking.js'
import { emitOps } from '../../../services/ops-live.js'

const ROUTE = 'database'
const MESSAGE = 'The database refused or dropped connections'
const hits = (route: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ route, userId: i % 2 ? 'user-1' : null }))

beforeEach(() => {
  store.issues.length = 0
  store.occurrences.length = 0
  store.statements.length = 0
  store.dialect = 'mssql'
  store.failWrites = false
  vi.mocked(emitOps).mockClear()
})

describe('trackGroupedIssue', () => {
  it('files one issue that stands for every failure it was told about', async () => {
    const id = await trackGroupedIssue({
      route: ROUTE,
      message: MESSAGE,
      count: 26,
      note: '\n26 requests on 5 routes',
      hits: [
        ...hits('POST /api/session-recordings/:id/events', 6),
        ...hits('PATCH /api/items/:collection/:id', 1)
      ]
    })
    expect(id).toBe(1)
    expect(store.issues).toHaveLength(1)
    expect(store.issues[0]).toMatchObject({
      title: `[server] ${ROUTE}: ${MESSAGE}`,
      severity: 'high',
      status: 'open',
      source: 'server',
      fingerprint: issueFingerprint('server', ROUTE, MESSAGE),
      occurrence_count: 26
    })
    expect(store.issues[0].details).toContain('26 requests on 5 routes')
    // The occurrences say which routes: one row per failure it was shown.
    expect(store.occurrences).toHaveLength(7)
    expect(new Set(store.occurrences.map((o) => o.route))).toEqual(
      new Set(['POST /api/session-recordings/:id/events', 'PATCH /api/items/:collection/:id'])
    )
    expect(vi.mocked(emitOps)).toHaveBeenCalledTimes(1)
  })

  it('a later report of the same thing adds to the open issue', async () => {
    await trackGroupedIssue({ route: ROUTE, message: MESSAGE, count: 3, note: '\nfirst', hits: [] })
    await trackGroupedIssue({
      route: ROUTE,
      message: MESSAGE,
      count: 4,
      note: '\nsecond',
      hits: []
    })
    expect(store.issues).toHaveLength(1)
    expect(store.issues[0].occurrence_count).toBe(7)
    expect(store.issues[0].details).toMatch(/first[\s\S]*second/)
  })

  it('seven processes reporting at the same moment end up on ONE issue', async () => {
    const ids = await Promise.all(
      [3, 4, 2, 6, 1, 5, 5].map((count, i) =>
        trackGroupedIssue({
          route: ROUTE,
          message: MESSAGE,
          count,
          note: `\nprocess ${i}`,
          hits: hits(`GET /api/route-${i}`, count)
        })
      )
    )
    expect(new Set(ids)).toEqual(new Set([1]))
    expect(store.issues).toHaveLength(1)
    expect(store.issues[0].occurrence_count).toBe(26)
    expect(store.occurrences).toHaveLength(26)
    for (let i = 0; i < 7; i++) expect(store.issues[0].details).toContain(`process ${i}`)
    // Each one took the guard: the insert is a single statement that holds the range.
    const guarded = store.statements.filter((s) => /^INSERT INTO nivaro_issues/.test(s))
    expect(guarded.length).toBeGreaterThan(1)
    for (const s of guarded) {
      expect(s).toMatch(/WHERE NOT EXISTS/)
      expect(s).toMatch(/WITH \(UPDLOCK, HOLDLOCK\)/)
    }
  })

  it('a resolved issue is left alone: the next outage opens a fresh one', async () => {
    await trackGroupedIssue({ route: ROUTE, message: MESSAGE, count: 2, note: '', hits: [] })
    store.issues[0].status = 'resolved'
    const id = await trackGroupedIssue({
      route: ROUTE,
      message: MESSAGE,
      count: 5,
      note: '',
      hits: []
    })
    expect(id).toBe(2)
    expect(store.issues.map((i) => i.occurrence_count)).toEqual([2, 5])
  })

  it('keeps at most 50 occurrences of one report', async () => {
    await trackGroupedIssue({
      route: ROUTE,
      message: MESSAGE,
      count: 400,
      note: '',
      hits: hits('GET /api/x', 120)
    })
    expect(store.issues[0].occurrence_count).toBe(400)
    expect(store.occurrences).toHaveLength(50)
  })

  it('answers null, and files nothing, when the database is still away', async () => {
    store.failWrites = true
    const id = await trackGroupedIssue({
      route: ROUTE,
      message: MESSAGE,
      count: 9,
      note: '',
      hits: []
    })
    expect(id).toBeNull()
    expect(store.issues).toHaveLength(0)
    expect(vi.mocked(emitOps)).not.toHaveBeenCalled()
  })

  it('on a dialect without the guard it still files one issue per report', async () => {
    store.dialect = 'pg'
    const id = await trackGroupedIssue({
      route: ROUTE,
      message: MESSAGE,
      count: 4,
      note: '\nx',
      hits: []
    })
    expect(id).toBe(1)
    expect(store.issues).toHaveLength(1)
    expect(store.issues[0].occurrence_count).toBe(4)
    expect(store.statements.some((s) => /UPDLOCK/.test(s))).toBe(false)
  })
})
