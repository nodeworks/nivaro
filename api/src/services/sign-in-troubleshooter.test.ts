import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: vi.fn() }))

import { accountChecks, currentProblem, type TroubleAttempt } from './sign-in-troubleshooter.js'

const NOW = Date.parse('2026-11-14T12:00:00Z')

function attempt(over: Partial<TroubleAttempt>): TroubleAttempt {
  return {
    id: 'x',
    at: '2026-11-14T10:00:00.000Z',
    outcome: 'failed',
    reason: 'directory_disabled',
    label: 'Disabled in Microsoft',
    explain: null,
    todo: null,
    owner: 'it',
    method: 'oidc',
    app: 'admin',
    code: null,
    match: 'named',
    browser: null,
    ip: null,
    ...over
  }
}

describe('accountChecks', () => {
  const base = {
    status: 'active',
    is_redacted: false,
    account_kind: null,
    external_id: 'sub',
    entra_oid: 'oid',
    email: 'pat@example.com',
    directory_status: 'active',
    directory_checked_at: '2026-11-12T12:00:00Z'
  }

  it('all green for a healthy, linked account', () => {
    const c = accountChecks(base, true, NOW)
    expect(c.map((x) => [x.key, x.ok])).toEqual([
      ['account', true],
      ['role', true],
      ['directory', true],
      ['link', true]
    ])
    expect(c.find((x) => x.key === 'directory')?.detail).toContain('2 days ago')
  })

  it('flags suspended, role off and disabled in Microsoft', () => {
    const c = accountChecks(
      { ...base, status: 'suspended', directory_status: 'disabled' },
      false,
      NOW
    )
    expect(c.find((x) => x.key === 'account')?.ok).toBe(false)
    expect(c.find((x) => x.key === 'role')?.ok).toBe(false)
    expect(c.find((x) => x.key === 'directory')).toMatchObject({
      ok: false,
      label: 'Disabled in Microsoft'
    })
  })

  it('an unlinked account says its first sign-in links by email', () => {
    const c = accountChecks({ ...base, external_id: null, entra_oid: null }, true, NOW)
    const link = c.find((x) => x.key === 'link')
    expect(link?.ok).toBeNull()
    expect(link?.detail).toContain('pat@example.com')
  })

  it('no directory answer is unknown, not a failure', () => {
    const c = accountChecks({ ...base, directory_status: null }, true, NOW)
    expect(c.find((x) => x.key === 'directory')?.ok).toBeNull()
  })
})

describe('currentProblem', () => {
  it('the newest failure after the last successful sign-in', () => {
    const list = [
      attempt({ id: 'f2', at: '2026-11-14T11:00:00.000Z', reason: 'mfa' }),
      attempt({ id: 'f1', at: '2026-11-14T10:00:00.000Z' })
    ]
    expect(currentProblem(list, '2026-11-13T09:00:00.000Z')?.id).toBe('f2')
  })
  it('nothing when they signed in since', () => {
    const list = [attempt({ at: '2026-11-14T10:00:00.000Z' })]
    expect(currentProblem(list, '2026-11-14T10:30:00.000Z')).toBeNull()
  })
  it('a phone that was signed out is not a problem to act on', () => {
    const list = [attempt({ outcome: 'ended', reason: 'device_ended' })]
    expect(currentProblem(list, null)).toBeNull()
  })
  it('never signed in: the newest failure counts', () => {
    expect(currentProblem([attempt({ id: 'only' })], null)?.since_success).toBe(true)
  })
})
