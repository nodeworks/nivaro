import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchJson = vi.fn<(...a: any[]) => any>()
const openSecret = vi.fn<(...a: any[]) => any>()

vi.mock('../../../services/gitlab-client.js', () => ({
  fetchJson: (...a: unknown[]) => fetchJson(...a)
}))
vi.mock('../../../services/hub/secrets.js', () => ({
  openSecret: (...a: unknown[]) => openSecret(...a)
}))

import {
  HUB_STATUS_TTL_S,
  hubStatusKey,
  readAppStatus,
  readEnvironmentStatus
} from '../../../services/hub/status.js'

const linked = { id: 7, key: 'prod', base_url: 'https://app.example.test/', hub_token: 'enc:v1:x' }
const plain = { id: 8, key: 'dev', base_url: 'https://dev.example.test', hub_token: null }

function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, _ex: 'EX', _s: number) => {
      store.set(k, v)
      return 'OK'
    })
  }
}

beforeEach(() => {
  fetchJson.mockReset()
  openSecret.mockReset().mockReturnValue('t'.repeat(40))
})

describe('readEnvironmentStatus — hub link', () => {
  it('reads /api/hub-link/status with the opened token', async () => {
    fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      body: { version: '0.3.208', preflight: { status: 'ok', failing: [] } }
    })
    const s = await readEnvironmentStatus(linked)
    expect(fetchJson).toHaveBeenCalledTimes(1)
    const [url, headers, timeout] = fetchJson.mock.calls[0]
    expect(url).toBe('https://app.example.test/api/hub-link/status')
    expect(headers).toMatchObject({ Authorization: `Bearer ${'t'.repeat(40)}` })
    expect(timeout).toBe(8000)
    expect(s).toMatchObject({
      state: 'ok',
      version: '0.3.208',
      preflight: 'ok',
      source: 'hub-link'
    })
    expect(typeof s.checked_at).toBe('string')
  })

  it('a failing preflight is degraded', async () => {
    fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      body: { version: '1.0.0', preflight: { status: 'fail', failing: ['database'] } }
    })
    const s = await readEnvironmentStatus(linked)
    expect(s.state).toBe('degraded')
    expect(s.preflight).toBe('fail')
  })

  it('401 is link_refused and never falls back to the public routes', async () => {
    fetchJson.mockResolvedValue({ ok: false, status: 401, body: { code: 'HUB_LINK_REFUSED' } })
    const s = await readEnvironmentStatus(linked)
    expect(s).toMatchObject({ state: 'link_refused', source: 'hub-link', version: null })
    expect(s.error).toBe('HUB_LINK_REFUSED')
    expect(fetchJson).toHaveBeenCalledTimes(1)
  })

  it('a token that cannot be opened is link_refused with the secret code', async () => {
    openSecret.mockImplementation(() => {
      throw Object.assign(new Error('nope'), { code: 'HUB_SECRET_UNREADABLE' })
    })
    const s = await readEnvironmentStatus(linked)
    expect(s).toMatchObject({ state: 'link_refused', error: 'HUB_SECRET_UNREADABLE' })
    expect(fetchJson).not.toHaveBeenCalled()
  })

  it('a timeout is unreachable', async () => {
    fetchJson.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const s = await readEnvironmentStatus(linked)
    expect(s).toMatchObject({ state: 'unreachable', source: 'hub-link', error: 'TIMEOUT' })
  })

  it('a network error is unreachable', async () => {
    fetchJson.mockRejectedValue(new TypeError('fetch failed'))
    const s = await readEnvironmentStatus(linked)
    expect(s).toMatchObject({ state: 'unreachable', error: 'UNREACHABLE' })
  })
})

describe('readEnvironmentStatus — public', () => {
  it('reads /api/version and /api/health without a token', async () => {
    fetchJson.mockImplementation(async (url: string) =>
      url.endsWith('/api/version')
        ? { ok: true, status: 200, body: { version: '0.3.100' } }
        : { ok: true, status: 200, body: { status: 'ok', version: '0.3.100' } }
    )
    const s = await readEnvironmentStatus(plain)
    const urls = fetchJson.mock.calls.map((c) => c[0]).sort()
    expect(urls).toEqual([
      'https://dev.example.test/api/health',
      'https://dev.example.test/api/version'
    ])
    for (const c of fetchJson.mock.calls) expect(c[1]).not.toHaveProperty('Authorization')
    expect(s).toMatchObject({ state: 'ok', version: '0.3.100', preflight: null, source: 'public' })
  })

  it('a degraded health verdict is degraded', async () => {
    fetchJson.mockImplementation(async (url: string) =>
      url.endsWith('/api/version')
        ? { ok: true, status: 200, body: { version: '0.3.100' } }
        : { ok: false, status: 503, body: { status: 'degraded' } }
    )
    const s = await readEnvironmentStatus(plain)
    expect(s).toMatchObject({ state: 'degraded', source: 'public' })
  })

  it('a timeout is unreachable', async () => {
    fetchJson.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const s = await readEnvironmentStatus(plain)
    expect(s).toMatchObject({ state: 'unreachable', source: 'public' })
  })
})

describe('readEnvironmentStatus — cache', () => {
  it('serves a cached answer for 30 s; fresh bypasses it', async () => {
    const redis = fakeRedis()
    fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      body: { version: '1.0.0', preflight: { status: 'ok', failing: [] } }
    })
    const first = await readEnvironmentStatus(linked, { redis })
    expect(redis.set).toHaveBeenCalledWith(hubStatusKey(7), JSON.stringify(first), 'EX', 30)
    expect(HUB_STATUS_TTL_S).toBe(30)
    const second = await readEnvironmentStatus(linked, { redis })
    expect(second).toEqual(first)
    expect(fetchJson).toHaveBeenCalledTimes(1)
    await readEnvironmentStatus(linked, { redis, fresh: true })
    expect(fetchJson).toHaveBeenCalledTimes(2)
    expect(hubStatusKey(7)).toBe('nvr:hub:status:7')
  })

  it('reads on when Redis is unavailable', async () => {
    const redis = {
      get: vi.fn(async () => {
        throw new Error('down')
      }),
      set: vi.fn(async () => {
        throw new Error('down')
      })
    }
    fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      body: { version: '1.0.0', preflight: { status: 'ok', failing: [] } }
    })
    const s = await readEnvironmentStatus(linked, { redis })
    expect(s.state).toBe('ok')
  })
})

describe('readAppStatus', () => {
  it('one hanging environment never holds up the others', async () => {
    fetchJson.mockImplementation((url: string) =>
      url.startsWith('https://app.example.test')
        ? new Promise(() => {
            /* never answers */
          })
        : Promise.resolve(
            url.endsWith('/api/version')
              ? { ok: true, status: 200, body: { version: '2.0.0' } }
              : { ok: true, status: 200, body: { status: 'ok' } }
          )
    )
    const started = Date.now()
    const out = await readAppStatus([linked, plain], { timeoutMs: 50 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(out.map((e) => [e.id, e.key, e.status.state])).toEqual([
      [7, 'prod', 'unreachable'],
      [8, 'dev', 'ok']
    ])
    expect(out[0].status.error).toBe('TIMEOUT')
  })
})
