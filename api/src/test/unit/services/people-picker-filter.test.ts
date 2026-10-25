import knex from 'knex'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: {}, dbRead: {}, isMssql: () => true }))

import { applyPeoplePickerFilter } from '../../../services/items.js'

// GET /items/nivaro_users?picker=1 hides what /api/users hides: legacy
// placeholder twins (legacy-…@invalid.local), redacted and suspended people.
describe('applyPeoplePickerFilter', () => {
  it('excludes redacted, anonymised, legacy, placeholder and suspended accounts', () => {
    const k = knex({ client: 'mssql' })
    const q = k('nivaro_users').select('id')
    applyPeoplePickerFilter(q as never)
    const sql = q.toString()
    expect(sql).toContain("email not like 'legacy-%'")
    expect(sql).toContain("email not like 'Redacted\\_%' escape '\\'")
    expect(sql).toContain("email not like '%@invalid.local'")
    expect(sql).toMatch(/\[is_redacted\] = false or \[is_redacted\] is null/)
    expect(sql).toMatch(/\[account_kind\] is null or not \[account_kind\] = 'placeholder'/)
    expect(sql).toMatch(/\[status\] != 'suspended' or \[status\] is null/)
  })
})
