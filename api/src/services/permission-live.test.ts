import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))
vi.mock('./record-events.js', async () => {
  // The real route list, without the socket plumbing.
  const ACCESS_ROUTES =
    /^\/api\/(roles|user-scopes|scope-dimensions|tree-permissions|access-requests\/[^/?]+\/resolve|users\/(bulk|me\/scopes|[^/?]+\/copy-access)|users\/(?!me\b|cards(?:[?]|$))[^/?]+(?:[?]|$))/
  return { ACCESS_ROUTES, announceAccessChanged: () => {} }
})

import {
  announcePermissionChange,
  type PermissionLookups,
  permissionAudience,
  permissionTarget
} from './permission-live.js'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const req = (method: string, url: string, isAdmin = true, body?: unknown) => ({
  method,
  url,
  isAdmin,
  user: { id: U1 },
  body
})

const lookups = (roles: Record<string, string[]>): PermissionLookups => ({
  roleOfPolicy: async (id) => (id === 'p1' ? 'r1' : null),
  roleOfAccessRequest: async (id) => (id === 'a1' ? 'r2' : null),
  peopleInRoles: async (ids, max) => {
    const people = ids.flatMap((r) => roles[r] ?? [])
    return people.length > max ? null : people
  }
})

describe('permission push targeting', () => {
  it('one person’s row, scopes or offboarding tells only that person', () => {
    expect(permissionTarget(req('PATCH', `/api/users/${U2}`))).toEqual({ kind: 'users', ids: [U2] })
    expect(permissionTarget(req('PUT', `/api/user-scopes/${U2}`))).toEqual({
      kind: 'users',
      ids: [U2]
    })
    expect(permissionTarget(req('POST', `/api/users/${U2}/copy-access`))).toEqual({
      kind: 'users',
      ids: [U2]
    })
    expect(permissionTarget(req('POST', `/api/offboarding/${U2}`))).toEqual({
      kind: 'users',
      ids: [U2]
    })
  })

  it('bulk changes tell the people in the body', () => {
    expect(permissionTarget(req('POST', '/api/users/bulk', true, { ids: [U2] }))).toEqual({
      kind: 'users',
      ids: [U2]
    })
    expect(
      permissionTarget(req('POST', '/api/user-scopes/bulk', true, { user_ids: [U1, U2] }))
    ).toEqual({ kind: 'users', ids: [U1, U2] })
  })

  it('a role, its UI permissions or policies tell the role’s people', async () => {
    expect(permissionTarget(req('PATCH', '/api/roles/r1'))).toEqual({ kind: 'roles', ids: ['r1'] })
    expect(permissionTarget(req('PATCH', '/api/roles/r1/ui-permissions'))).toEqual({
      kind: 'roles',
      ids: ['r1']
    })
    expect(permissionTarget(req('POST', '/api/roles/r1/policies'))).toEqual({
      kind: 'roles',
      ids: ['r1']
    })
    const l = lookups({ r1: [U1, U2], r2: [U2] })
    expect(await permissionAudience({ kind: 'roles', ids: ['r1'] }, l)).toEqual([U1, U2])
    expect(await permissionAudience({ kind: 'policy', id: 'p1' }, l)).toEqual([U1, U2])
    expect(await permissionAudience({ kind: 'access-request', id: 'a1' }, l)).toEqual([U2])
  })

  it('things that touch everyone, or cannot say whom, tell the tenant', async () => {
    expect(permissionTarget(req('POST', '/api/scope-dimensions'))).toEqual({ kind: 'tenant' })
    expect(permissionTarget(req('POST', '/api/tree-permissions'))).toEqual({ kind: 'tenant' })
    expect(permissionTarget(req('DELETE', '/api/roles/r1'))).toEqual({ kind: 'tenant' })
    expect(permissionTarget(req('DELETE', '/api/roles/policies/p1'))).toEqual({ kind: 'tenant' })
    const l = lookups({})
    expect(await permissionAudience({ kind: 'policy', id: 'gone' }, l)).toBe('tenant')
    // A role too big to tell one by one: one tenant notice.
    const big = lookups({ r9: Array.from({ length: 2000 }, (_, i) => `u${i}`) })
    expect(await permissionAudience({ kind: 'roles', ids: ['r9'] }, big)).toBe('tenant')
  })

  it('a new role, reads, previews and non-admins (except their own scope pick) tell nobody', () => {
    expect(permissionTarget(req('POST', '/api/roles'))).toBeNull()
    expect(permissionTarget(req('GET', '/api/roles/r1'))).toBeNull()
    expect(permissionTarget(req('POST', '/api/roles/r1/simulate'))).toBeNull()
    expect(permissionTarget(req('POST', `/api/user-scopes/${U2}/impact`))).toBeNull()
    expect(permissionTarget(req('POST', '/api/users/cards'))).toBeNull()
    expect(permissionTarget(req('PATCH', '/api/items/orders/1'))).toBeNull()
    expect(permissionTarget(req('PATCH', '/api/roles/r1', false))).toBeNull()
    expect(permissionTarget(req('PUT', '/api/users/me/scopes/zone', false))).toEqual({
      kind: 'users',
      ids: [U1]
    })
  })

  it('announces per person, and to the tenant when the lookup fails', async () => {
    const sent: Array<{ userId?: string }> = []
    await announcePermissionChange({ kind: 'roles', ids: ['r1'] }, lookups({ r1: [U1, U2] }), (o) =>
      sent.push(o)
    )
    expect(sent).toEqual([{ userId: U1 }, { userId: U2 }])
    sent.length = 0
    const broken: PermissionLookups = {
      ...lookups({}),
      peopleInRoles: async () => {
        throw new Error('db down')
      }
    }
    await announcePermissionChange({ kind: 'roles', ids: ['r1'] }, broken, (o) => sent.push(o))
    expect(sent).toEqual([{}])
  })
})
