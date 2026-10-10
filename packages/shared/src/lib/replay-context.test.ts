import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONSOLE_MAX_CHARS,
  consoleLine,
  instrumentConsole,
  instrumentRequests,
  isRecorderNoise,
  REDACTED,
  redactSecrets,
  requestRoute
} from './replay-context'

const BASE = 'https://cms.example.com/collections/workflows'
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

describe('redactSecrets', () => {
  it('redacts JWTs, bearer credentials and long opaque strings', () => {
    expect(redactSecrets(`token expired: ${JWT}`)).toBe(`token expired: ${REDACTED}`)
    expect(redactSecrets('sent Bearer abc.def-123')).toBe(`sent Bearer ${REDACTED}`)
    expect(redactSecrets('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED}`)
    expect(redactSecrets('hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b')).toBe(`hash ${REDACTED}`)
    expect(redactSecrets('key Zq7Xw2Lm9Pt4Vr8Ks3Nd6Hb1Jf5Gc0Ya')).toBe(
      `key ${REDACTED}`
    )
  })

  it('redacts the value of a secret-named key, in every common shape', () => {
    expect(redactSecrets('GET /x?access_token=abc123&page=2')).toBe(
      `GET /x?access_token=${REDACTED}&page=2`
    )
    expect(redactSecrets('{"password":"hunter2","user":"bo"}')).toBe(
      `{"password":"${REDACTED}","user":"bo"}`
    )
    expect(redactSecrets('Authorization: Bearer xyz')).toBe(`Authorization: ${REDACTED}`)
    expect(redactSecrets("api_key='k1' apiKey=k2 X-API-KEY: k3 client_secret=s")).toBe(
      `api_key='${REDACTED}' apiKey=${REDACTED} X-API-KEY: ${REDACTED} client_secret=${REDACTED}`
    )
  })

  it('leaves ordinary messages, uuids and paths alone', () => {
    const plain = [
      'Invalid time value',
      'Basic configuration missing',
      'Warning: Each child in a list should have a unique "key" prop.',
      'record 8ba289a0-81fd-4d13-b56f-567cdb2d2a56 not found',
      'GET /api/items/workflow_instances/371367 failed with 500',
      'ResizeObserver loop completed with undelivered notifications.'
    ]
    for (const p of plain) expect(redactSecrets(p)).toBe(p)
  })
})

describe('consoleLine', () => {
  it('joins arguments, redacts, then caps at 200 characters', () => {
    const line = consoleLine(['Failed:', new Error('boom'), { token: 'abc', n: 1 }])
    expect(line).toBe(`Failed: Error: boom {"token":"${REDACTED}","n":1}`)
    const long = consoleLine(['x'.repeat(1000)])
    expect(long).toHaveLength(CONSOLE_MAX_CHARS)
  })

  it('redacts before cutting, so a token straddling the cut never leaks a prefix', () => {
    const line = consoleLine([`${'a '.repeat(90)}${JWT}`])
    expect(line).not.toContain('eyJ')
  })

  it('survives circular objects', () => {
    const o: Record<string, unknown> = {}
    o.self = o
    expect(consoleLine(['x', o])).toBe('x [object Object]')
  })
})

describe('requestRoute / isRecorderNoise', () => {
  it('keeps a route pattern: no ids, no query string, host only when cross-origin', () => {
    expect(requestRoute('/api/items/workflows/371367?fields=*&token=x', BASE)).toBe(
      '/api/items/workflows/:id'
    )
    expect(
      requestRoute('https://cms.example.com/api/users/8ba289a0-81fd-4d13-b56f-567cdb2d2a56', BASE)
    ).toBe('/api/users/:id')
    expect(requestRoute('https://partner.example/orders/A-1001/lines#top', BASE)).toBe(
      'partner.example/orders/:id/lines'
    )
    expect(requestRoute('data:text/plain,hi', BASE)).toBeNull()
  })

  it('knows the recorder’s own traffic', () => {
    expect(isRecorderNoise('/api/session-recordings/abc/events', BASE)).toBe(true)
    expect(isRecorderNoise('/api/rum', BASE)).toBe(true)
    expect(isRecorderNoise('/api/rum/summary', BASE)).toBe(false)
    expect(isRecorderNoise('/api/items/x', BASE)).toBe(false)
  })
})

describe('instrumentConsole', () => {
  const realWarn = console.warn
  const realError = console.error
  const realInfo = console.info
  afterEach(() => {
    console.warn = realWarn
    console.error = realError
    console.info = realInfo
  })

  it('emits warn and error only, still calls through, and undoes cleanly', () => {
    const through = vi.fn()
    console.warn = through
    console.error = through
    console.info = through
    const emit = vi.fn()
    const undo = instrumentConsole(emit)
    console.warn('careful', 'Bearer abc')
    console.error('bad')
    console.info('chatter')
    expect(through).toHaveBeenCalledTimes(3)
    expect(emit.mock.calls).toEqual([
      ['console', { level: 'warn', msg: `careful Bearer ${REDACTED}` }],
      ['console', { level: 'error', msg: 'bad' }]
    ])
    undo()
    expect(console.warn).toBe(through)
    console.error('after')
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('caps the number of lines and never recurses through its own emit', () => {
    console.warn = () => {}
    console.error = () => {}
    const emit = vi.fn(() => console.error('emit logged'))
    const undo = instrumentConsole(emit, 3)
    for (let i = 0; i < 10; i++) console.warn(`w${i}`)
    expect(emit).toHaveBeenCalledTimes(3)
    undo()
  })
})

describe('instrumentRequests', () => {
  const g = globalThis as { fetch?: unknown; XMLHttpRequest?: unknown; window?: unknown }
  const realFetch = g.fetch
  afterEach(() => {
    g.fetch = realFetch
    delete g.XMLHttpRequest
    vi.unstubAllGlobals()
  })

  it('logs fetch calls with method, route, status and duration; failures as status 0', async () => {
    vi.stubGlobal('window', { location: { href: BASE } })
    const inner = vi.fn(async (input: unknown) => {
      if (String(input).includes('down')) throw new TypeError('Failed to fetch')
      return { status: 404 } as Response
    })
    g.fetch = inner
    const emit = vi.fn()
    const undo = instrumentRequests(emit)
    const res = await fetch('/api/items/workflows/42?x=1', { method: 'post', body: 'secret' })
    expect(res.status).toBe(404)
    await expect(fetch('https://down.example/ping')).rejects.toThrow('Failed to fetch')
    await fetch('/api/session-recordings/r1/events', { method: 'POST' })
    await Promise.resolve()
    expect(inner).toHaveBeenCalledTimes(3)
    expect(emit.mock.calls.map((c) => c[1])).toEqual([
      {
        method: 'POST',
        route: '/api/items/workflows/:id',
        status: 404,
        duration_ms: expect.any(Number)
      },
      { method: 'GET', route: 'down.example/ping', status: 0, duration_ms: expect.any(Number) }
    ])
    expect(JSON.stringify(emit.mock.calls)).not.toContain('secret')
    undo()
    expect(g.fetch).toBe(inner)
  })

  it('logs XMLHttpRequest calls on loadend and restores the prototype', () => {
    vi.stubGlobal('window', { location: { href: BASE } })
    class FakeXhr {
      status = 0
      listeners: Array<() => void> = []
      open(_m: string, _u: string) {}
      send(_b?: unknown) {}
      addEventListener(_t: string, fn: () => void) {
        this.listeners.push(fn)
      }
    }
    const origOpen = FakeXhr.prototype.open
    g.XMLHttpRequest = FakeXhr
    g.fetch = undefined
    const emit = vi.fn()
    const undo = instrumentRequests(emit)
    const x = new FakeXhr()
    x.open('get', '/api/items/users/7?token=abc')
    x.send()
    x.status = 200
    for (const fn of x.listeners) fn()
    expect(emit).toHaveBeenCalledWith('request', {
      method: 'GET',
      route: '/api/items/users/:id',
      status: 200,
      duration_ms: expect.any(Number)
    })
    undo()
    expect(FakeXhr.prototype.open).toBe(origOpen)
  })

  it('caps the log per page load', async () => {
    vi.stubGlobal('window', { location: { href: BASE } })
    g.fetch = vi.fn(async () => ({ status: 200 }) as Response)
    const emit = vi.fn()
    const undo = instrumentRequests(emit, 2)
    for (let i = 0; i < 5; i++) await fetch(`/api/x/${i}`)
    await Promise.resolve()
    expect(emit).toHaveBeenCalledTimes(2)
    undo()
  })
})
