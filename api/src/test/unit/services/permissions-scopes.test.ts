import { beforeEach, describe, expect, it, vi } from 'vitest'

const first = vi.fn()
vi.mock('../../../db/index.js', () => {
  const chain = { where: vi.fn(() => chain), first: () => first() }
  return { db: vi.fn(() => chain) }
})

import { can, scopeAllows, scopesAreOpen } from '../../../services/permissions.js'
import type { User } from '../../../types.js'

const admin = (extra: Partial<User> = {}) => ({ id: 'u1', role: 'r-admin', ...extra }) as User

describe('API key scopes', () => {
  beforeEach(() => {
    first.mockReset()
    first.mockResolvedValue({ id: 'r-admin', admin_access: true })
  })

  it('matches collection and action, with * for either', () => {
    const scopes = [
      { collection: 'orders', actions: ['read', 'update'] },
      { collection: '*', actions: ['read'] }
    ]
    expect(scopeAllows(scopes, 'update', 'orders')).toBe(true)
    expect(scopeAllows(scopes, 'read', 'vendors')).toBe(true)
    expect(scopeAllows(scopes, 'delete', 'orders')).toBe(false)
    expect(scopeAllows([], 'read', 'orders')).toBe(false)
  })

  it('knows a list that restricts nothing', () => {
    expect(scopesAreOpen([{ collection: '*', actions: ['*'] }])).toBe(true)
    expect(scopesAreOpen([{ collection: '*', actions: ['read'] }])).toBe(false)
    expect(scopesAreOpen([])).toBe(false)
  })

  it('holds an administrator-owned key to its scopes', async () => {
    const user = admin({ api_key_scopes: [{ collection: 'orders', actions: ['read'] }] })
    expect(await can(user, 'read', 'orders')).toBe(true)
    expect(await can(user, 'update', 'orders')).toBe(false)
    expect(user.api_key_scope_denied).toEqual({ action: 'update', collection: 'orders' })
    expect(await can(user, 'read', 'vendors')).toBe(false)
  })

  it('leaves callers without key scopes to their role', async () => {
    expect(await can(admin(), 'delete', 'anything')).toBe(true)
  })
})
