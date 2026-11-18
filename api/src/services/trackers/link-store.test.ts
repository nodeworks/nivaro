import knex from 'knex'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: () => ({}) }))

import { cappedMembersQuery, LINK_MEMBERS_CAP } from './link-store.js'

describe('cappedMembersQuery (final review: storm links)', () => {
  it('caps members per link in SQL and carries each link’s full count', () => {
    const q = knex({ client: 'mssql' })
    const { sql, bindings } = cappedMembersQuery(q, [3, 4]).toSQL()
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY [link] ORDER BY [id]) AS [__rn]')
    expect(sql).toContain('COUNT(*) OVER (PARTITION BY [link]) AS [__total]')
    expect(sql).toMatch(/from \(select .* from \[nivaro_tracker_link_members\]/i)
    expect(sql).toMatch(/where \[__rn\] <= \?/)
    expect(bindings).toContain(LINK_MEMBERS_CAP)
    expect(LINK_MEMBERS_CAP).toBe(200)
  })
})
