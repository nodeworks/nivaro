// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindClientChaosSocket,
  CLIENT_CHAOS_HEADER,
  CLIENT_CHAOS_MAX_MS,
  CLIENT_CHAOS_STORAGE_KEY,
  canUseClientChaos,
  clearPretendDown,
  clientChaosApiPath,
  clientChaosAxiosInterceptor,
  clientSocketGone,
  decideClientChaos,
  getClientChaos,
  installClientChaosFetch,
  isClientChaosWrite,
  resetClientChaosForTests,
  setPretendDown,
  startClientChaos,
  stopClientChaos,
  withClientChaos
} from './client-chaos'
import { createWorkerSocket, WORKER_SOCKET_PROTO } from './worker-socket'

class FakeAxiosError extends Error {
  constructor(
    message?: string,
    public code?: string,
    public config?: any,
    public request?: any,
    public response?: any
  ) {
    super(message)
  }
}

function okBase() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"ok":1}'))
}

const MIN = 60_000

beforeEach(() => {
  resetClientChaosForTests()
  sessionStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  resetClientChaosForTests()
})

describe('gate and paths', () => {
  it('admits admins only, never in a View-as tab', () => {
    expect(canUseClientChaos({ is_admin: true })).toBe(true)
    expect(canUseClientChaos({ is_admin: true, masquerade: true })).toBe(false)
    expect(canUseClientChaos({ is_admin: false })).toBe(false)
    expect(canUseClientChaos(null)).toBe(false)
  })

  it('reads the API path off any origin', () => {
    expect(clientChaosApiPath('/api/items/orders?limit=1')).toBe('/items/orders')
    expect(clientChaosApiPath('https://api.example.com/api/auth/me')).toBe('/auth/me')
    expect(clientChaosApiPath('/assets/app.js')).toBeNull()
    expect(clientChaosApiPath('/apix/thing')).toBeNull()
  })

  it('counts saves, not read-shaped POSTs', () => {
    expect(isClientChaosWrite('PATCH', '/items/orders/1')).toBe(true)
    expect(isClientChaosWrite('DELETE', '/items/orders/1')).toBe(true)
    expect(isClientChaosWrite('POST', '/items/orders')).toBe(true)
    expect(isClientChaosWrite('POST', '/items/batch-read')).toBe(false)
    expect(isClientChaosWrite('POST', '/widgets-internal/7/render')).toBe(false)
    expect(isClientChaosWrite('GET', '/items/orders')).toBe(false)
  })
})

describe('unarmed', () => {
  it('does nothing at all', async () => {
    expect(decideClientChaos({ method: 'GET', url: '/api/items/x' })).toEqual({
      kind: 'pass',
      mark: null
    })
    const base = okBase()
    const f = withClientChaos(base as unknown as typeof fetch)
    const init = { method: 'PATCH' }
    await f('/api/items/orders/1', init)
    expect(base).toHaveBeenCalledWith('/api/items/orders/1', init)
    const cfg = { method: 'get', url: '/items/x', baseURL: '/api', headers: {} }
    const out = await clientChaosAxiosInterceptor(FakeAxiosError)(cfg)
    expect(out).toBe(cfg)
    expect((out as { adapter?: unknown }).adapter).toBeUndefined()
  })
})

