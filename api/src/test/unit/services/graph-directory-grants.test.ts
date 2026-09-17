import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))

const { grantsFromJwt } = await import('../../../services/graph-directory.js')

const jwt = (payload: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

describe('grantsFromJwt', () => {
  it('reads application roles', () => {
    expect(grantsFromJwt(jwt({ roles: ['User.Read.All', 'Group.Read.All'] }))).toEqual([
      'User.Read.All',
      'Group.Read.All'
    ])
  })

  it('reads delegated scp scopes from a service-account token', () => {
    expect(grantsFromJwt(jwt({ scp: 'User.Read User.Read.All profile' }))).toEqual([
      'User.Read',
      'User.Read.All',
      'profile'
    ])
  })

  it('unions both and dedupes', () => {
    expect(grantsFromJwt(jwt({ roles: ['User.Read.All'], scp: 'User.Read.All openid' }))).toEqual([
      'User.Read.All',
      'openid'
    ])
  })

  it('is empty on a malformed token', () => {
    expect(grantsFromJwt('not-a-jwt')).toEqual([])
    expect(grantsFromJwt(jwt({}))).toEqual([])
  })
})
