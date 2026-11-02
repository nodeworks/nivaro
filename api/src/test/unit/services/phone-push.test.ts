import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())
const safeFetchMock = vi.hoisted(() => vi.fn())
const h = vi.hoisted(() => ({
  phones: [] as Array<{ id: number; endpoint: string }>,
  badge: 3,
  deleted: [] as number[],
  touched: [] as number[],
  routed: { userId: 'u1', prefix: '' } as { userId: string; prefix: string } | null,
  noteChannel: vi.fn(),
  noteChannelRedirect: vi.fn(),
  settings: null as { overrides?: string; name?: string } | null
}))

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const st: { op: string; ids: number[] } = { op: 'select', ids: [] }
    const b: Record<string, unknown> = {}
    const self = () => b
    Object.assign(b, {
      where: self,
      select: self,
      first: self,
      whereIn: (_c: string, ids: number[]) => {
        st.ids = ids
        return b
      },
      count: () => {
        st.op = 'count'
        return b
      },
      del: () => {
        st.op = 'del'
        return b
      },
      update: () => {
        st.op = 'update'
        return b
      },
      // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        let v: unknown = h.phones
        if (table === 'nivaro_notifications') v = { c: h.badge }
        else if (table === 'nivaro_settings_overrides')
          v = h.settings?.overrides ? { data: h.settings.overrides } : undefined
        else if (table === 'nivaro_settings') v = { project_name: h.settings?.name }
        else if (st.op === 'del') {
          h.deleted.push(...st.ids)
          v = st.ids.length
        } else if (st.op === 'update') {
          h.touched.push(...st.ids)
          v = st.ids.length
        }
        return Promise.resolve(v).then(res, rej)
      },
      catch: (f: (e: unknown) => unknown) => (b.then as any)(undefined, f)
    })
    return b
  }
  return { db }
})
vi.mock('../../../services/channel-test-mode.js', () => ({ routePush: async () => h.routed }))
vi.mock('../../../services/traffic-taps/channels.js', () => ({
  noteChannel: h.noteChannel,
  noteChannelRedirect: h.noteChannelRedirect
}))
vi.mock('../../../lib/ssrf.js', () => ({
  safeFetch: safeFetchMock
}))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://acme.example' }))
vi.mock('../../../services/swallow-counter.js', () => ({ countSwallow: () => {} }))
// Static-token / API-key phone rows: their stamps and whether those credentials still work.
const cred = vi.hoisted(() => ({
  stamps: new Map<number, string | null>(),
  live: new Map<string, boolean>(),
  checks: [] as string[],
  removed: [] as number[][]
}))
vi.mock('../../../services/device-grants.js', () => ({
  phoneRowStamps: vi.fn(async (_r: unknown, ids: number[]) => {
    const m = new Map<number, string | null>()
    for (const id of ids) m.set(id, cred.stamps.get(id) ?? null)
    return m
  }),
  credentialLive: vi.fn(async (_r: unknown, by: string) => {
    cred.checks.push(by)
    return cred.live.get(by) ?? true
  }),
  deletePushRowsOrKeep: vi.fn(async (_r: unknown, _u: string, ids: number[]) => {
    cred.removed.push(ids)
  })
}))

import {
  isExpoPushToken,
  phonePushMode,
  resetRelayWarnings,
  sendPhonePush,
  setPhonePushRedis
} from '../../../services/phone-push.js'

const TOKEN = 'ExponentPushToken[abc123]'

function tickets(...t: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ data: t }) }
}

