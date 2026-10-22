import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { callExternalApi } from '../../external-apis.js'
import { instrumentStorage } from '../../storage/instrument.js'
import { _resetRegistryForTests, armFault, stopAll } from '../registry.js'
import { partnerChaosFetch, partnerFault, tlsError } from './partner.js'
import { storageChaos } from './storage.js'

const saved = { ...process.env }

beforeEach(() => {
  vi.useFakeTimers()
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
})

afterEach(async () => {
  await _resetRegistryForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  process.env = { ...saved }
})

describe('storage_faults', () => {
  function provider() {
    const calls: string[] = []
    const p = instrumentStorage(
      {
        async put(key: string) {
          calls.push(`put ${key}`)
        },
        async get(key: string) {
          calls.push(`get ${key}`)
          return Buffer.from('x')
        },
        async delete(key: string) {
          calls.push(`delete ${key}`)
        }
      },
      'test'
    )
    return { p, calls }
  }

  it('does nothing while unarmed', async () => {
    expect(storageChaos('write')).toBeNull()
    expect(storageChaos('read')).toBeNull()
    const { p, calls } = provider()
    await p.put('a')
    expect(calls).toEqual(['put a'])
  })

  it('slows the driver while armed', async () => {
    await armFault({ fault_key: 'storage_faults', params: { mode: 'slow', delay_ms: 1000 } })
    const { p, calls } = provider()
    let done = false
    const put = p.put('a').then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await put
    expect(calls).toEqual(['put a'])
  })

  it('slows only the chosen side', async () => {
    await armFault({
      fault_key: 'storage_faults',
      params: { mode: 'slow', delay_ms: 500, ops: 'writes' }
    })
    expect(storageChaos('read')).toBeNull()
    expect(storageChaos('write')).not.toBeNull()
  })

  it('fails writes with ENOSPC (a full disk still deletes) and leaves reads alone', async () => {
    await armFault({ fault_key: 'storage_faults', params: { mode: 'disk_full', delay_ms: 0 } })
    const { p, calls } = provider()
    await expect(p.put('a')).rejects.toMatchObject({ code: 'ENOSPC', errno: -28 })
    await p.delete('a')
    expect((await p.get('a')).toString()).toBe('x')
    expect(calls).toEqual(['delete a', 'get a'])
  })

  it('fails writes and deletes with EROFS on a read-only volume, then heals at the window end', async () => {
    await armFault({
      fault_key: 'storage_faults',
      params: { mode: 'read_only', delay_ms: 0 },
      seconds: 10
    })
    const { p } = provider()
    await expect(p.put('a')).rejects.toMatchObject({ code: 'EROFS' })
    await expect(p.delete('a')).rejects.toMatchObject({ code: 'EROFS' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(storageChaos('write')).toBeNull()
    await p.put('b')
  })

  it('clears on Stop all', async () => {
    await armFault({ fault_key: 'storage_faults', params: { mode: 'disk_full' } })
    expect(storageChaos('write')).not.toBeNull()
    await stopAll('test')
    expect(storageChaos('write')).toBeNull()
  })
})

describe('partner_faults', () => {
  const api = { id: 7, name: 'erp' }

  it('answers nothing while unarmed', () => {
    expect(partnerFault(api)).toBeNull()
  })

  it('picks the fault for the named API only (name or id; blank = every API)', async () => {
    await armFault({ fault_key: 'partner_faults', params: { api: 'other' } })
    expect(partnerFault(api)).toBeNull()
    const f = await armFault({ fault_key: 'partner_faults', params: { api: '7' } })
    expect(partnerFault(api)?.id).toBe(f.id)
    await stopAll('test')
    await armFault({ fault_key: 'partner_faults', params: { api: '' } })
    expect(partnerFault(api)).not.toBeNull()
  })

  it('answers each mode in the shape the caller sees from a real partner', async () => {
    const mk = async (mode: string, extra: Record<string, unknown> = {}) => {
      await stopAll('reset')
      return armFault({ fault_key: 'partner_faults', params: { mode, ...extra } })
    }
    let res = await partnerChaosFetch(await mk('error_500'), null)
    expect(res?.status).toBe(500)
    res = await partnerChaosFetch(await mk('rate_limited_429', { retry_after_s: 45 }), null)
    expect(res?.status).toBe(429)
    expect(res?.headers.get('retry-after')).toBe('45')
    res = await partnerChaosFetch(await mk('error_body_200'), null)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toMatchObject({ status: 'ERROR' })
    res = await partnerChaosFetch(
      await mk('error_body_200', { error_body: '{"result":{"code":"FAILED"}}' }),
      null
    )
    expect(await res?.json()).toEqual({ result: { code: 'FAILED' } })
    res = await partnerChaosFetch(await mk('malformed_json'), null)
    await expect(res?.clone().json()).rejects.toBeTruthy()
    await expect(partnerChaosFetch(await mk('tls_failure'), null)).rejects.toMatchObject({
      message: 'fetch failed',
      cause: { code: 'CERT_HAS_EXPIRED' }
    })
    expect((tlsError() as Error & { cause: { code: string } }).cause.code).toBe('CERT_HAS_EXPIRED')
  })

  it('latency waits, then makes the real call; an abort cuts the wait', async () => {
    const f = await armFault({
      fault_key: 'partner_faults',
      params: { mode: 'latency', delay_ms: 2000 }
    })
    const real = vi.fn(async () => new Response('ok', { status: 200 }))
    const p = partnerChaosFetch(f, real)
    await vi.advanceTimersByTimeAsync(1999)
    expect(real).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect((await p)?.status).toBe(200)
    const ctl = new AbortController()
    const cut = partnerChaosFetch(f, real, ctl.signal).catch((e) => e)
    ctl.abort()
    expect((await cut).name).toBe('AbortError')
  })

  it('callExternalApi takes the fault instead of the network, and the network again after', async () => {
    const row = {
      id: 7,
      name: 'erp',
      enabled: true,
      base_url: 'https://partner.example.test',
      auth_type: 'none',
      auth_config: null,
      headers: null,
      mock_config: null
    }
    const dbm = vi.mocked(db) as unknown as ReturnType<typeof vi.fn>
    const original = dbm.getMockImplementation()
    dbm.mockImplementation(() => {
      // A real promise (awaited by fire-and-forget log writes) carrying the builder methods.
      const chain = Promise.resolve([]) as unknown as Record<string, unknown>
      for (const m of ['where', 'andWhere', 'whereIn', 'orderBy', 'limit']) {
        chain[m] = () => chain
      }
      chain.first = async () => row
      chain.insert = async () => [1]
      chain.update = async () => 1
      return chain
    })
    const fetchSpy = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await armFault({
        fault_key: 'partner_faults',
        params: { api: 'erp', mode: 'rate_limited_429', retry_after_s: 12 },
        seconds: 10
      })
      const r = await callExternalApi('erp', { path: '/orders' })
      expect(r.status).toBe(429)
      expect(r.headers['retry-after']).toBe('12')
      expect(r.headers['x-nivaro-chaos']).toBe('1')
      expect(fetchSpy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(10_000)
      const ok = await callExternalApi('erp', { path: '/orders' })
      expect(ok.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    } finally {
      if (original) dbm.mockImplementation(original)
    }
  })
})
