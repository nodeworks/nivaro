import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubSigninConfig } from '../../../services/hub-signin/config.js'
import {
  _resetHubProbeForTests,
  hubProbeReason,
  hubSigninUp,
  noteHubSigninFailed
} from '../../../services/hub-signin/probe.js'

// Nivaro Hub phase 7, Task 6 (Decision 5): is the Hub up for this app? Only a 200 `{ ok: true }`
// counts; up is remembered 15 s, down 30 s, a failed round trip marks it down 60 s.

const cfg: HubSigninConfig = {
  hubUrl: 'https://hub.example.com',
  issuer: 'https://hub.example.com/api/hub/oidc',
  clientId: 'hubc_0123456789abcdef01234567',
  clientSecret: 's'.repeat(48),
  idpAudience: 'hub-entra-client',
  allowInsecure: false
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

let clock = 1_000_000
const now = () => clock

beforeEach(() => {
  _resetHubProbeForTests()
  clock = 1_000_000
})
afterEach(() => vi.restoreAllMocks())

describe('hubSigninUp', () => {
  it('200 { ok: true } → up; asks the ping endpoint with the client id, no redirects', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }))
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      'https://hub.example.com/api/hub/oidc/ping?client_id=hubc_0123456789abcdef01234567'
    )
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // P7-15: authenticated as the client with HTTP Basic, never the secret in the URL.
    expect(url).not.toContain(cfg.clientSecret)
    const auth = (init.headers as Record<string, string>).authorization
    expect(auth).toBe(
      `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`
    )
  })

  it('200 { ok: false } (client inactive, app mode direct) → down', async () => {
    expect(await hubSigninUp(cfg, { fetchImpl: async () => json({ ok: false }), now })).toBe(false)
  })

  it('the Hub’s reason for ok:false is kept and logged once per change (P7-16)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const reason of ['REDIS_UNAVAILABLE', 'REDIS_UNAVAILABLE', 'NO_TENANT_ISSUER']) {
      clock += 31_000 // past the 30 s down memo
      expect(
        await hubSigninUp(cfg, { fetchImpl: async () => json({ ok: false, reason }), now })
      ).toBe(false)
      expect(hubProbeReason(cfg)).toBe(reason)
    }
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0][0])).toContain('REDIS_UNAVAILABLE')
    clock += 31_000
    await hubSigninUp(cfg, {
      fetchImpl: async () => json({ ok: false, reason: '<b>x</b>' }, 503),
      now
    })
    expect(hubProbeReason(cfg)).toBe('HTTP_503')
    clock += 31_000
    expect(await hubSigninUp(cfg, { fetchImpl: async () => json({ ok: true }), now })).toBe(true)
    expect(hubProbeReason(cfg)).toBeNull()
  })

  it('200 HTML (captive portal) → down', async () => {
    const fetchImpl = async () =>
      new Response('<html>{"ok":true}</html>', { headers: { 'content-type': 'text/html' } })
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(false)
  })

  it('non-200 → down; network failure → down', async () => {
    expect(await hubSigninUp(cfg, { fetchImpl: async () => json({ ok: true }, 503), now })).toBe(
      false
    )
    _resetHubProbeForTests()
    expect(
      await hubSigninUp(cfg, {
        fetchImpl: async () => {
          throw new TypeError('fetch failed')
        },
        now
      })
    ).toBe(false)
  })

  it('a probe that does not answer within 1.5 s → down', async () => {
    const fetchImpl = (_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () =>
          rej(new DOMException('timeout', 'TimeoutError'))
        )
      })
    const started = Date.now()
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(false)
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(1400)
    expect(took).toBeLessThan(3000)
  })

  it('remembers up for 15 s', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }))
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(true)
    clock += 14_999
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    clock += 2
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('remembers down for 30 s', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: false }))
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(false)
    clock += 29_999
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    clock += 2
    fetchImpl.mockImplementation(async () => json({ ok: true }))
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(true)
  })

  it('noteHubSigninFailed → down 60 s whatever the probe would say', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }))
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(true)
    noteHubSigninFailed(clock)
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(false)
    clock += 59_999
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    clock += 2
    expect(await hubSigninUp(cfg, { fetchImpl, now })).toBe(true)
  })

  it('concurrent askers share one probe', async () => {
    let resolve!: (r: Response) => void
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (resolve = r)))
    const a = hubSigninUp(cfg, { fetchImpl, now })
    const b = hubSigninUp(cfg, { fetchImpl, now })
    resolve(json({ ok: true }))
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('names the origin’s callback and sign-out addresses; each origin is probed and remembered on its own (P7-17)', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      json(
        url.includes(encodeURIComponent('https://alias.example.com'))
          ? { ok: false, reason: 'REDIRECT_NOT_REGISTERED' }
          : { ok: true }
      )
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = 'https://app.example.com'
    const alias = 'https://alias.example.com'
    expect(await hubSigninUp(cfg, { origin: app, fetchImpl, now })).toBe(true)
    const asked = new URL(fetchImpl.mock.calls[0][0] as string)
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      client_id: cfg.clientId,
      redirect_uri: 'https://app.example.com/api/auth/callback',
      post_logout_redirect_uri: 'https://app.example.com/login'
    })
    expect(await hubSigninUp(cfg, { origin: alias, fetchImpl, now })).toBe(false)
    expect(hubProbeReason(cfg, alias)).toBe('REDIRECT_NOT_REGISTERED')
    expect(hubProbeReason(cfg, app)).toBeNull()
    // both remembered: no new probe for either
    expect(await hubSigninUp(cfg, { origin: app, fetchImpl, now })).toBe(true)
    expect(await hubSigninUp(cfg, { origin: alias, fetchImpl, now })).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('another Hub or client is probed on its own', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }))
    await hubSigninUp(cfg, { fetchImpl, now })
    await hubSigninUp({ ...cfg, clientId: 'hubc_other' }, { fetchImpl, now })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
