import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runForSource = vi.fn()
const submissionsFor = vi.fn()
const aiCallsForRequest = vi.fn()
vi.mock('../../services/traffic-inspect/background.js', () => ({
  runForSource: (...a: unknown[]) => runForSource(...a),
  submissionsFor: (...a: unknown[]) => submissionsFor(...a),
  aiCallsForRequest: (...a: unknown[]) => aiCallsForRequest(...a)
}))

import { inspectBackgroundRoutes } from './inspect-background.js'

async function app() {
  const a = Fastify()
  await a.register(inspectBackgroundRoutes)
  return a
}

afterEach(() => {
  runForSource.mockReset()
  submissionsFor.mockReset()
  aiCallsForRequest.mockReset()
})

describe('inspect-background routes', () => {
  it('job-for refuses a source that is not cron:<job> or flow:<uuid>', async () => {
    const a = await app()
    const bad = await a.inject({ url: '/inspect/job-for?source=import:worker' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('INSPECT_ID_INVALID')
    expect(runForSource).not.toHaveBeenCalled()
  })

  it('job-for resolves a cron source at the given moment', async () => {
    runForSource.mockResolvedValue({ kind: 'job', id: '7', covering: true, started_at: null })
    const a = await app()
    const res = await a.inject({
      url: '/inspect/job-for?source=cron:staged-imports&at=1700000000000'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ kind: 'job', id: '7' })
    expect(runForSource).toHaveBeenCalledWith('cron:staged-imports', 1700000000000)
  })

  it('submissions-for needs a numeric api or a uuid chain', async () => {
    const a = await app()
    expect((await a.inject({ url: '/inspect/submissions-for' })).statusCode).toBe(400)
    expect((await a.inject({ url: '/inspect/submissions-for?api=x1' })).statusCode).toBe(400)
    expect((await a.inject({ url: '/inspect/submissions-for?chain=nope' })).statusCode).toBe(400)
    submissionsFor.mockResolvedValue({ rows: [], matched_by: 'api-time' })
    const ok = await a.inject({ url: '/inspect/submissions-for?api=2&at=1700000000000&window=60' })
    expect(ok.statusCode).toBe(200)
    expect(submissionsFor).toHaveBeenCalledWith({
      apiId: 2,
      chainId: null,
      at: 1700000000000,
      windowSec: 60
    })
  })

  it('ai-for-request validates the request id and never leaks a failure', async () => {
    const a = await app()
    expect((await a.inject({ url: "/inspect/ai-for-request/x'or" })).statusCode).toBe(400)
    aiCallsForRequest.mockRejectedValue(new Error('select * from nivaro_ai_calls - boom'))
    const res = await a.inject({
      url: '/inspect/ai-for-request/1fe39e32-d24f-479b-88e8-5724ef4233df'
    })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).not.toMatch(/select/i)
  })
})
