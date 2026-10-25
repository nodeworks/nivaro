import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { roleAllowsSignIn } from '../../../auth/role-sign-in.js'

describe('roleAllowsSignIn', () => {
  it('admits anyone on a role with app access', () => {
    expect(roleAllowsSignIn({ app_access: true }, {})).toBe(true)
    expect(roleAllowsSignIn({ app_access: 1 }, {})).toBe(true)
  })

  it('does not judge an account without a role, or a role row without the column', () => {
    expect(roleAllowsSignIn(null, {})).toBe(true)
    expect(roleAllowsSignIn({}, {})).toBe(true)
  })

  it('keeps a person out of a role with app access off', () => {
    expect(roleAllowsSignIn({ app_access: false }, { account_kind: null })).toBe(false)
    expect(roleAllowsSignIn({ app_access: 0 }, {})).toBe(false)
  })

  it('lets a machine account authenticate on such a role', () => {
    expect(roleAllowsSignIn({ app_access: false }, { account_kind: 'integration' })).toBe(true)
  })
})