beforeEach(() => {
  h.phones = [{ id: 7, endpoint: `expo:${TOKEN}` }]
  h.badge = 3
  h.deleted = []
  h.touched = []
  h.routed = { userId: 'u1', prefix: '' }
  h.noteChannel.mockClear()
  fetchMock.mockReset()
  safeFetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  delete process.env.MOBILE_PUSH
  delete process.env.EXPO_ACCESS_TOKEN
  delete process.env.EXPO_PUSH_URL
  delete process.env.MOBILE_PUSH_RELAY_KEY
  h.settings = null
  resetRelayWarnings()
  cred.stamps.clear()
  cred.live.clear()
  cred.checks = []
  cred.removed = []
  setPhonePushRedis({} as never)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('isExpoPushToken', () => {
  it('accepts Expo tokens only', () => {
    expect(isExpoPushToken(TOKEN)).toBe(true)
    expect(isExpoPushToken('ExpoPushToken[x-y_z]')).toBe(true)
    expect(isExpoPushToken('https://fcm.googleapis.com/x')).toBe(false)
    expect(isExpoPushToken('ExponentPushToken[a b]')).toBe(false)
    expect(isExpoPushToken(42)).toBe(false)
  })
})

describe('sendPhonePush', () => {
  it('sends title, body, data and the unread badge to each phone', async () => {
    process.env.EXPO_ACCESS_TOKEN = 'tok'
    fetchMock.mockResolvedValueOnce(tickets({ status: 'ok', id: 't1' }))
    const n = await sendPhonePush('u1', {
      title: 'Approve PO',
      body: 'CM26-1 waits on you',
      data: { id: 5, collection: 'workflows', item: '9' }
    })
    expect(n).toBe(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://exp.host/--/api/v2/push/send')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(JSON.parse(String(init.body))).toEqual([
      {
        to: TOKEN,
        title: 'Approve PO',
        body: 'CM26-1 waits on you',
        data: { id: 5, collection: 'workflows', item: '9' },
        sound: 'default',
        priority: 'high',
        badge: 3
      }
    ])
    expect(h.touched).toEqual([7])
    expect(h.noteChannel).toHaveBeenCalledWith('push', 'sent', expect.anything())
  })

  it('removes a phone Expo no longer knows', async () => {
    fetchMock.mockResolvedValueOnce(
      tickets({ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } })
    )
    expect(await sendPhonePush('u1', { title: 't', body: 'b' })).toBe(0)
    expect(h.deleted).toEqual([7])
  })

  it('reads receipts back later and removes dead phones', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(tickets({ status: 'ok', id: 't1' })).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { t1: { status: 'error', details: { error: 'DeviceNotRegistered' } } }
      })
    })
    await sendPhonePush('u1', { title: 't', body: 'b' })
    expect(h.deleted).toEqual([])
    await vi.advanceTimersByTimeAsync(31_000)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://exp.host/--/api/v2/push/getReceipts')
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      ids: ['t1']
    })
    expect(h.deleted).toEqual([7])
  })

  it('does nothing when MOBILE_PUSH=off or the person has no phone', async () => {
    process.env.MOBILE_PUSH = 'off'
    expect(await sendPhonePush('u1', { title: 't', body: 'b' })).toBe(0)
    delete process.env.MOBILE_PUSH
    h.phones = []
    expect(await sendPhonePush('u1', { title: 't', body: 'b' })).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('test mode: drops, or redirects with the prefix and without the row id', async () => {
    h.routed = null
    expect(await sendPhonePush('u1', { title: 't', body: 'b' })).toBe(0)
    expect(h.noteChannel).toHaveBeenCalledWith('push', 'dropped')

    h.routed = { userId: 'tester', prefix: '[for Bob] ' }
    fetchMock.mockResolvedValueOnce(tickets({ status: 'ok', id: 't2' }))
    await sendPhonePush('u1', {
      title: 'Hi',
      body: 'b',
      data: { id: 5, collection: 'c', item: '1' }
    })
    const msg = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))[0]
    expect(msg.title).toBe('[for Bob] Hi')
    expect(msg.data).toEqual({ id: null, collection: 'c', item: '1' })
  })

  it('never throws when Expo is unreachable (the stubbed fetch refuses; no real call)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new TypeError('mock: Expo unreachable'))
    expect(await sendPhonePush('u1', { title: 't', body: 'b' })).toBe(0)
    expect(h.noteChannel).toHaveBeenCalledWith('push', 'failed', expect.anything())
    // The Expo call went to the stub, never the network.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.anything()
    )
    expect(globalThis.fetch).toBe(fetchMock)
    warn.mockRestore()
  })
})

