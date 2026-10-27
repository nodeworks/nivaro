import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── a chainable db: every method returns the chain; awaiting / first() answer per table ───
const state = vi.hoisted(() => ({
  link: null as null | { conversation_id: string; service_url: string; aad_object_id: string },
  inserted: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  botEnabled: true,
  prefs: null as unknown,
  testTeamsOn: false,
  build: vi.fn(async (_i: { openUrl: string }) => ({ type: 'AdaptiveCard' })),
  send: vi.fn(async () => ({ id: 'a1' })),
  deliver: vi.fn(async () => 'sent' as string)
}))

function chain(table: string): unknown {
  const rows = () => {
    if (table === 'nivaro_users')
      return {
        status: 'active',
        is_redacted: 0,
        email: 'a@x.test',
        phone: null,
        preferences: state.prefs ? JSON.stringify({ notification_prefs: state.prefs }) : null
      }
    return undefined
  }
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === 'then') return undefined
      if (prop === 'first') return async () => rows()
      if (prop === 'insert')
        return (row: Record<string, unknown>) => {
          state.inserted.push(row)
          return p
        }
      if (prop === 'update')
        return async (row: Record<string, unknown>) => {
          state.updates.push(row)
        }
      if (prop === 'returning') return async () => [{ id: 41 }]
      return () => p
    }
  }
  const p: unknown = new Proxy({}, handler)
  return p
}
vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    vi.fn((t: string) => chain(t)),
    { fn: { now: () => 'now' } }
  ),
  hasTable: async () => false
}))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => false }))
vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: state.botEnabled })
}))
vi.mock('../../../services/teams-bot/links.js', () => ({
  linkForUser: async () => state.link
}))
vi.mock('../../../services/teams-bot/send.js', () => ({ deliverTeams: state.deliver }))
vi.mock('../../../services/channel-test-mode.js', () => ({
  getChannelTestConfig: async () => ({ teams: { on: state.testTeamsOn, webhook: null } })
}))
vi.mock('../../../services/app-links.js', () => ({
  linkTo: async () => 'https://nivaro.test/notifications',
  recordLink: async () => 'https://nivaro.test/record'
}))
vi.mock('../../../services/teams-bot/notification-card.js', () => ({
  buildTeamsNotificationCard: state.build
}))
vi.mock('../../../services/web-push.js', () => ({ sendWebPush: vi.fn(async () => 0) }))
vi.mock('../../../services/chain.js', () => ({
  withChainStep: async (_n: string, fn: () => unknown) => fn()
}))
vi.mock('../../../services/chain-columns.js', () => ({ chainFields: async () => ({}) }))

import { decideDelivery, notifyUser } from '../../../services/notification-channels.js'

const NOON = new Date('2026-07-01T16:00:00Z') // 12:00 America/New_York
const connected = { conversation_id: 'c1', service_url: 'https://smba.test/', aad_object_id: 'o1' }
const on = { matrix: { workflow: { teams: true } } }
const ask = (prefsOverride: unknown, subject = 'Approval requested', now = NOON) =>
  decideDelivery(
    '11111111-1111-1111-1111-111111111111',
    { subject, category: 'workflow', prefsOverride: prefsOverride as never },
    now
  )

beforeEach(() => {
  state.link = connected
  state.botEnabled = true
  state.prefs = null
  state.testTeamsOn = false
  state.build.mockClear()
  state.inserted.length = 0
  state.updates.length = 0
  state.deliver.mockClear()
  state.deliver.mockResolvedValue('sent')
})