describe('presets', () => {
  it('API down answers the proxy 503, leaves the gate, sign-out and other origins alone', async () => {
    startClientChaos({ preset: 'api-down', durationMs: 5 * MIN })
    const base = okBase()
    const f = withClientChaos(base as unknown as typeof fetch)
    const res = await f('/api/items/orders')
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('Service Unavailable')
    expect(res.headers.get(CLIENT_CHAOS_HEADER)).toBe('api-down')
    expect(base).not.toHaveBeenCalled()
    await f('/api/chaos/status')
    await f('/api/auth/logout', { method: 'POST' })
    await f('/assets/logo.svg')
    expect(base).toHaveBeenCalledTimes(3)
  })

  it('marks the error reporter so a provoked crash is not filed as a real bug', async () => {
    startClientChaos({ preset: 'api-down', durationMs: 5 * MIN })
    const base = okBase()
    const f = withClientChaos(base as unknown as typeof fetch)
    await f('/api/issues/client', { method: 'POST', headers: { 'content-type': 'x' } })
    const init = base.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get(CLIENT_CHAOS_HEADER)).toBe('api-down')
    expect(headers.get('content-type')).toBe('x')
  })

  it('offline rejects like a dead network and flips navigator.onLine until stopped', async () => {
    installClientChaosFetch()
    const offline = vi.fn()
    const online = vi.fn()
    window.addEventListener('offline', offline)
    window.addEventListener('online', online)
    startClientChaos({ preset: 'offline', durationMs: MIN })
    expect(navigator.onLine).toBe(false)
    expect(offline).toHaveBeenCalledTimes(1)
    const f = withClientChaos(okBase() as unknown as typeof fetch)
    await expect(f('/api/items/orders')).rejects.toThrow(new TypeError('Failed to fetch'))
    stopClientChaos()
    expect(navigator.onLine).toBe(true)
    expect(online).toHaveBeenCalledTimes(1)
  })

  it('flaky fails its share and slows the rest', () => {
    startClientChaos({ preset: 'flaky', durationMs: MIN, strength: 30 })
    const low = decideClientChaos({ url: '/api/items/x' }, () => 0.1)
    expect(low.kind).toBe('network')
    const high = decideClientChaos({ url: '/api/items/x' }, () => 0.9)
    expect(high.kind).toBe('delay')
  })

  it('slow adds about the chosen time', () => {
    startClientChaos({ preset: 'slow', durationMs: MIN, strength: 2000 })
    const d = decideClientChaos({ url: '/api/items/x' }, () => 0.5)
    expect(d).toEqual({ kind: 'delay', ms: 2000 })
  })

  it('clamps duration and strength', () => {
    const s = startClientChaos({ preset: 'flaky', durationMs: 99 * MIN, strength: 500 }, 0)
    expect(s.endsAt).toBe(CLIENT_CHAOS_MAX_MS)
    expect(s.strength).toBe(90)
    const t = startClientChaos({ preset: 'api-down', durationMs: 1 }, 0)
    expect(t.endsAt).toBe(10_000)
  })
})

describe('fail my next N saves', () => {
  it('fails exactly N writes with Fastify’s 500 and lets reads through', async () => {
    startClientChaos({ preset: null, durationMs: 5 * MIN, failWrites: 2 })
    const base = okBase()
    const f = withClientChaos(base as unknown as typeof fetch)
    expect((await f('/api/items/orders')).status).toBe(200)
    expect((await f('/api/items/batch-read', { method: 'POST' })).status).toBe(200)
    const first = await f('/api/items/orders/1', { method: 'PATCH' })
    expect(first.status).toBe(500)
    expect(await first.json()).toMatchObject({ error: 'Internal Server Error' })
    expect(getClientChaos()?.failWrites).toBe(1)
    expect((await f('/api/items/orders', { method: 'POST' })).status).toBe(500)
    // Used up: the window closes itself.
    expect(getClientChaos()).toBeNull()
    expect((await f('/api/items/orders/1', { method: 'PATCH' })).status).toBe(200)
  })
})

