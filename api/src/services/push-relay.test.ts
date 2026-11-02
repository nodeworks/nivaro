import knex from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  overrides: null as string | null,
  safeFetch: vi.fn(),
  updates: [] as unknown[],
  inserts: [] as unknown[]
}))

vi.mock('../db/index.js', () => ({
  db: (table: string) => {
    const b: Record<string, unknown> = {
      where: () => b,
      first: async () =>
        table === 'nivaro_settings_overrides' && h.overrides
          ? { id: 1, data: h.overrides }
          : undefined,
      update: async (v: unknown) => {
        h.updates.push(v)
        return 1
      },
      insert: async (v: unknown) => {
        h.inserts.push(v)
        return [1]
      }
    }
    return b
  }
}))
vi.mock('../lib/ssrf.js', () => ({ safeFetch: h.safeFetch }))

import {
  cleanRelayUrl,
  connectPushRelay,
  envRelayKey,
  isPhoneEndpoint,
  pushRelayConfig,
  RELAY_KEY_MASK,
  relaySend,
  setRelayKey,
  storeTenantRelay,
  wherePhoneEndpoint
} from './push-relay.js'

beforeEach(() => {
  h.overrides = null
  h.updates = []
  h.inserts = []
  h.safeFetch.mockReset()
  delete process.env.MOBILE_PUSH_RELAY_URL
  delete process.env.MOBILE_PUSH_RELAY_KEY
  delete process.env.CLOUD_META_DB_URL
})
afterEach(() => vi.restoreAllMocks())

describe('phone endpoints', () => {
  it('isPhoneEndpoint matches expo: and relay: only', () => {
    expect(isPhoneEndpoint('expo:ExponentPushToken[x]')).toBe(true)
    expect(isPhoneEndpoint('relay:abcdefghijklmnop')).toBe(true)
    expect(isPhoneEndpoint('https://fcm.googleapis.com/x')).toBe(false)
  })

  it('wherePhoneEndpoint matches both prefixes', () => {
    const k = knex({ client: 'mssql' })
    const q = wherePhoneEndpoint(k('nivaro_push_subscriptions').where({ user: 'u1' })).toSQL()
    expect(q.sql).toMatch(/\[endpoint\] like \? or \[endpoint\] like \?/)
    expect(q.bindings).toEqual(['u1', 'expo:%', 'relay:%'])
  })
})

