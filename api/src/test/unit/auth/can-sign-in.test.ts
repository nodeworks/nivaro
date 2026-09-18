import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { canSignIn } from '../../../services/users.js'

describe('canSignIn', () => {
  it('admits an active account', () => {
    expect(canSignIn({ status: 'active', is_redacted: false })).toBe(true)
    expect(canSignIn({ status: 'active' })).toBe(true)
  })

  it('refuses a suspended account', () => {
    expect(canSignIn({ status: 'suspended' })).toBe(false)
  })

  it('refuses any status other than active', () => {
    expect(canSignIn({ status: 'invited' as never })).toBe(false)
    expect(canSignIn({ status: null as never })).toBe(false)
  })

  it('refuses a redacted account even when active', () => {
    expect(canSignIn({ status: 'active', is_redacted: true })).toBe(false)
    expect(canSignIn({ status: 'active', is_redacted: 1 })).toBe(false)
  })
})
