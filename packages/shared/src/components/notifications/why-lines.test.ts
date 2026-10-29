import { describe, expect, it } from 'vitest'
import { type StoredWhyReason, whyChangeLinks, whyLines } from './why-lines'

const base: StoredWhyReason = {
  v: 1,
  path: { kind: 'rules', text: 'Your rules are on.', label: null, id: null },
  category: 'workflow',
  critical: false,
  role: { id: 'R1', name: 'Engineer' },
  layers: { inapp: 'system', push: 'role', teams: 'system', email: 'person', quiet: 'role' },
  channels: { inapp: true, push: false, teams: false, email: 'deferred' },
  rules: [
    {
      code: 'quiet_hours_push',
      channel: 'push',
      text: 'Quiet hours — push is held.',
      layer: 'role'
    },
    { code: 'email_daily', channel: 'email', text: 'Daily summary.', layer: 'person' }
  ]
}

describe('whyLines (#3078)', () => {
  it('names the rule and the layer that picked each channel', () => {
    const lines = whyLines(base)
    expect(lines.map((l) => l.key)).toEqual(['inapp', 'push', 'email'])
    const push = lines.find((l) => l.key === 'push')
    expect(push).toMatchObject({
      outcome: 'not sent',
      rule: 'Quiet hours — push is held.',
      layer: 'role'
    })
    expect(lines.find((l) => l.key === 'email')).toMatchObject({
      outcome: 'daily summary',
      layer: 'person'
    })
    // No rule touched in-app: the decision's layer for it stands.
    expect(lines.find((l) => l.key === 'inapp')).toMatchObject({ rule: null, layer: 'system' })
  })

  it('an email nobody asked for has no layer; teams only when it had something to say', () => {
    const lines = whyLines({ ...base, channels: { ...base.channels, email: 'not_requested' } })
    expect(lines.find((l) => l.key === 'email')).toMatchObject({
      outcome: 'not asked for',
      layer: null
    })
    expect(lines.some((l) => l.key === 'teams')).toBe(false)
  })

  it('escalation steps the cron fired are listed with their layer', () => {
    const lines = whyLines({
      ...base,
      escalation: [{ channel: 'email', after_min: 240, layer: 'role', at: '2026-10-29T12:00:00Z' }]
    })
    const step = lines.find((l) => l.label === 'Escalation')
    expect(step).toMatchObject({ outcome: 'still unread after 4 h → email', layer: 'role' })
  })

  it('change links: subscriptions for a watch, the rules page always', () => {
    const paths = {
      subscriptionsPath: '/alerts/subscriptions',
      rulesPath: '/profile#notification-rules'
    }
    expect(whyChangeLinks('watch', paths).map((l) => l.to)).toEqual([
      '/alerts/subscriptions',
      '/profile#notification-rules'
    ])
    expect(whyChangeLinks('role_default', paths).map((l) => l.to)).toEqual([
      '/profile#notification-rules'
    ])
  })
})