describe('pushRelayConfig', () => {
  it('defaults to the Nivaro relay with no key and full content', async () => {
    expect(await pushRelayConfig()).toEqual({
      url: 'https://push.nivaro.dev',
      key: null,
      content: 'full'
    })
  })

  it('reads the stored key + content; env key and url win', async () => {
    h.overrides = JSON.stringify({ mobile_push: { relay_key: 'stored', content: 'minimal' } })
    expect(await pushRelayConfig()).toMatchObject({ key: 'stored', content: 'minimal' })
    process.env.MOBILE_PUSH_RELAY_KEY = 'envkey'
    process.env.MOBILE_PUSH_RELAY_URL = 'https://relay.example/'
    expect(await pushRelayConfig()).toMatchObject({ key: 'envkey', url: 'https://relay.example' })
  })

  it('a stored relay_url (cloud provisioning) beats the env url', async () => {
    h.overrides = JSON.stringify({
      mobile_push: { relay_key: 'stored', relay_url: 'https://relay.cloud.example/' }
    })
    process.env.MOBILE_PUSH_RELAY_URL = 'https://relay.env.example'
    expect(await pushRelayConfig()).toMatchObject({ url: 'https://relay.cloud.example' })
  })

  it('a stored relay_url that is not https is ignored', async () => {
    h.overrides = JSON.stringify({ mobile_push: { relay_url: 'http://relay.example' } })
    expect((await pushRelayConfig()).url).toBe('https://push.nivaro.dev')
  })

  it('cloud mode never uses the env key: only the stored one', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    process.env.MOBILE_PUSH_RELAY_KEY = 'envkey'
    expect((await pushRelayConfig()).key).toBeNull()
    expect(envRelayKey()).toBeNull()
    h.overrides = JSON.stringify({ mobile_push: { relay_key: 'tenant-key' } })
    expect((await pushRelayConfig()).key).toBe('tenant-key')
  })

  it('storeTenantRelay writes key + url into that database, keeping other keys', async () => {
    const writes: Array<{ op: string; v: Record<string, unknown> }> = []
    const conn = ((table: string) => {
      const b: Record<string, unknown> = {
        where: () => b,
        first: async () =>
          table === 'nivaro_settings_overrides'
            ? {
                id: 4,
                data: JSON.stringify({ chaos: { a: 1 }, mobile_push: { content: 'minimal' } })
              }
            : undefined,
        update: async (v: Record<string, unknown>) => writes.push({ op: 'update', v }),
        insert: async (v: Record<string, unknown>) => writes.push({ op: 'insert', v })
      }
      return b
    }) as never
    await storeTenantRelay(conn, { relay_key: 'k1', relay_url: 'https://relay.cloud.example' })
    expect(writes).toHaveLength(1)
    expect(JSON.parse(String(writes[0].v.data))).toEqual({
      chaos: { a: 1 },
      mobile_push: {
        content: 'minimal',
        relay_key: 'k1',
        relay_url: 'https://relay.cloud.example'
      }
    })
    // Nothing went to the process's own database.
    expect(h.updates).toEqual([])
  })

  it('cleanRelayUrl takes https origins (with a path) only', () => {
    expect(cleanRelayUrl('https://relay.example/x/')).toBe('https://relay.example/x')
    for (const bad of ['http://relay.example', 'ftp://x', 'https://u:p@relay.example', 'nope', 7])
      expect(cleanRelayUrl(bad)).toBeNull()
  })

  it('a masked key re-sent from a form leaves the stored key alone', async () => {
    await setRelayKey(RELAY_KEY_MASK)
    expect(h.updates).toEqual([])
    expect(h.inserts).toEqual([])
  })

  it('connect stores the key, keeping other override keys', async () => {
    h.overrides = JSON.stringify({ chaos: { a: 1 }, mobile_push: { content: 'minimal' } })
    h.safeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ key: 'newkey', instance_id: 'i1' })
    })
    await connectPushRelay('https://acme.example', 'Acme')
    const [url, init] = h.safeFetch.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('https://push.nivaro.dev/v1/instances')
    expect(JSON.parse(init.body)).toEqual({ origin: 'https://acme.example', name: 'Acme' })
    const saved = JSON.parse((h.updates[0] as { data: string }).data)
    expect(saved).toEqual({
      chaos: { a: 1 },
      mobile_push: { content: 'minimal', relay_key: 'newkey' }
    })
  })

  it('connect with no public origin refuses before any call', async () => {
    await expect(connectPushRelay('  ', 'A')).rejects.toMatchObject({ code: 'RELAY_NO_ORIGIN' })
    expect(h.safeFetch).not.toHaveBeenCalled()
  })

  it('connect refused by the relay throws', async () => {
    h.safeFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })
    await expect(connectPushRelay('https://a', 'A')).rejects.toThrow(/refused/)
  })
})

describe('relaySend', () => {
  const cfg = { url: 'https://r.example', key: 'k', content: 'full' as const }
  const msg = { device: 'd'.repeat(20), title: 't', body: 'b', data: {} }

  it('posts with the bearer key and returns the results', async () => {
    h.safeFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ device: msg.device, status: 'ok' }] })
    })
    expect(await relaySend(cfg, [msg])).toEqual([{ device: msg.device, status: 'ok' }])
    const [url, init] = h.safeFetch.mock.calls[0] as [string, any]
    expect(url).toBe('https://r.example/v1/send')
    expect(init.headers.authorization).toBe('Bearer k')
    expect(init.timeoutMs).toBe(3000)
  })

  it('5xx, timeout and no key all answer null without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.safeFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    expect(await relaySend(cfg, [msg])).toBeNull()
    h.safeFetch.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
    expect(await relaySend(cfg, [msg])).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(await relaySend({ ...cfg, key: null }, [msg])).toBeNull()
  })
})
