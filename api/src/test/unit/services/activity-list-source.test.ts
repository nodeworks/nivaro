import knexLib from 'knex'
import { describe, expect, it } from 'vitest'
import { activityListSource, applyActivityFilters } from '../../../services/activity-filters.js'

// Army 9 b09: a 15 s `GET /api/activity?action=access-request` held the newest log page with
// shared locks; a one-line save (which logs an activity row) waited behind it for 6.4 s.
describe('activityListSource', () => {
  const mssql = knexLib({ client: 'mssql' })
  const pg = knexLib({ client: 'pg' })
  it('reads the log without shared locks on SQL Server', () => {
    const q = activityListSource(mssql, true).select('a.id')
    applyActivityFilters(q, { actions: ['access-request'] }, { mssql: true })
    q.orderBy('a.timestamp', 'desc').limit(5)
    const sql = q.toString()
    expect(sql).toMatch(/from \[nivaro_activity\] AS a WITH \(NOLOCK\)/i)
    expect(sql).toContain("[a].[action] in ('access-request')")
    expect(activityListSource(mssql, true).count('* as count').toString()).toContain(
      'WITH (NOLOCK)'
    )
  })
  // A View-as pipeline move's attribution row is never a list entry (view-as-attribution.ts).
  it('is a plain aliased table elsewhere', () => {
    expect(activityListSource(pg, false).select('a.id').toString()).toBe(
      'select "a"."id" from "nivaro_activity" as "a" where (not "a"."action" = \'view-as-move\' or "a"."action" is null)'
    )
  })
})
