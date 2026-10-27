import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  enabled: true,
  testOn: false,
  link: null as null | Record<string, string>,
  send: vi.fn(),
  markLink: vi.fn(async () => {}),
  noteChannel: vi.fn()
}))

vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: h.enabled })
}))
vi.mock('../../../services/channel-test-mode.js', () => ({
  getChannelTestConfig: async () => ({ teams: { on: h.testOn, webhook: null } })
}))
vi.mock('../../../services/traffic-taps/channels.js', () => ({ noteChannel: h.noteChannel }))
vi.mock('../../../services/teams-bot/links.js', () => ({
  linkForUser: async () => h.link,
  markLink: h.markLink,
  noteLinkSent: async () => {},
  noteLinkError: async () => {}
}))
vi.mock('../../../services/teams-bot/connector.js', async () => {
  class ConnectorError extends Error {
    status: number
    retryAfterMs?: number
    constructor(status: number, message: string, retryAfterMs?: number) {
      super(message)
      this.status = status
      this.retryAfterMs = retryAfterMs
    }
  }
  return { ConnectorError, sendActivity: h.send }
})

import { ConnectorError } from '../../../services/teams-bot/connector.js'
import { deliverTeams } from '../../../services/teams-bot/send.js'

const app = {} as FastifyInstance
const card = { type: 'AdaptiveCard' } as never
const go = () => deliverTeams(app, 'u1', card, { notificationId: 1 })

beforeEach(() => {
  h.enabled = true
  h.testOn = false
  h.link = { conversation_id: 'c1', service_url: 'https://smba.test/', aad_object_id: 'o1' }
  h.send.mockReset()
  h.send.mockResolvedValue({ id: 'a1' })
  h.markLink.mockClear()
  h.noteChannel.mockClear()
  vi.useRealTimers()
})

describe('deliverTeams', () => {
  it('sends an adaptive card attachment and counts it', async () => {
    expect(await go()).toBe('sent')
    const [url, conv, activity] = h.send.mock.calls[0] as unknown as [string, string, any]
    expect([url, conv]).toEqual(['https://smba.test/', 'c1'])
    expect(activity.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(h.noteChannel).toHaveBeenCalledWith('teams', 'sent', expect.anything())
  })

  it('is disabled when the bot is off, and in test mode (no recipient list exists)', async () => {
    h.enabled = false
    expect(await go()).toBe('disabled')
    h.enabled = true
    h.testOn = true
    expect(await go()).toBe('disabled')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.noteChannel).toHaveBeenCalledWith('teams', 'dropped')
  })

  it('is not_connected with no link or no chat yet', async () => {
    h.link = null
    expect(await go()).toBe('not_connected')
    h.link = { conversation_id: '', service_url: '', aad_object_id: 'o1' }
    expect(await go()).toBe('not_connected')
  })

  it('retries once after a 429 Retry-After', async () => {
    vi.useFakeTimers()
    h.send.mockRejectedValueOnce(new ConnectorError(429, 'slow down', 2000))
    const p = go()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe('sent')
    expect(h.send).toHaveBeenCalledTimes(2)
  })

  it('caps the wait at 30 seconds and gives up after one retry', async () => {
    vi.useFakeTimers()
    h.send.mockRejectedValue(new ConnectorError(429, 'slow down', 600_000))
    const p = go()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await p).toBe('failed')
    expect(h.send).toHaveBeenCalledTimes(2)
  })

  it('marks the link uninstalled on 403 and 404', async () => {
    h.send.mockRejectedValue(new ConnectorError(403, 'blocked'))
    expect(await go()).toBe('not_connected')
    expect(h.markLink).toHaveBeenCalledWith('o1', 'uninstalled', expect.any(String))
  })

  it('a network error is failed, not thrown', async () => {
    h.send.mockRejectedValue(new Error('ECONNRESET'))
    expect(await go()).toBe('failed')
    expect(h.markLink).not.toHaveBeenCalled()
  })
})
