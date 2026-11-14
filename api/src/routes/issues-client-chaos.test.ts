import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackError = vi.fn(async () => 42)

vi.mock('../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../middleware/authenticate.js', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { id: 'u1' }
  },
  requireAdmin: async () => {}
}))
vi.mock('../plugins/socketio.js', () => ({ emitNotification: vi.fn() }))
vi.mock('../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../services/error-tracking.js', () => ({ trackError }))
vi.mock('../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))
vi.mock('../services/permissions.js', () => ({ can: vi.fn() }))

const { crashReportsOverLimit, issuesRoutes } = await import('./issues.js')
const { resetWindowedMemory } = await import('../services/windowed-limit.js')

async function app() {
  const f = Fastify()
  await f.register(issuesRoutes, { prefix: '/issues' })
  return f
}

describe('POST /issues/client and browser chaos mode (#2840)', () => {
  beforeEach(() => trackError.mockClear())

  it('files an ordinary crash', async () => {
    const f = await app()
    const res = await f.inject({
      method: 'POST',
      url: '/issues/client',
      payload: { message: 'boom', url: '/x' }
    })
    expect(res.statusCode).toBe(204)
    expect(trackError).toHaveBeenCalledTimes(1)
    await f.close()
  })

  it('does not file a crash the tab provoked with chaos on', async () => {
    const f = await app()
    const res = await f.inject({
      method: 'POST',
      url: '/issues/client',
      headers: { 'x-nivaro-client-chaos': 'api-down' },
      payload: { message: 'boom', url: '/x' }
    })
    expect(res.statusCode).toBe(204)
    expect(trackError).not.toHaveBeenCalled()
    await f.close()
  })

  it('groups by the screen pattern, app and release the tab reports', async () => {
    const f = await app()
    const res = await f.inject({
      method: 'POST',
      url: '/issues/client',
      headers: {
        'x-nivaro-app': 'efp-new',
        'x-nivaro-page': '/queues/:id',
        'x-nivaro-client': 'build=0.3.112; tab=abc'
      },
      payload: {
        message: 'bad "Jane Smith" value',
        name: 'TypeError',
        kind: 'rejection',
        url: '/queues/4471?token=x',
        stack: 'TypeError: bad\n    at Kt (https://h/assets/Queue-B3kF9a_x.js:1:2)'
      }
    })
    expect(res.statusCode).toBe(204)
    const call = (trackError.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(call).toMatchObject({
      source: 'client',
      route: '/queues/:id',
      build: '0.3.112',
      message: 'TypeError: bad "…" value',
      userId: 'u1'
    })
    expect(String(call.fingerprint)).toHaveLength(64)
    expect((call.detailsHeader as string[])[0]).toMatch(
      /^Crash: app=efp-new; release=0.3.112; kind=rejection;/
    )
    await f.close()
  })

  it('never files a browser extension failing in its own script', async () => {
    const f = await app()
    const res = await f.inject({
      method: 'POST',
      url: '/issues/client',
      payload: { message: 'x', stack: 'TypeError: x\n    at chrome-extension://abc/c.js:1:1' }
    })
    expect(res.statusCode).toBe(204)
    expect(trackError).not.toHaveBeenCalled()
    await f.close()
  })
})

describe('POST /issues/client is rate-limited per person', () => {
  beforeEach(() => {
    trackError.mockClear()
    resetWindowedMemory()
  })

  it('files 20 reports a minute, then answers a bare 429 and files nothing', async () => {
    const f = await app()
    const codes: number[] = []
    for (let i = 0; i < 23; i++) {
      const res = await f.inject({
        method: 'POST',
        url: '/issues/client',
        payload: { message: `boom ${i}`, url: '/x' }
      })
      codes.push(res.statusCode)
      if (res.statusCode === 429) expect(res.body).toBe('')
    }
    expect(codes.slice(0, 20).every((c) => c === 204)).toBe(true)
    expect(codes.slice(20)).toEqual([429, 429, 429])
    expect(trackError).toHaveBeenCalledTimes(20)
    await f.close()
  })

  it('caps the day too', async () => {
    vi.stubEnv('CRASH_REPORTS_PER_MINUTE', '1000')
    vi.stubEnv('CRASH_REPORTS_PER_DAY', '5')
    const results: boolean[] = []
    for (let i = 0; i < 7; i++) results.push(await crashReportsOverLimit(null, 'u-day'))
    vi.unstubAllEnvs()
    expect(results).toEqual([false, false, false, false, false, true, true])
  })
})