describe('teams in the delivery decision', () => {
  it('teams follows the matrix and defaults off', async () => {
    const off = await ask({ matrix: { workflow: { inapp: true } } })
    expect(off.teams).toBe(false)
    expect(off.reasons.find((r) => r.channel === 'teams')?.code).toBe('teams_off')
    expect((await ask(null)).teams).toBe(false)
    expect((await ask({ matrix: { workflow: { teams: false } } })).teams).toBe(false)

    const yes = await ask(on)
    expect(yes.teams).toBe(true)
    expect(yes.reasons.find((r) => r.channel === 'teams')?.code).toBe('teams_sent')
  })

  it('says nothing about Teams when the bot is not enabled', async () => {
    state.botEnabled = false
    const d = await ask(null)
    expect(d.reasons.some((r) => r.channel === 'teams')).toBe(false)
  })

  it('quiet hours hold teams like push', async () => {
    const d = await ask({ ...on, quiet_start: '00:00', quiet_end: '23:59' })
    expect(d.push).toBe(false)
    expect(d.teams).toBe(false)
    expect(d.reasons.find((r) => r.channel === 'teams')?.code).toBe('teams_quiet_hours')
    // the category override lifts the hold for both
    const o = await ask({
      quiet_start: '00:00',
      quiet_end: '23:59',
      matrix: { workflow: { teams: true, quiet_override: true } }
    })
    expect(o.teams).toBe(true)
  })

  it('critical subjects bypass quiet hours for teams', async () => {
    const d = await ask(
      { ...on, quiet_start: '00:00', quiet_end: '23:59' },
      'Critical: server down'
    )
    expect(d.teams).toBe(true)
    // ...but never the opt-in
    const notOptedIn = await ask(
      { quiet_start: '00:00', quiet_end: '23:59' },
      'Critical: server down'
    )
    expect(notOptedIn.teams).toBe(false)
  })

  it('not connected -> teams_not_connected and notifyUser still succeeds', async () => {
    state.link = null
    const d = await ask(on)
    expect(d.teams).toBe(false)
    expect(d.reasons.find((r) => r.channel === 'teams')?.code).toBe('teams_not_connected')
    expect(d.reasons.find((r) => r.channel === 'teams')?.text).toBe('Teams is not connected.')

    // a link with no chat yet is also "not connected"
    state.link = { ...connected, conversation_id: '' }
    expect((await ask(on)).teams).toBe(false)

    state.link = null
    const app = { io: null } as unknown as FastifyInstance
    // prefs come from the stored user row, which this mock leaves empty: the decision is
    // computed with no Teams opt-in, and the other channels run as usual.
    const res = await notifyUser(app, '11111111-1111-1111-1111-111111111111', {
      subject: 'Approval requested',
      message: 'm',
      category: 'workflow'
    })
    expect(res.id).toBe(41)
    expect(res.decision.inapp).toBe(true)
    expect(state.deliver).not.toHaveBeenCalled()
    const delivery = JSON.parse(String(state.inserted[0]?.delivery))
    expect(delivery.teams.status).toBe('skipped')
  })

  it('an opted-in, connected person gets the card and the outcome is stamped on the row', async () => {
    state.prefs = { matrix: { workflow: { teams: true } } }
    const app = { io: null } as unknown as FastifyInstance
    const res = await notifyUser(app, '22222222-2222-2222-2222-222222222222', {
      subject: 'Approval requested',
      message: 'm',
      category: 'workflow'
    })
    expect(res.decision.teams).toBe(true)
    await vi.waitFor(() => expect(state.deliver).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(state.updates.length).toBeGreaterThan(0))
    const stamped = JSON.parse(String(state.updates.at(-1)?.delivery))
    expect(stamped.teams.status).toBe('sent')
  })

  it('a failed Teams send never fails the notification', async () => {
    state.prefs = { matrix: { workflow: { teams: true } } }
    state.deliver.mockRejectedValue(new Error('boom'))
    const res = await notifyUser(
      { io: null } as unknown as FastifyInstance,
      '33333333-3333-3333-3333-333333333333',
      {
        subject: 'Approval requested',
        message: 'm',
        category: 'workflow'
      }
    )
    expect(res.id).toBe(41)
    await vi.waitFor(() => expect(state.deliver).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
  })

  it('bot off -> teams false, no teams reason, no card built', async () => {
    state.botEnabled = false
    state.prefs = { matrix: { workflow: { teams: true } } }
    const d = await ask(on)
    expect(d.teams).toBe(false)
    expect(d.reasons.some((r) => r.channel === 'teams')).toBe(false)
    await notifyUser(
      { io: null } as unknown as FastifyInstance,
      '44444444-4444-4444-4444-444444444444',
      {
        subject: 'Approval requested',
        message: 'm',
        category: 'workflow'
      }
    )
    expect(state.build).not.toHaveBeenCalled()
    expect(state.deliver).not.toHaveBeenCalled()
  })

  it('test mode -> teams false with a teams_test_mode reason', async () => {
    state.testTeamsOn = true
    const d = await ask(on)
    expect(d.teams).toBe(false)
    expect(d.reasons.find((r) => r.channel === 'teams')?.code).toBe('teams_test_mode')
  })

  it('a target-less notification gets an absolute open URL', async () => {
    state.prefs = { matrix: { workflow: { teams: true } } }
    await notifyUser(
      { io: null } as unknown as FastifyInstance,
      '55555555-5555-5555-5555-555555555555',
      {
        subject: 'Approval requested',
        message: 'm',
        category: 'workflow'
      }
    )
    await vi.waitFor(() => expect(state.build).toHaveBeenCalled())
    expect(state.build.mock.calls[0]?.[0].openUrl).toMatch(/^https:\/\//)
  })
})
