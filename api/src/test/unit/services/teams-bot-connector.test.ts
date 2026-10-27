import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamsBotConfig } from '../../../services/teams-bot/config.js'
import {
  ConnectorError,
  getBotToken,
  getPagedMembers,
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

describe('getPagedMembers', () => {
  it('getPagedMembers stops after AUDIENCE_CAP + 1', async () => {
    const page = (n: number, from: number, token?: string) =>
      json({
        members: Array.from({ length: n }, (_, i) => ({
          id: `29:${from + i}`,
          aadObjectId: `oid-${from + i}`,
          name: `P${from + i}`
        })),
        ...(token ? { continuationToken: token } : {})
      })
    const f = vi.fn(async (url: string) => {
      if (url.includes('login.microsoftonline.com'))
        return json({ access_token: 't', expires_in: 3600 })
      if (!url.includes('continuationToken')) return page(15, 0, 'p2')
      if (url.includes('continuationToken=p2')) return page(15, 15, 'p3')
      return page(15, 30)
    })
    vi.stubGlobal('fetch', f)
    const r = await getPagedMembers('https://smba.test/', '19:team@thread.tacv2', 21)
    expect(r.truncated).toBe(true)
    expect(r.members).toHaveLength(30)
    const calls = f.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('pagedmembers'))
    // The third page is never asked for.
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(
      'https://smba.test/v3/conversations/19%3Ateam%40thread.tacv2/pagedmembers?pageSize=100'
    )
    expect(calls[1]).toContain('continuationToken=p2')
  })

  it('reads the whole roster when it is small, keeping members without an Entra id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('login.microsoftonline.com')
          ? json({ access_token: 't', expires_in: 3600 })
          : json({ members: [{ id: '29:a', aadObjectId: 'oid-a' }, { id: '29:b' }] })
      )
    )
    const r = await getPagedMembers('https://smba.test', 'team', 21)
    expect(r).toEqual({
      truncated: false,
      members: [
        { id: '29:a', aadObjectId: 'oid-a', name: '' },
        { id: '29:b', aadObjectId: null, name: '' }
      ]
    })
  })

  it('refuses a non-https service url and surfaces connector errors', async () => {
    await expect(getPagedMembers('http://smba.test', 'team', 21)).rejects.toBeInstanceOf(
      ConnectorError
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('login.microsoftonline.com')
          ? json({ access_token: 't', expires_in: 3600 })
          : json({}, { status: 403 })
      )
    )
    await expect(getPagedMembers('https://smba.test', 'team', 21)).rejects.toMatchObject({
      status: 403
    })
  })
})
