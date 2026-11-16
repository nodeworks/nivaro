import { describe, expect, it, vi } from 'vitest'
import { db } from '../db/index.js'

vi.mock('../db/index.js', () => ({ db: vi.fn() }))
const desk = vi.hoisted(() => ({ members: new Set<string>() }))
vi.mock('./support-tickets.js', () => ({
  canWorkDesk: async (v: { id: string; isAdmin: boolean }) =>
    v.isAdmin || desk.members.has(v.id.toUpperCase())
}))

import {
  accountChecks,
  audienceFor,
  currentProblem,
  deskRefusedTarget,
  forAudience,
  isDeskRefusedTarget,
  type SignInTroubleshooter,
  signInHelpAudience,
  type TroubleAttempt
} from './sign-in-troubleshooter.js'

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

  it('a directory answer older than a week is out of date, not a green pass', () => {
    const c = accountChecks({ ...base, directory_checked_at: '2026-10-06T12:00:00Z' }, true, NOW)
    expect(c.find((x) => x.key === 'directory')).toMatchObject({
      ok: null,
      stale: true,
      label: 'Microsoft check out of date'
    })
    expect(c.find((x) => x.key === 'directory')?.detail).toContain('39 days ago')
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

describe('who may read it', () => {
  it('admins get the full view, desk members the desk view, everyone else nothing', () => {
    expect(audienceFor(true, false)).toBe('admin')
    expect(audienceFor(true, true)).toBe('admin')
    expect(audienceFor(false, true)).toBe('desk')
    expect(audienceFor(false, false)).toBeNull()
  })

  it('asks the support desk check for non-admins only', async () => {
    desk.members = new Set(['DESK-1'])
    expect(await signInHelpAudience({ id: 'admin-1', isAdmin: true })).toBe('admin')
    expect(await signInHelpAudience({ id: 'desk-1', isAdmin: false })).toBe('desk')
    expect(await signInHelpAudience({ id: 'someone', isAdmin: false })).toBeNull()
  })
})

describe('targets the desk may not read (security review 2026-11-15)', () => {
  it('administrators and machine accounts are admin-only', () => {
    expect(deskRefusedTarget({ account_kind: null, admin_access: true })).toBe(true)
    expect(deskRefusedTarget({ account_kind: null, admin_access: 1 })).toBe(true)
    expect(deskRefusedTarget({ account_kind: 'service', admin_access: false })).toBe(true)
    expect(deskRefusedTarget({ account_kind: null, admin_access: false })).toBe(false)
    expect(deskRefusedTarget({})).toBe(false)
  })

  it('a lookup that fails counts as refused', async () => {
    vi.mocked(db).mockImplementationOnce(() => {
      throw new Error('db down')
    })
    expect(await isDeskRefusedTarget('a0000000-0000-0000-0000-000000000001')).toBe(true)
  })
})

describe('forAudience', () => {
  const sample: SignInTroubleshooter = {
    window_days: 30,
    checks: [],
    last_success: {
      at: '2026-11-14T09:00:00.000Z',
      method: 'oidc',
      browser: 'Chrome on Windows',
      ip: '10.1.2.3',
      app: 'admin'
    },
    apps: [{ app: 'admin', at: '2026-11-14T09:00:00.000Z' }],
    phones: [],
    attempts: [
      attempt({ id: 'f', ip: '10.1.2.3', browser: 'Chrome on Windows', match: 'browser' }),
      attempt({ id: 's', outcome: 'signed_in', ip: '10.9.9.9', new_ip: true })
    ],
    by_reason: [],
    current: {
      ...attempt({ id: 'f', ip: '10.1.2.3', match: 'browser' }),
      since_success: true
    }
  }

  it('admins see addresses', () => {
    const out = forAudience(sample, 'admin')
    expect(out.attempts[0].ip).toBe('10.1.2.3')
    expect(out.last_success?.ip).toBe('10.1.2.3')
  })

  it('the desk never receives an address, keeps the plain browser name and the match', () => {
    const out = forAudience(sample, 'desk')
    const text = JSON.stringify(out)
    expect(text).not.toContain('10.1.2.3')
    expect(text).not.toContain('10.9.9.9')
    expect(text).not.toContain('new_ip')
    expect(out.attempts[0]).toMatchObject({
      ip: null,
      browser: 'Chrome on Windows',
      match: 'browser'
    })
    expect(out.current).toMatchObject({ ip: null, match: 'browser', since_success: true })
    expect(out.last_success).toMatchObject({ ip: null, browser: 'Chrome on Windows' })
    // The admin answer is left untouched.
    expect(sample.attempts[0].ip).toBe('10.1.2.3')
  })
})
