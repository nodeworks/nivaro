import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  enabled: true,
  row: undefined as undefined | { status: string; linked_at: Date | null }
}))

vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: h.enabled })
}))
vi.mock('../../../db/index.js', () => ({
  db: () => {
    const q: Record<string, unknown> = {}
    q.where = () => q
    q.orderBy = () => q
    q.first = async () => h.row
    return q
  }
}))

import { ownTeamsFacts } from '../../../services/teams-bot/profile.js'

beforeEach(() => {
  h.enabled = true
  h.row = undefined
})

describe('ownTeamsFacts', () => {
  it('bot off: not available, no link', async () => {
    h.enabled = false
    expect(await ownTeamsFacts('u')).toEqual({ teams_available: false, teams_link: null })
  })
  it('bot on, never connected: available with no link', async () => {
    expect(await ownTeamsFacts('u')).toEqual({ teams_available: true, teams_link: null })
  })
  it('bot on and linked: the status and when', async () => {
    h.row = { status: 'active', linked_at: new Date('2026-10-27T12:00:00Z') }
    expect(await ownTeamsFacts('u')).toEqual({
      teams_available: true,
      teams_link: { status: 'active', linked_at: '2026-10-27T12:00:00.000Z' }
    })
  })
})
