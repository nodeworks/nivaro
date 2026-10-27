import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamsBotConfig } from '../../../services/teams-bot/config.js'
import {
  ConnectorError,
  getBotToken,
  resetConnectorCache,
  sendActivity
} from '../../../services/teams-bot/connector.js'

const cfg: TeamsBotConfig = {
  enabled: true,
  appId: 'app',
  appSecret: 'secret',
  tenantId: 'tenant',
  source: 'env'
}

vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => cfg
}))

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })

beforeEach(() => {
  resetConnectorCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('getBotToken', () => {
  it('caches the token until near expiry', async () => {
    vi.useFakeTimers()
    const f = vi.fn(async () => json({ access_token: 't', expires_in: 3600 }))
    vi.stubGlobal('fetch', f)
    expect(await getBotToken(cfg)).toBe('t')
    vi.advanceTimersByTime(50 * 60 * 1000)
    await getBotToken(cfg)
    expect(f).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(6 * 60 * 1000) // inside the last 5 minutes
    await getBotToken(cfg)
    expect(f).toHaveBeenCalledTimes(2)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://login.microsoftonline.com/tenant/oauth2/v2.0/token')
    expect(String(init.body)).toContain('scope=https%3A%2F%2Fapi.botframework.com%2F.default')
  })

  it('two concurrent getBotToken calls make one request', async () => {
    const f = vi.fn(async () => json({ access_token: 't', expires_in: 3600 }))
    vi.stubGlobal('fetch', f)
    await Promise.all([getBotToken(cfg), getBotToken(cfg)])
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('ConnectorError', () => {
  it('429 surfaces retryAfterMs from Retry-After', async () => {
    const f = vi.fn(async (url: string) =>
      url.includes('login.microsoftonline.com')
        ? json({ access_token: 't', expires_in: 3600 })
        : new Response('slow down', { status: 429, headers: { 'retry-after': '7' } })
    )
    vi.stubGlobal('fetch', f)
    const err = await sendActivity('https://smba.example/amer/', 'conv;1', { text: 'hi' }).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(ConnectorError)
    expect(err.status).toBe(429)
    expect(err.retryAfterMs).toBe(7000)
  })
})