describe('relay phones', () => {
  const DEV = 'd'.repeat(24)
  const relayOk = (...results: Array<{ device: string; status: string }>) => ({
    ok: true,
    status: 200,
    json: async () => ({ results })
  })
  beforeEach(() => {
    process.env.MOBILE_PUSH_RELAY_KEY = 'rk'
    h.phones = [{ id: 9, endpoint: `relay:${DEV}` }]
  })

  it('sends full content with ids, url and instance; Expo is not called', async () => {
    safeFetchMock.mockResolvedValueOnce(relayOk({ device: DEV, status: 'ok' }))
    const n = await sendPhonePush('u1', {
      title: 'Approve PO',
      body: 'CM26-1 waits',
      data: { id: 5, collection: 'workflows', item: '9', url: '/collections/workflows/9' }
    })
    expect(n).toBe(1)
    expect(safeFetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    const [url, init] = safeFetchMock.mock.calls[0] as [string, any]
    expect(url).toBe('https://push.nivaro.dev/v1/send')
    expect(init.headers.authorization).toBe('Bearer rk')
    expect(JSON.parse(init.body).messages).toEqual([
      {
        device: DEV,
        title: 'Approve PO',
        body: 'CM26-1 waits',
        data: {
          notification_id: '5',
          instance: 'https://acme.example',
          url: '/collections/workflows/9',
          collection: 'workflows',
          item: '9'
        },
        badge: 3
      }
    ])
    expect(h.touched).toEqual([9])
  })

  it('minimal content: instance name as title, generic body, ids only', async () => {
    h.settings = {
      overrides: JSON.stringify({ mobile_push: { content: 'minimal' } }),
      name: 'Acme'
    }
    safeFetchMock.mockResolvedValueOnce(relayOk({ device: DEV, status: 'ok' }))
    await sendPhonePush('u1', {
      title: 'Secret PO 123',
      body: 'Vendor X owes',
      data: { id: 5, collection: 'workflows', item: '9', url: '/collections/workflows/9' }
    })
    const msg = JSON.parse((safeFetchMock.mock.calls[0]?.[1] as any).body).messages[0]
    expect(msg.title).toBe('Acme')
    expect(msg.body).toBe('You have a new notification')
    expect(msg.data).toEqual({ notification_id: '5', instance: 'https://acme.example' })
  })

  it('relay rows but no key: skipped with one count-only warning', async () => {
    delete process.env.MOBILE_PUSH_RELAY_KEY
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await sendPhonePush('u1', { title: 't', body: 'b' })).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('1 phone')
    expect(safeFetchMock).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('no relay connected: the warning is logged at most once an hour per tenant', async () => {
    delete process.env.MOBILE_PUSH_RELAY_KEY
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let k = 0; k < 3; k++) await sendPhonePush('u1', { title: 't', body: 'b' })
    expect(warn).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 61 * 60_000)
    await sendPhonePush('u1', { title: 't', body: 'b' })
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('gone removes the row', async () => {
    safeFetchMock.mockResolvedValueOnce(relayOk({ device: DEV, status: 'gone' }))
    expect(await sendPhonePush('u1', { title: 't', body: 'b' })).toBe(0)
    expect(h.deleted).toEqual([9])
  })

  it('relay 5xx or timeout: 0 delivered, one log, no throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    safeFetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    expect(await sendPhonePush('u1', { title: 't', body: 'b' })).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(h.noteChannel).toHaveBeenCalledWith('push', 'failed', expect.anything())
    safeFetchMock.mockRejectedValueOnce(new Error('timeout'))
    expect(await sendPhonePush('u1', { title: 't', body: 'b' })).toBe(0)
    expect(h.deleted).toEqual([])
    warn.mockRestore()
  })

  it('splits mixed rows by prefix and batches relay calls at 50 (120 → 3 calls)', async () => {
    h.phones = [
      { id: 7, endpoint: `expo:${TOKEN}` },
      ...Array.from({ length: 120 }, (_, i) => ({
        id: 100 + i,
        endpoint: `relay:${String(i).padStart(20, 'x')}`
      }))
    ]
    fetchMock.mockResolvedValueOnce(tickets({ status: 'ok', id: 't1' }))
    safeFetchMock.mockResolvedValue(relayOk())
    await sendPhonePush('u1', { title: 't', body: 'b' })
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['https://exp.host/--/api/v2/push/send'])
    expect(safeFetchMock).toHaveBeenCalledTimes(3)
    const sizes = safeFetchMock.mock.calls.map(
      (c) => JSON.parse((c[1] as any).body).messages.length
    )
    expect(sizes).toEqual([50, 50, 20])
  })
})

describe('phones registered with a static token or API key', () => {
  beforeEach(() => {
    h.phones = [
      { id: 31, endpoint: `expo:${TOKEN}` },
      { id: 32, endpoint: 'expo:ExponentPushToken[def456]' },
      { id: 33, endpoint: 'expo:ExponentPushToken[ghi789]' }
    ]
    fetchMock.mockResolvedValue(tickets({ status: 'ok', id: 'a' }, { status: 'ok', id: 'b' }))
  })
  const sentTo = () =>
    fetchMock.mock.calls
      .flatMap((c) => JSON.parse((c[1] as { body: string }).body))
      .map((m: { to: string }) => m.to)

  it('a regenerated static token: that phone gets nothing and its row goes', async () => {
    cred.stamps.set(31, 'token:aaaaaaaaaaaaaaaa')
    cred.live.set('token:aaaaaaaaaaaaaaaa', false)
    await sendPhonePush('u1', { title: 't', body: 'b' })
    expect(sentTo()).not.toContain(TOKEN)
    expect(sentTo()).toHaveLength(2)
    expect(cred.removed).toEqual([[31]])
  })

  it('an expired API key: the same; a live key is still sent to', async () => {
    cred.stamps.set(32, 'key:7')
    cred.stamps.set(33, 'key:8')
    cred.live.set('key:7', false)
    cred.live.set('key:8', true)
    await sendPhonePush('u1', { title: 't', body: 'b' })
    expect(sentTo()).toEqual(expect.arrayContaining([TOKEN, 'ExponentPushToken[ghi789]']))
    expect(sentTo()).not.toContain('ExponentPushToken[def456]')
    expect(cred.removed).toEqual([[32]])
  })

  it('one check per distinct stamp per send; session and grant rows are not checked', async () => {
    cred.stamps.set(31, 'key:9')
    cred.stamps.set(32, 'key:9')
    cred.stamps.set(33, 'sid:abc')
    await sendPhonePush('u1', { title: 't', body: 'b' })
    expect(cred.checks).toEqual(['key:9'])
    expect(sentTo()).toHaveLength(3)
  })
})

describe('phonePushMode', () => {
  it('off, direct, relay', async () => {
    process.env.MOBILE_PUSH = 'off'
    expect(await phonePushMode()).toBe('off')
    delete process.env.MOBILE_PUSH
    expect(await phonePushMode()).toBe('direct')
    process.env.MOBILE_PUSH_RELAY_KEY = 'k'
    expect(await phonePushMode()).toBe('relay')
  })
})
