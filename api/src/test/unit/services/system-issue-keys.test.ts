import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// System issues whose message carries a time, count or id list group by a stable key
// (stableIssueKey): a repeat bumps the open issue's count and refreshes its details to the
// latest occurrence, instead of opening a new issue every time.

type Row = Record<string, any>
const issues: Row[] = []

function builder(table: string) {
  const conds: Row = {}
  let statuses: string[] | null = null
  const match = (r: Row) =>
    Object.entries(conds).every(([k, v]) => r[k] === v) &&
    (!statuses || statuses.includes(String(r.status)))
  const b: Record<string, any> = {}
  b.where = (a: unknown, v?: unknown) => {
    if (a && typeof a === 'object') Object.assign(conds, a)
    else if (typeof a === 'string' && v !== undefined) conds[a] = v
    return b
  }
  b.whereIn = (col: string, vals: string[]) => {
    if (col === 'status') statuses = vals
    return b
  }
  for (const m of ['orderBy', 'select', 'limit', 'whereNotIn', 'orWhere']) b[m] = () => b
  b.first = async () => {
    if (table === 'nivaro_settings') return { default_timezone: 'America/New_York' }
    if (table !== 'nivaro_issues') return undefined
    return issues.find(match)
  }
  b.update = async (patch: Row) => {
    for (const r of issues.filter(match))
      for (const [k, v] of Object.entries(patch))
        r[k] = v && typeof v === 'object' && 'raw' in v ? Number(r[k] ?? 0) + 1 : v
    return 1
  }
  b.insert = (row: Row) => {
    if (table === 'nivaro_issues') issues.push({ ...row, id: issues.length + 1 })
    const done = { returning: async () => [{ id: issues.length }] }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    return Object.assign(done, { then: (res: (v: unknown) => unknown) => res([]) })
  }
  b.del = async () => 0
  // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
  b.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
  return b
}

vi.mock('../../../db/index.js', () => ({
  db: Object.assign((table: string) => builder(table), {
    raw: (s: string) => ({ raw: s }),
    schema: { hasTable: async () => false }
  })
}))
vi.mock('../../../services/issue-raise.js', () => ({ noteIssueWrite: () => {} }))
vi.mock('../../../services/ops-live.js', () => ({ emitOps: () => {} }))

import { normalizeIssueText, stableIssueKey, trackError } from '../../../services/error-tracking.js'
import { reportDrift } from '../../../services/rollup-drift.js'
import {
  cronMissIssue,
  deadlockIssue,
  restartImpactIssue
} from '../../../services/system-issues.js'

const graph = (stmt: string) =>
  `<deadlock><process-list><process><inputbuf>${stmt}</inputbuf></process></process-list></deadlock>`

const drift = (collection: string, field: string, drifted: number, sampled: number) => ({
  checked_fields: 1,
  checked_rows: sampled,
  drifted_rows: drifted,
  fields: [
    {
      collection,
      field,
      sampled,
      drifted,
      examples: [] as Array<[string, number | null, number | null]>
    }
  ]
})

