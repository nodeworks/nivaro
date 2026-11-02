import { beforeEach, describe, expect, it, vi } from 'vitest'

// /auth/me `access_pending`: whether a person is still in the new-user flow (migration 330) —
// on the first-sign-in role (`nivaro_settings.new_user_role`) and not yet asked, or waiting for
// review (`access_request_role`, or the first role with a request sent). Judged by the settings'
// role ids, never by role names.

const h = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  fail: false,
  reads: 0
}))
vi.mock('../../../db/index.js', () => ({
  db: () => ({
    first: async () => {
      h.reads++
      if (h.fail) throw new Error('db down')
      return h.settings
    }
  })
}))

const { accessPendingFor, accessPendingOf, resetAccessPendingCache } = await import(
  '../../../services/access-pending.js'
)

const START = 'AAAAAAAA-0000-4000-8000-00000000000a'
const REVIEW = 'BBBBBBBB-0000-4000-8000-00000000000b'
const REAL = 'CCCCCCCC-0000-4000-8000-00000000000c'
const both = { new_user_role: START, access_request_role: REVIEW }
const asked = { access_request: { reason: 'Need it', submitted_at: '2026-11-01T00:00:00Z' } }

beforeEach(() => {
  h.settings = both
  h.fail = false
  h.reads = 0
  resetAccessPendingCache()
})

describe('accessPendingOf', () => {
  it('first role, nothing asked yet → first_access', () => {
    expect(accessPendingOf({ role: START }, both, false)).toBe('first_access')
    // Ids compare in any case (mssql uuids come back upper case).
    expect(accessPendingOf({ role: START.toLowerCase() }, both, false)).toBe('first_access')
  })

  it('review role → needs_authorization; first role with a request sent too', () => {
    expect(accessPendingOf({ role: REVIEW }, both, false)).toBe('needs_authorization')
    expect(
      accessPendingOf({ role: START, preferences: asked }, { new_user_role: START }, false)
    ).toBe('needs_authorization')
    // preferences as stored (nvarchar JSON).
    expect(accessPendingOf({ role: START, preferences: JSON.stringify(asked) }, both, false)).toBe(
      'needs_authorization'
    )
  })

  it('both settings naming one role: the request decides', () => {
    const same = { new_user_role: START, access_request_role: START }
    expect(accessPendingOf({ role: START }, same, false)).toBe('first_access')
    expect(accessPendingOf({ role: START, preferences: asked }, same, false)).toBe(
      'needs_authorization'
    )
  })

  it('null for a real role, an admin, no role, or the flow not configured', () => {
    expect(accessPendingOf({ role: REAL }, both, false)).toBeNull()
    expect(accessPendingOf({ role: START }, both, true)).toBeNull()
    expect(accessPendingOf({ role: null }, both, false)).toBeNull()
    expect(accessPendingOf({ role: START }, null, false)).toBeNull()
    expect(accessPendingOf({ role: START }, {}, false)).toBeNull()
  })

  it('never keys on a role name', () => {
    expect(
      accessPendingOf({ role: REAL, role_name: 'First Access' } as never, both, false)
    ).toBeNull()
  })
})

describe('accessPendingFor', () => {
  it('reads the settings row', async () => {
    expect(await accessPendingFor({ role: START }, false)).toBe('first_access')
    expect(await accessPendingFor({ role: REVIEW }, false)).toBe('needs_authorization')
  })

  it('reads the settings once a while, not on every /auth/me', async () => {
    await accessPendingFor({ role: START }, false)
    await accessPendingFor({ role: REVIEW }, false)
    await accessPendingFor({ role: START }, false)
    expect(h.reads).toBe(1)
    // Admins and role-less people never read them.
    resetAccessPendingCache()
    await accessPendingFor({ role: START }, true)
    await accessPendingFor({ role: null }, false)
    expect(h.reads).toBe(1)
  })

  it('a settings read that fails answers null (never blocks /auth/me)', async () => {
    h.fail = true
    expect(await accessPendingFor({ role: START }, false)).toBeNull()
  })
})
