import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// S14: GET /my-work/counts is the tab-title figure — cheap, same numbers as /my-work's
// counts, signed-in only, and shared only per person + tenant for a moment.

const h = vi.hoisted(() => ({
  tenant: '',
  ownedCalls: [] as string[],
  owned: { u1: 3, u2: 1 } as Record<string, number>,
  approvals: { u1: 2, u2: 0 } as Record<string, number>,
  questions: { u1: 1, u2: 0 } as Record<string, number>,
  fail: false
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: async (req: { headers: Record<string, unknown>; user?: unknown }, reply: any) => {
    const id = req.headers['x-user']
    if (!id) return reply.code(401).send({ error: 'Unauthorized' })
    req.user = { id }
  }
}))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => h.tenant }))
vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: async (_u: string, fn: () => unknown) => fn()
}))
vi.mock('../../../services/request-trace.js', () => ({
  span: async (_n: string, fn: () => unknown) => fn()
}))
vi.mock('../../../services/queues.js', () => ({
  resolveOwnedByMeSource: async (u: string) => {
    h.ownedCalls.push(u)
    if (h.fail) throw new Error('boom')
    return { items: Array.from({ length: h.owned[u] ?? 0 }) }
  }
}))
vi.mock('../../../services/waiting-on-me.js', () => ({
  approvalStepsFor: async (u: string) => Array.from({ length: h.approvals[u] ?? 0 }),
  ownedWithSla: async (u: string) => ({ owned: Array.from({ length: h.owned[u] ?? 0 }) })
}))
vi.mock('../../../services/agent-questions.js', () => ({
  openQuestionsFor: async (u: string) => Array.from({ length: h.questions[u] ?? 0 }),
  markAnswerSeen: async () => {},
  questionNames: async () => new Map(),
  questionsAskedBy: async () => [],
  questionView: async (q: unknown) => q
}))
vi.mock('../../../services/mcp-calls.js', () => ({ mcpConnOf: () => null }))
vi.mock('../../../services/tasks.js', () => ({ taskColumns: async () => ({}) }))

import { clearCountsCache, myWorkRoutes } from '../../../routes/my-work.js'

async function app() {
  const a = Fastify()
  await a.register(myWorkRoutes)
  return a
}
const get = (a: Awaited<ReturnType<typeof app>>, user?: string) =>
  a.inject({ method: 'GET', url: '/my-work/counts', headers: user ? { 'x-user': user } : {} })

beforeEach(() => {
  clearCountsCache()
  h.ownedCalls.length = 0
  h.tenant = ''
  h.fail = false
  vi.useRealTimers()
})

describe('GET /my-work/counts', () => {
  it('needs a signed-in person', async () => {
    expect((await get(await app())).statusCode).toBe(401)
  })

  it('answers owned, approvals and questions (the numbers the tab adds up)', async () => {
    const r = await get(await app(), 'u1')
    expect(r.json()).toEqual({ data: { owned: 3, approvals: 2, questions: 1 } })
  })

  it('shares one read per person and tenant, never across them', async () => {
    const a = await app()
    await get(a, 'u1')
    await get(a, 'u1')
    expect(h.ownedCalls).toEqual(['u1'])
    expect((await get(a, 'u2')).json().data.owned).toBe(1)
    h.tenant = 't2'
    await get(a, 'u1')
    expect(h.ownedCalls).toEqual(['u1', 'u2', 'u1'])
  })

  it('does not answer a change made after the short window with the old numbers', async () => {
    vi.useFakeTimers()
    const a = await app()
    await get(a, 'u1')
    h.owned.u1 = 4
    vi.advanceTimersByTime(2_100)
    expect((await get(a, 'u1')).json().data.owned).toBe(4)
    h.owned.u1 = 3
  })
})