describe('stable keys for system issues', () => {
  beforeEach(() => {
    issues.length = 0
  })

  it('groups missed runs of one job, whatever time they were due', async () => {
    await trackError(
      cronMissIssue({
        id: 'team-alerts',
        expected_at: '2026-11-18T05:50:00.000Z',
        last_run_at: '2026-11-18T04:50:00.000Z'
      })
    )
    await trackError(
      cronMissIssue({
        id: 'team-alerts',
        expected_at: '2026-11-18T06:50:00.000Z',
        last_run_at: '2026-11-18T04:50:00.000Z'
      })
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].occurrence_count).toBe(2)
    // the title is the first one's; details carry the latest occurrence
    expect(String(issues[0].title)).toMatch(/^Scheduled job "Team alerts" didn't run at 12:50 AM/)
    expect(String(issues[0].details)).toContain(
      'Message: Cron "team-alerts" missed its expected run at 2026-11-18T06:50:00.000Z'
    )
    expect(String(issues[0].details)).toMatch(/^Route: cron\/miss\nSummary: It was due/)
  })

  it('keeps different jobs apart', async () => {
    await trackError(
      cronMissIssue({ id: 'a', expected_at: '2026-11-18T05:50:00.000Z', last_run_at: null })
    )
    await trackError(
      cronMissIssue({ id: 'b', expected_at: '2026-11-18T05:50:00.000Z', last_run_at: null })
    )
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.occurrence_count)).toEqual([1, 1])
  })

  it('opens a new issue after the open one was resolved (the existing regression rule)', async () => {
    await trackError(
      cronMissIssue({ id: 'a', expected_at: '2026-11-18T05:50:00.000Z', last_run_at: null })
    )
    issues[0].status = 'resolved'
    await trackError(
      cronMissIssue({ id: 'a', expected_at: '2026-11-18T06:50:00.000Z', last_run_at: null })
    )
    expect(issues).toHaveLength(2)
    expect(issues[1].status).toBe('open')
  })

  it('groups deadlocks on the same statement at different times and values', async () => {
    await trackError(
      deadlockIssue(
        '2026-11-18T05:00:00Z',
        graph("UPDATE workflows SET amount = 10 WHERE id = 372787 AND note = N'a&apos;&apos;b'")
      )
    )
    await trackError(
      deadlockIssue(
        '2026-11-18T07:12:00Z',
        graph("UPDATE workflows  SET amount = 25\n WHERE id = 9 AND note = N'xyz'")
      )
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].occurrence_count).toBe(2)
    expect(String(issues[0].details)).toContain('Message: SQL deadlock at 2026-11-18T07:12:00.000Z')
    // the graph (stack) is the latest one too
    expect(String(issues[0].details)).toContain("note = N'xyz'")
  })

  it('keeps deadlocks on different statements apart', async () => {
    await trackError(deadlockIssue('2026-11-18T05:00:00Z', graph('UPDATE a SET x = 1')))
    await trackError(deadlockIssue('2026-11-18T05:00:00Z', graph('DELETE FROM b WHERE y = 1')))
    expect(issues).toHaveLength(2)
  })

  it('keeps one restart-impact issue whatever jobs a restart stopped', async () => {
    await trackError(restartImpactIssue(['sync-a', 'sync-b'], 2))
    await trackError(restartImpactIssue(['report-c'], 1))
    expect(issues).toHaveLength(1)
    expect(issues[0].occurrence_count).toBe(2)
    expect(String(issues[0].details)).toContain(
      'Message: Restart interrupted 1 running job(s): report-c'
    )
  })

  it('groups rollup drift by collection.field whatever the stale count', async () => {
    await reportDrift(drift('inventory_request', 'units_shipped', 35, 500))
    await reportDrift(drift('inventory_request', 'units_shipped', 12, 480))
    await reportDrift(drift('inventory_request', 'units_ordered', 3, 500))
    expect(issues).toHaveLength(2)
    expect(issues[0].occurrence_count).toBe(2)
    expect(String(issues[0].details)).toContain(
      'Message: Rollup drift: inventory_request.units_shipped (12/480 rows stale)'
    )
    // the key rollup drift always used, so issues open before this change keep grouping
    expect(issues[0].fingerprint).toBe(
      createHash('sha256').update('rollup-drift|inventory_request|units_shipped').digest('hex')
    )
  })

  it('stableIssueKey is kind|parts and never the source|route|message rule', () => {
    expect(stableIssueKey('cron-miss', 'x')).toBe(
      createHash('sha256').update('cron-miss|x').digest('hex')
    )
    expect(stableIssueKey('k', null, 3)).toBe(createHash('sha256').update('k||3').digest('hex'))
  })

  it('normalizeIssueText takes out what changes between occurrences', () => {
    expect(
      normalizeIssueText(
        "SELECT * FROM t WHERE id = 42 AND g = '6f1c2e4a-1111-2222-3333-444455556666' AND at > '2026-11-18T05:50:00Z' AND h = 0xFF"
      )
    ).toBe(normalizeIssueText('select *  from t where id = 7 and g = ? and at > ? and h = 0x01'))
    expect(normalizeIssueText('a &lt; b')).toBe('a < b')
  })
})