describe('the window', () => {
  it('ends on time even when no timer fires, and Stop always clears', () => {
    startClientChaos({ preset: 'api-down', durationMs: MIN }, 1000)
    expect(decideClientChaos({ url: '/api/x' }, Math.random, 2000).kind).toBe('status')
    expect(decideClientChaos({ url: '/api/x' }, Math.random, 1000 + MIN).kind).toBe('pass')
    expect(sessionStorage.getItem(CLIENT_CHAOS_STORAGE_KEY)).toBeNull()

    startClientChaos({ preset: 'api-down', durationMs: MIN })
    stopClientChaos()
    expect(getClientChaos()).toBeNull()
    expect(decideClientChaos({ url: '/api/x' }).kind).toBe('pass')
  })

  it('the end timer tells listeners', async () => {
    vi.useFakeTimers()
    const seen = vi.fn()
    startClientChaos({ preset: 'slow', durationMs: 10_000 })
    const { subscribeClientChaos } = await import('./client-chaos')
    subscribeClientChaos(seen)
    await vi.advanceTimersByTimeAsync(10_100)
    expect(getClientChaos()).toBeNull()
    expect(seen).toHaveBeenCalled()
  })

  it('survives a reload inside its window only', () => {
    const now = Date.now()
    sessionStorage.setItem(
      CLIENT_CHAOS_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        preset: 'api-down',
        strength: 0,
        failWrites: 0,
        startedAt: now,
        endsAt: now + MIN
      })
    )
    expect(getClientChaos(now + 1)?.preset).toBe('api-down')

    resetClientChaosForTests()
    sessionStorage.setItem(
      CLIENT_CHAOS_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        preset: 'api-down',
        strength: 0,
        failWrites: 0,
        startedAt: now - 2 * MIN,
        endsAt: now - MIN
      })
    )
    expect(getClientChaos(now)).toBeNull()
    expect(sessionStorage.getItem(CLIENT_CHAOS_STORAGE_KEY)).toBeNull()

    // A hand-edited window longer than any start allows is dropped too.
    resetClientChaosForTests()
    sessionStorage.setItem(
      CLIENT_CHAOS_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        preset: 'api-down',
        strength: 0,
        failWrites: 0,
        startedAt: now,
        endsAt: now + 10 * CLIENT_CHAOS_MAX_MS
      })
    )
    expect(getClientChaos(now)).toBeNull()
  })

  it('works with storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    startClientChaos({ preset: 'api-down', durationMs: MIN })
    expect(getClientChaos()?.preset).toBe('api-down')
    stopClientChaos()
    expect(getClientChaos()).toBeNull()
    spy.mockRestore()
  })
})

