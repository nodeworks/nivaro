import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
vi.mock('./account-status.js', () => ({ suspensionReason: async () => null }))
vi.mock('./user-scopes.js', () => ({
  listScopeDimensions: async () => [],
  resolveScopeLabelsForUsers: async () => new Map()
}))
vi.mock('./inactive-user-links.js', () => ({ scanInactiveUserLinks: async () => ({}) }))
vi.mock('./read-gate.js', () => ({
  sharedGatedRead: async (_k: string, _w: string, fn: () => unknown) => ({ value: await fn() })
}))

import { bucketOf, offloadFromScan } from './inactive-people-offload.js'

const src = (key: string, role: string, scope: 'open' | 'all') => ({
  key,
  role,
  scope,
  label: key,
  collection_label: 'C',
  collection: 'c',
  field: 'f',
  kind: 'column',
  reassignable: true
})

describe('bucketOf', () => {
  it('counts seats, teams, tasks, approvals and open records; never audit stamps or own sets', () => {
    expect(bucketOf({ key: 'builtin:owner_seats', role: 'seat', scope: 'all' })).toBe('seats')
    expect(bucketOf({ key: 'builtin:teams', role: 'seat', scope: 'all' })).toBe('teams')
    expect(bucketOf({ key: 'builtin:tasks', role: 'assignment', scope: 'open' })).toBe('tasks')
    expect(bucketOf({ key: 'builtin:approvals', role: 'assignment', scope: 'open' })).toBe(
      'approvals'
    )
    expect(bucketOf({ key: 'column:a.b', role: 'assignment', scope: 'open' })).toBe('records')
    expect(bucketOf({ key: 'column:a.b', role: 'assignment', scope: 'all' })).toBeNull()
    expect(bucketOf({ key: 'column:a.created_by', role: 'audit', scope: 'open' })).toBeNull()
    expect(bucketOf({ key: 'junction:a.b', role: 'own', scope: 'open' })).toBeNull()
  })
})

describe('offloadFromScan', () => {
  const sources = [
    src('builtin:owner_seats', 'seat', 'all'),
    src('builtin:tasks', 'assignment', 'open'),
    src('column:po.buyer', 'assignment', 'open'),
    src('column:po.created_by', 'audit', 'open')
  ] as never
  const user = (id: string, reason: string, links: Array<[string, number]>) => ({
    user: { id, name: id, email: null, status: 'suspended', reason, last_access: null },
    total: 0,
    links: links.map(([source, count]) => ({ source, count }))
  })

  it('ranks by open work, splits by kind, skips placeholders and people with nothing to hand on', () => {
    const out = offloadFromScan({
      sources,
      users: [
        user('A', 'suspended', [
          ['builtin:tasks', 2],
          ['column:po.buyer', 5],
          ['column:po.created_by', 99]
        ]),
        user('B', 'redacted', [['builtin:owner_seats', 1]]),
        user('C', 'placeholder', [['builtin:tasks', 50]]),
        user('D', 'suspended', [['column:po.created_by', 10]])
      ] as never
    })
    expect(out.map((p) => p.id)).toEqual(['A', 'B'])
    expect(out[0].counts).toMatchObject({ tasks: 2, records: 5, seats: 0 })
    expect(out[0].total).toBe(7)
    expect(out[0].tool_path).toBe('/data-integrity?tab=people&person=A')
  })

  it('one word for the state: anonymised and redacted both read Redacted; last sign-in rides along', () => {
    const anon = user('E', 'anonymised', [['builtin:owner_seats', 3]])
    ;(anon.user as { last_access: string | null }).last_access = '2025-12-16T14:17:03.413Z'
    const out = offloadFromScan({
      sources,
      users: [user('A', 'suspended', [['builtin:tasks', 1]]), anon] as never
    })
    const byId = new Map(out.map((p) => [p.id, p]))
    expect(byId.get('A')?.state_label).toBe('Suspended')
    expect(byId.get('E')?.state_label).toBe('Redacted')
    expect(byId.get('E')?.last_access).toBe('2025-12-16T14:17:03.413Z')
    expect(byId.get('E')?.since).toBeNull()
  })
})
