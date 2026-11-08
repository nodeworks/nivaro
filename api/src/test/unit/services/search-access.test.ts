import knex from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// army 11 Q2-3: the read gate global search judges BEFORE its TOP n — the role's row
// filter and the restrict-mode User Scopes, exactly what readItems applies on a read.
const h = vi.hoisted(() => ({
  rowFilter: null as unknown,
  enforcement: { filters: [] as unknown[], deny: false }
}))
vi.mock('../../../db/index.js', () => {
  const k = knex({ client: 'mssql' })
  return { db: k }
})
vi.mock('../../../services/permissions.js', () => ({
  getRowFilter: vi.fn(async () => h.rowFilter),
  applyRowFilter: vi.fn((q: { where: (c: string, v: unknown) => void }) => {
    q.where('owner', 'U1')
  })
}))
vi.mock('../../../services/user-scopes.js', () => ({
  getUserScopeEnforcement: vi.fn(async () => h.enforcement),
  applyScopeEnforcement: vi.fn(
    (
      q: { whereIn: (c: string, v: unknown[]) => void },
      c: string,
      e: { deny: boolean; filters: Array<{ ids: unknown[] }> }
    ) => {
      if (!e.deny) q.whereIn(`${c}.zone`, e.filters[0]?.ids ?? [])
    }
  )
}))

import {
  andAccess,
  jsonInLists,
  onIdExpr,
  searchAccessClause,
  searchAccessClauses
} from '../../../services/search-access.js'

const user = { id: 'U1', role: 'R' } as never

beforeEach(() => {
  h.rowFilter = null
  h.enforcement = { filters: [], deny: false }
})

describe('searchAccessClause', () => {
  it('nothing narrows the person: no clause (the statement is unchanged)', async () => {
    expect(await searchAccessClause(user, 'workflows')).toBeNull()
    expect(andAccess(null)).toEqual({ sql: '', bindings: [] })
  })

  it('a User Scope: the ids the person may read, as a sub-select with bound values', async () => {
    h.enforcement = { filters: [{ hops: [], ids: [1, 2, 3] }], deny: false }
    const c = await searchAccessClause(user, 'workflows')
    expect(c?.sql).toBe(
      '[id] IN (select [workflows].[id] from [workflows] where [workflows].[zone] IN (SELECT [value] FROM OPENJSON(?)))'
    )
    expect(c?.bindings).toEqual(['["1","2","3"]'])
  })

  it('row filter and scope together', async () => {
    h.rowFilter = [{ field: 'owner' }]
    h.enforcement = { filters: [{ hops: [], ids: [1, 2, 3] }], deny: false }
    const c = await searchAccessClause(user, 'workflows')
    expect(c?.sql).toContain('[owner] = ?')
    expect(c?.sql).toContain('[workflows].[zone] IN (SELECT [value] FROM OPENJSON(?))')
    expect(c?.bindings).toEqual(['U1', '["1","2","3"]'])
  })

  it('a strict scope that cannot reach the table hides it', async () => {
    h.enforcement = { filters: [], deny: true }
    expect(await searchAccessClause(user, 'workflows')).toEqual({ sql: '1 = 0', bindings: [] })
  })

  it('never builds a clause for an unsafe name', async () => {
    h.enforcement = { filters: [{ hops: [], ids: [1] }], deny: false }
    expect(await searchAccessClause(user, 'x];drop')).toBeNull()
  })

  it('one clause per collection; re-pointed at an alias', async () => {
    h.enforcement = { filters: [{ hops: [], ids: [1] }], deny: false }
    const m = await searchAccessClauses(user, ['workflows', 'projects'])
    expect([...m.keys()]).toEqual(['workflows', 'projects'])
    expect(onIdExpr(m.get('workflows'), 't.[id]')?.sql).toMatch(/^t\.\[id\] IN \(select/)
    expect(andAccess(m.get('projects')).sql).toMatch(/^ AND \[id\] IN \(select \[projects\]/)
  })
})

// army 11 rev #6: the clause rides in every collection's arm; a project-level scope bound
// value by value (500 × 20 arms) passed the ~2,100-parameter cap and the pass found nothing.
describe('jsonInLists', () => {
  it('a long scope list is ONE bound parameter whatever its length', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1)
    h.enforcement = { filters: [{ hops: [], ids }], deny: false }
    const c = await searchAccessClause(user, 'projects')
    expect(c?.bindings).toHaveLength(1)
    expect(JSON.parse(String(c?.bindings[0]))).toHaveLength(500)
    expect(c?.sql.match(/\?/g)).toHaveLength(1)
  })

  it('keeps single values and binding order around the lists', () => {
    const r = jsonInLists('a = ? and b in (?, ?) and c in (?) and d in (?, ?, ?) and e = ?', [
      'A',
      1,
      2,
      'C',
      'x',
      null,
      'z',
      'E'
    ])
    expect(r.sql).toBe(
      'a = ? and b IN (SELECT [value] FROM OPENJSON(?)) and c in (?) and d IN (SELECT [value] FROM OPENJSON(?)) and e = ?'
    )
    expect(r.bindings).toEqual(['A', '["1","2"]', 'C', '["x","z"]', 'E'])
  })
})
