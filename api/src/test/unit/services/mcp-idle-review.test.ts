import { beforeEach, describe, expect, it, vi } from 'vitest'

const grants: Array<Record<string, unknown>> = []
const stamps: Array<[string, unknown]> = []
const revoked: string[] = []
const notified: Array<{ user: string; subject: string }> = []

vi.mock('../../../services/oauth-store.js', () => ({
  listAllGrants: vi.fn(async () => grants),
  setGrantIdleStamps: vi.fn(async (_r: unknown, id: string, s: unknown) => {
    stamps.push([id, s])
  }),
  revokeGrant: vi.fn(async (_r: unknown, _u: string, id: string) => {
    revoked.push(id)
    return true
  })
}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_app: unknown, user: string, opts: { subject: string }) => {
    notified.push({ user, subject: opts.subject })
    return { id: 1 }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/app-links.js', () => ({
  linkTo: vi.fn(async () => 'https://nivaro.example/profile')
}))
vi.mock('../../../services/mcp-calls.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/mcp-calls.js')>()),
  readMcpSettings: vi.fn(async () => ({
    idle_flag_days: 60,
    idle_revoke_days: 90,
    rate_limit_per_minute: 120,
    connection_limits: {}
  }))
}))

const { idleDecision, revokeOn, runIdleReview } = await import(
  '../../../services/mcp-idle-review.js'
)

const DAY = 86_400_000
const NOW = Date.parse('2026-10-21T05:15:00Z')
const S = { idle_flag_days: 60, idle_revoke_days: 90 }
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
const grant = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  user_id: 'u1',
  client_id: 'nvc_x',
  client_name: 'Claude',
  scope: 'nivaro',
  created_at: ago(200),
  last_used_at: ago(10),
  t: '',
  ...over
})

describe('idleDecision', () => {
  it('leaves a recently used connection alone', () => {
    expect(idleDecision(grant(), S, NOW)).toBe('none')
  })
  it('flags at 60 days, once', () => {
    expect(idleDecision(grant({ last_used_at: ago(61) }), S, NOW)).toBe('flag')
    expect(idleDecision(grant({ last_used_at: ago(61), idle_flagged_at: ago(1) }), S, NOW)).toBe(
      'none'
    )
  })
  it('gives notice 7 days before the limit', () => {
    expect(idleDecision(grant({ last_used_at: ago(83), idle_flagged_at: ago(23) }), S, NOW)).toBe(
      'notice'
    )
    expect(idleDecision(grant({ last_used_at: ago(85), idle_notice_at: ago(2) }), S, NOW)).toBe(
      'none'
    )
  })
  it('disconnects at 90 days only once the notice is a week old', () => {
    expect(idleDecision(grant({ last_used_at: ago(90), idle_notice_at: ago(7) }), S, NOW)).toBe(
      'revoke'
    )
    // A daily job's drift is tolerated.
    expect(
      idleDecision(
        grant({
          last_used_at: ago(90),
          idle_notice_at: new Date(NOW - 7 * DAY + 3600_000).toISOString()
        }),
        S,
        NOW
      )
    ).toBe('revoke')
    expect(idleDecision(grant({ last_used_at: ago(95), idle_notice_at: ago(3) }), S, NOW)).toBe(
      'none'
    )
  })
  it('never disconnects without a notice first', () => {
    expect(idleDecision(grant({ last_used_at: ago(120) }), S, NOW)).toBe('notice')
  })
  it('clears the stamps of a connection used again', () => {
    expect(idleDecision(grant({ last_used_at: ago(2), idle_flagged_at: ago(5) }), S, NOW)).toBe(
      'clear'
    )
  })
  it('counts a never-used connection from when it was made', () => {
    expect(idleDecision(grant({ last_used_at: null, created_at: ago(61) }), S, NOW)).toBe('flag')
  })
  it('names the disconnection day', () => {
    expect(revokeOn(grant({ last_used_at: ago(85) }), S)).toBe(ago(-5).slice(0, 10))
    // A late notice pushes the day out to a week after it.
    expect(revokeOn(grant({ last_used_at: ago(120), idle_notice_at: ago(1) }), S)).toBe(
      ago(-6).slice(0, 10)
    )
  })
})

describe('runIdleReview', () => {
  beforeEach(() => {
    grants.length = 0
    stamps.length = 0
    revoked.length = 0
    notified.length = 0
  })
  const app = { redis: {}, log: { warn: vi.fn() } } as never

  it('flags, warns, disconnects and tells each owner', async () => {
    grants.push(
      grant({ id: 'a', user_id: 'ua', last_used_at: ago(61) }),
      grant({ id: 'b', user_id: 'ub', last_used_at: ago(84), idle_flagged_at: ago(20) }),
      grant({ id: 'c', user_id: 'uc', last_used_at: ago(91), idle_notice_at: ago(8) }),
      grant({ id: 'd', user_id: 'ud', last_used_at: ago(1) })
    )
    const r = await runIdleReview(app, { now: NOW })
    expect(r).toMatchObject({ reviewed: 4, flagged: 1, noticed: 1, revoked: 1, cleared: 0 })
    expect(revoked).toEqual(['c'])
    expect(stamps.map(([id]) => id).sort()).toEqual(['a', 'b'])
    expect(notified.map((n) => n.user).sort()).toEqual(['ua', 'ub', 'uc'])
    expect(notified.find((n) => n.user === 'uc')?.subject).toBe('Claude was disconnected')
  })

  it('changes nothing on a dry run', async () => {
    grants.push(grant({ id: 'c', last_used_at: ago(91), idle_notice_at: ago(8) }))
    const r = await runIdleReview(app, { now: NOW, dryRun: true })
    expect(r.revoked).toBe(1)
    expect(revoked).toEqual([])
    expect(notified).toEqual([])
  })
})
