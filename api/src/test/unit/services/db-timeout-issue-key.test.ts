import { describe, expect, it } from 'vitest'
import { dbTimeoutStatement, issueFingerprint } from '../../../services/error-tracking.js'

// One statement timing out is one issue whichever route ran it: EFP production's replication
// snapshot timed out the sign-in read on 35 routes in one second and filed 35 issues
// (2026-11-25, GitLab efp-front-end#1343 got 12 joins).

const USERS_READ =
  'select top (@p0) * from [nivaro_users] where [id] = @p1 and [status] = @p2 - Timeout: Request failed to complete in 15000ms'

describe('dbTimeoutStatement', () => {
  it('reads the statement and the wait from a driver timeout', () => {
    expect(dbTimeoutStatement(USERS_READ)).toMatchObject({
      sql: 'select top (@p0) * from [nivaro_users] where [id] = @p1 and [status] = @p2',
      ms: 15000
    })
  })

  it('is null for anything else', () => {
    expect(dbTimeoutStatement('Cannot read properties of undefined')).toBeNull()
    expect(dbTimeoutStatement('Timeout: Request failed to complete in 15000ms')).toBeNull()
    expect(dbTimeoutStatement(null)).toBeNull()
  })

  it('literals do not split the key', () => {
    const a = dbTimeoutStatement(
      "select * from [t] where [a] = 'x' - Timeout: Request failed to complete in 15000ms"
    )
    const b = dbTimeoutStatement(
      "select * from [t] where [a] = 'y' - Timeout: Request failed to complete in 15000ms"
    )
    expect(a?.key).toBe(b?.key)
  })
})

describe('issueFingerprint for statement timeouts', () => {
  it('two routes, one statement → one fingerprint', () => {
    expect(issueFingerprint('server', 'GET /api/files', USERS_READ)).toBe(
      issueFingerprint('server', 'GET /api/watch-list/prefs', USERS_READ)
    )
  })

  it('another statement → another fingerprint', () => {
    const other =
      'select * from [nivaro_roles] where [id] = @p0 - Timeout: Request failed to complete in 15000ms'
    expect(issueFingerprint('server', 'GET /api/files', USERS_READ)).not.toBe(
      issueFingerprint('server', 'GET /api/files', other)
    )
  })

  it('other errors keep the route in the key; client reports are untouched', () => {
    expect(issueFingerprint('server', 'GET /a', 'boom')).not.toBe(
      issueFingerprint('server', 'GET /b', 'boom')
    )
    expect(issueFingerprint('client', 'GET /a', USERS_READ)).not.toBe(
      issueFingerprint('client', 'GET /b', USERS_READ)
    )
  })
})
