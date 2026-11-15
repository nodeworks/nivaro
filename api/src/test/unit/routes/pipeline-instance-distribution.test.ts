import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// Pipeline editor (realtime program 2026-11-14, idea 22): the instance distribution says how
// many live records sit in each step AND since when the longest-waiting one has.

vi.mock('../../../middleware/authenticate.js', () => {
  const set = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u-admin', role: 'role-admin' }
    req.isAdmin = true
  }
  return { authenticate: vi.fn(set), requireAuth: vi.fn(set), requireAdmin: vi.fn(set) }
})
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: vi.fn(async (_who: unknown, fn: () => Promise<unknown>) => fn())
}))

const answers = vi.hoisted(() => ({
  states: [] as unknown[],
  counts: [] as unknown[],
  raw: [] as string[]
}))
vi.mock('../../../db/index.js', () => {
  const builder = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {}
    for (const m of [
      'where',
      'whereNull',
      'whereRaw',
      'groupBy',
      'select',
      'join',
      'leftJoin',
      'max',
      'count',
      'as'
    ])
      c[m] = vi.fn(() => c)
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    c.then = (res: (v: unknown) => unknown) => Promise.resolve(rows()).then(res)
    return c
  }
  const db = vi.fn((t: string) => {
    if (t === 'nivaro_workflow_states') return builder(() => answers.states)
    if (t === 'nivaro_workflow_instances as i') return builder(() => answers.counts)
    return builder(() => [])
  }) as unknown as { raw: (s: string) => string } & ((t: string) => unknown)
  db.raw = (s: string) => {
    answers.raw.push(s)
    return s
  }
  return { db }
})

import { pipelinesRoutes } from '../../../routes/pipelines.js'

const TEMPLATE = '590320D5-6249-463A-A63E-349CDA99D73F'

describe('GET /pipelines/:id/instance-distribution', () => {
  it('carries the count and the oldest entry per state, and flags orphaned states', async () => {
    answers.states = [
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', key: 'review', label: 'In review', color: null }
    ]
    answers.counts = [
      {
        current_state: 'AAAAAAAA-0000-0000-0000-000000000001',
        collection: 'workflows',
        c: 7,
        oldest: new Date('2026-11-02T14:00:00.000Z')
      },
      {
        current_state: 'bbbbbbbb-0000-0000-0000-000000000009',
        collection: 'workflows',
        c: 2,
        oldest: '2026-10-01T00:00:00.000Z'
      },
      { current_state: null, collection: 'workflows', c: 1, oldest: null }
    ]
    const app = Fastify({ logger: false })
    await app.register(pipelinesRoutes, { prefix: '/pipelines' })
    const res = await app.inject({
      method: 'GET',
      url: `/pipelines/${TEMPLATE}/instance-distribution`
    })
    expect(res.statusCode).toBe(200)
    const { data } = JSON.parse(res.body)
    expect(data[0]).toMatchObject({
      key: 'review',
      count: 7,
      oldest_at: '2026-11-02T14:00:00.000Z',
      orphaned: false
    })
    expect(data[1]).toMatchObject({
      count: 2,
      oldest_at: '2026-10-01T00:00:00.000Z',
      orphaned: true
    })
    expect(data[2].oldest_at).toBeNull()
    // the oldest is "newest entry into the state, else when it started"
    expect(answers.raw.join(' ')).toContain('COALESCE(e.at, i.started_at)')
  })
})
