import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runForSource = vi.fn()
const submissionsFor = vi.fn()
const aiCallsForRequest = vi.fn()
const apisOfDownNode = vi.fn()
const flowDryRun = vi.fn()
vi.mock('../../services/traffic-inspect/background.js', () => ({
  runForSource: (...a: unknown[]) => runForSource(...a),
  submissionsFor: (...a: unknown[]) => submissionsFor(...a),
  aiCallsForRequest: (...a: unknown[]) => aiCallsForRequest(...a),
  apisOfDownNode: (...a: unknown[]) => apisOfDownNode(...a),
  flowDryRun: (...a: unknown[]) => flowDryRun(...a)
}))

import { inspectBackgroundRoutes } from './inspect-background.js'

const RUN = '54b4cb84-ebda-420f-8185-eacd4fcd64db'

async function app() {
  const a = Fastify()
  await a.register(inspectBackgroundRoutes)
  return a
}

afterEach(() => {
  runForSource.mockReset()
  submissionsFor.mockReset()
  aiCallsForRequest.mockReset()
  apisOfDownNode.mockReset()
  flowDryRun.mockReset()
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

  it('submissions-for needs a partner node, a numeric api or a uuid chain', async () => {
    const a = await app()
    expect((await a.inject({ url: '/inspect/submissions-for' })).statusCode).toBe(400)
    expect((await a.inject({ url: '/inspect/submissions-for?api=x1' })).statusCode).toBe(400)
    expect((await a.inject({ url: '/inspect/submissions-for?chain=nope' })).statusCode).toBe(400)
    expect((await a.inject({ url: '/inspect/submissions-for?node=db' })).statusCode).toBe(400)
    expect((await a.inject({ url: "/inspect/submissions-for?node=x:a'b" })).statusCode).toBe(400)
    submissionsFor.mockResolvedValue({ rows: [], matched_by: 'api-time' })
    const ok = await a.inject({ url: '/inspect/submissions-for?api=2&at=1700000000000&window=60' })
    expect(ok.statusCode).toBe(200)
    expect(submissionsFor).toHaveBeenCalledWith({
      apiId: 2,
      apiIds: [],
      chainId: null,
      at: 1700000000000,
      windowSec: 60
    })
    expect(apisOfDownNode).not.toHaveBeenCalled()
  })

  it('submissions-for resolves a down node to its partner APIs, and says why when it cannot', async () => {
    apisOfDownNode.mockResolvedValue({ ids: [4, 9], reason: null })
    submissionsFor.mockResolvedValue({ rows: [{ id: 1 }], matched_by: 'api-time' })
    const a = await app()
    const ok = await a.inject({
      url: '/inspect/submissions-for?node=x:efp-ops.mdsi&at=1700000000000'
    })
    expect(ok.statusCode).toBe(200)
    expect(apisOfDownNode).toHaveBeenCalledWith('x:efp-ops.mdsi')
    expect(submissionsFor).toHaveBeenCalledWith(expect.objectContaining({ apiIds: [4, 9] }))
    expect(ok.json().data).toEqual({ rows: [{ id: 1 }], matched_by: 'api-time', reason: null })

    apisOfDownNode.mockResolvedValue({ ids: [], reason: 'not loaded here' })
    submissionsFor.mockResolvedValue({ rows: [], matched_by: null })
    const none = await a.inject({ url: '/inspect/submissions-for?node=x:efp-ops.mwf' })
    expect(none.statusCode).toBe(200)
    expect(none.json().data).toEqual({ rows: [], matched_by: null, reason: 'not loaded here' })

    apisOfDownNode.mockResolvedValue({ ids: [7], reason: null })
    submissionsFor.mockResolvedValue({ rows: [], matched_by: 'api-time' })
    const ext = await a.inject({ url: '/inspect/submissions-for?node=ext:7' })
    expect(ext.statusCode).toBe(200)
    expect(submissionsFor).toHaveBeenLastCalledWith(expect.objectContaining({ apiIds: [7] }))
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

  describe('POST /inspect/flow-dry-run/:runId', () => {
    it('400 for an id that is not a uuid, before any read', async () => {
      const a = await app()
      const res = await a.inject({ method: 'POST', url: "/inspect/flow-dry-run/1';DROP" })
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('INSPECT_ID_INVALID')
      expect(flowDryRun).not.toHaveBeenCalled()
    })

    it('404 when the run or its flow is gone', async () => {
      flowDryRun.mockResolvedValue(null)
      const a = await app()
      const res = await a.inject({ method: 'POST', url: `/inspect/flow-dry-run/${RUN}` })
      expect(res.statusCode).toBe(404)
      expect(res.json().code).toBe('INSPECT_NOT_FOUND')
    })

    it('500 with a sentence, never the statement, when the read fails', async () => {
      flowDryRun.mockRejectedValue(new Error('select input from nivaro_flow_runs - boom'))
      const a = await app()
      const res = await a.inject({ method: 'POST', url: `/inspect/flow-dry-run/${RUN}` })
      expect(res.statusCode).toBe(500)
      expect(res.json().code).toBe('INSPECT_FAILED')
      expect(res.json().error).not.toMatch(/select/i)
    })

    it('runs on the stored payload from the id alone — any posted body is ignored', async () => {
      flowDryRun.mockResolvedValue({
        steps: [{ key: 'a', name: 'A', type: 'condition', status: 'resolve' }],
        output: { key: '••••••' },
        error: null,
        dry_run: true,
        payload_used: 'stored'
      })
      const a = await app()
      const res = await a.inject({
        method: 'POST',
        url: `/inspect/flow-dry-run/${RUN}`,
        payload: { payload: { key: 'attacker-chosen' } }
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().data.steps).toHaveLength(1)
      expect(flowDryRun).toHaveBeenCalledTimes(1)
      expect(flowDryRun.mock.calls[0][0]).toBe(RUN)
      expect(flowDryRun.mock.calls[0][1]).toMatchObject({ log: expect.anything() })
      expect(JSON.stringify(flowDryRun.mock.calls[0])).not.toMatch(/attacker-chosen/)
    })
  })
})