describe('pretend down (#2858)', () => {
  it('fails only the named dependency, as its real error, until cleared', async () => {
    setPretendDown('dash', [
      { id: 'q', label: 'Sales query', patterns: [/^\/custom-queries\/7\b/] }
    ])
    const base = okBase()
    const f = withClientChaos(base as unknown as typeof fetch)
    const res = await f('/api/custom-queries/7/execute', { method: 'POST' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Sales query is unavailable' })
    expect((await f('/api/custom-queries/8/execute', { method: 'POST' })).status).toBe(200)
    clearPretendDown('dash')
    expect((await f('/api/custom-queries/7/execute', { method: 'POST' })).status).toBe(200)
  })

  it('a socket dependency drops the socket', () => {
    expect(clientSocketGone()).toBe(false)
    setPretendDown('layout', [{ id: 'rt', label: 'Live updates', patterns: [], socket: true }])
    expect(clientSocketGone()).toBe(true)
    clearPretendDown('layout')
    expect(clientSocketGone()).toBe(false)
  })
})

describe('axios', () => {
  const run = clientChaosAxiosInterceptor(FakeAxiosError)

  it('a dead network is axios’s own Network Error', async () => {
    startClientChaos({ preset: 'offline', durationMs: MIN })
    const cfg: any = await run({ method: 'get', url: '/items/x', baseURL: '/api', headers: {} })
    await expect(cfg.adapter(cfg)).rejects.toMatchObject({
      message: 'Network Error',
      code: 'ERR_NETWORK',
      response: undefined
    })
  })

  it('a 503 carries a response the interceptors can read', async () => {
    startClientChaos({ preset: 'api-down', durationMs: MIN })
    const cfg: any = await run({ method: 'get', url: 'items/x', baseURL: '/api/', headers: {} })
    const err = await cfg.adapter(cfg).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FakeAxiosError)
    expect(err.message).toBe('Request failed with status code 503')
    expect(err.code).toBe('ERR_BAD_RESPONSE')
    expect(err.response.status).toBe(503)
    expect(err.response.data).toBe('Service Unavailable')
    expect(err.response.headers[CLIENT_CHAOS_HEADER]).toBe('api-down')
  })

  it('failed saves parse as JSON; the gate passes untouched', async () => {
    startClientChaos({ preset: null, durationMs: MIN, failWrites: 1 })
    const gate: any = await run({ method: 'get', url: '/chaos/status', baseURL: '/api' })
    expect(gate.adapter).toBeUndefined()
    const cfg: any = await run({ method: 'patch', url: '/items/x/1', baseURL: '/api' })
    const err = await cfg.adapter(cfg).catch((e: unknown) => e)
    expect(err.response.status).toBe(500)
    expect(err.response.data).toMatchObject({ error: 'Internal Server Error' })
  })
})

describe('socket gone', () => {
  it('disconnects a plain socket and reconnects it when the window ends', () => {
    const s = { connect: vi.fn(), disconnect: vi.fn() }
    bindClientChaosSocket(s)
    bindClientChaosSocket(s) // idempotent
    expect(s.disconnect).not.toHaveBeenCalled()
    startClientChaos({ preset: 'socket-gone', durationMs: MIN })
    expect(s.disconnect).toHaveBeenCalledTimes(1)
    stopClientChaos()
    expect(s.connect).toHaveBeenCalledTimes(1)
    // Other presets leave the socket alone.
    startClientChaos({ preset: 'api-down', durationMs: MIN })
    expect(s.disconnect).toHaveBeenCalledTimes(1)
  })

  it('pauses a worker tab without touching the shared worker, then re-greets it', () => {
    const posted: Array<Record<string, any>> = []
    let onmessage: ((ev: MessageEvent) => void) | null = null
    class W {
      port = {
        postMessage: (m: Record<string, any>) => posted.push(m),
        start() {},
        close() {},
        set onmessage(f: (ev: MessageEvent) => void) {
          onmessage = f
        },
        onmessageerror: null
      }
      onerror = null
    }
    ;(window as any).SharedWorker = W
    const socket = createWorkerSocket({
      url: '/api/realtime/worker.js',
      app: 'admin',
      authToken: async () => 't',
      fallback: () => {
        throw new Error('no fallback in this test')
      }
    })
    const answer = (data: Record<string, any>) => onmessage?.({ data } as MessageEvent)
    answer({ t: 'ready', proto: WORKER_SOCKET_PROTO })
    answer({ t: 'ev', event: 'connect', args: [] })
    const onDisconnect = vi.fn()
    const onUpdate = vi.fn()
    const onFull = vi.fn()
    socket.on('disconnect', onDisconnect)
    socket.on('collection:update', onUpdate)
    window.addEventListener('nvr:catchup-full', onFull)
    expect(socket.connected).toBe(true)

    startClientChaos({ preset: 'socket-gone', durationMs: MIN })
    expect(socket.connected).toBe(false)
    expect(onDisconnect).toHaveBeenCalledWith('transport close')
    answer({ t: 'ev', event: 'collection:update', args: [{ collection: 'orders' }] })
    expect(onUpdate).not.toHaveBeenCalled()
    const before = posted.length
    socket.emit('collection:join', { collection: 'orders' })
    expect(posted.length).toBe(before)
    // Nothing went to the worker that would end its socket for the other tabs.
    expect(posted.filter((m) => m.t === 'bye')).toEqual([])

    stopClientChaos()
    expect(posted.filter((m) => m.t === 'hello')).toHaveLength(2)
    expect(onFull).toHaveBeenCalledTimes(1)
    answer({ t: 'ev', event: 'collection:update', args: [{ collection: 'orders' }] })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    ;(window as any).SharedWorker = undefined
  })
})
