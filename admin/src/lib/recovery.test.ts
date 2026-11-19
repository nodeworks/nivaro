import {
  AxiosError,
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig
} from 'axios'
import { describe, expect, it, vi } from 'vitest'
import { axiosVerdict, recoveringAdapter } from './recovery'

vi.mock('sonner', () => ({
  toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

const cfg = (method: string, url: string, extra: Partial<InternalAxiosRequestConfig> = {}) =>
  ({ method, url, headers: new AxiosHeaders(), ...extra }) as InternalAxiosRequestConfig

const ok = (config: InternalAxiosRequestConfig) =>
  ({ status: 200, data: {}, headers: {}, config, statusText: 'OK' }) as AxiosResponse

/** An AxiosError with an answer (status / code), or none at all (network). */
const fail = (config: InternalAxiosRequestConfig, status?: number, code?: string) =>
  new AxiosError(
    'x',
    status ? undefined : 'ERR_NETWORK',
    config,
    undefined,
    status
      ? ({
          status,
          data: code ? { code } : {},
          headers: {},
          config,
          statusText: ''
        } as AxiosResponse)
      : undefined
  )

describe('admin recovery adapter', () => {
  it('a read waits out a network error', async () => {
    const base = vi.fn()
    base.mockImplementationOnce(async (c) => {
      throw fail(c)
    })
    base.mockImplementationOnce(async (c) => ok(c))
    const res = await recoveringAdapter(base)(cfg('get', '/items/orders'))
    expect(res.status).toBe(200)
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('a record save carries the same key on every try', async () => {
    const base = vi.fn()
    const keys: unknown[] = []
    base.mockImplementation(async (c: InternalAxiosRequestConfig) => {
      keys.push(c.headers.get('Idempotency-Key'))
      if (keys.length === 1) throw fail(c, 502)
      return ok(c)
    })
    await recoveringAdapter(base)(cfg('patch', '/items/orders/7'))
    expect(keys).toHaveLength(2)
    expect(String(keys[0])).toMatch(/^nvr-/)
    expect(keys[1]).toBe(keys[0])
  })

  it('any other write runs once, without a key', async () => {
    const base = vi.fn(async (c: InternalAxiosRequestConfig) => {
      throw fail(c, 503)
    })
    const c = cfg('post', '/fields/orders')
    await expect(recoveringAdapter(base)(c)).rejects.toBeInstanceOf(AxiosError)
    expect(base).toHaveBeenCalledTimes(1)
    expect(c.headers.has('Idempotency-Key')).toBe(false)
  })

  it('a download runs once', async () => {
    const base = vi.fn(async (c: InternalAxiosRequestConfig) => {
      throw fail(c, 503)
    })
    await expect(
      recoveringAdapter(base)(cfg('get', '/files/1', { responseType: 'blob' }))
    ).rejects.toBeInstanceOf(AxiosError)
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('reads the code from a raw JSON string body (axios has not parsed it in the adapter)', async () => {
    const base = vi.fn(async (c: InternalAxiosRequestConfig) => {
      throw new AxiosError('x', undefined, c, undefined, {
        status: 503,
        data: '{"code":"MAINTENANCE"}',
        headers: {},
        config: c,
        statusText: ''
      } as AxiosResponse)
    })
    await expect(recoveringAdapter(base)(cfg('patch', '/items/orders/7'))).rejects.toBeInstanceOf(
      AxiosError
    )
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('a bulk action and a batch read are not keyed writes', async () => {
    const base = vi.fn(async (c: InternalAxiosRequestConfig) => {
      throw fail(c, 503)
    })
    const bulk = cfg('post', '/items/orders/bulk-update')
    await expect(recoveringAdapter(base)(bulk)).rejects.toBeInstanceOf(AxiosError)
    expect(base).toHaveBeenCalledTimes(1)
    expect(bulk.headers.has('Idempotency-Key')).toBe(false)
  })

  it('never waits on our own read timeout, a cancel or a maintenance window', () => {
    const c = cfg('get', '/items/orders')
    expect(axiosVerdict('GET', false, new AxiosError('t', 'ECONNABORTED', c)).retry).toBe(false)
    expect(axiosVerdict('GET', false, fail(c, 503, 'MAINTENANCE')).retry).toBe(false)
    expect(axiosVerdict('GET', false, fail(c, 404)).retry).toBe(false)
    expect(axiosVerdict('GET', false, fail(c, 503, 'SERVER_BUSY')).retry).toBe(true)
    expect(axiosVerdict('PATCH', true, fail(c, 409, 'IDEMPOTENCY_IN_PROGRESS')).retry).toBe(true)
  })
})
