import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// open_when on the transition PATCH route (review round 2, item 9): turning
// "Only the step's owner" off clears open_when in the same write, a step the
// pipeline does not have is refused naming it, and a key is stored exact.

const writes = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const stored = vi.hoisted(() => ({
  tx: {
    id: 'tx-1',
    template: 'tpl',
    from_state: null,
    to_state: 's0',
    label: 'Send Back',
    require_owner: 1,
    open_when: '{"workflows":[{"field":"$state","op":"neq","value":"waiting_on_po"}]}'
  } as Record<string, unknown>
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const set = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'admin', role: 'R' }
    req.isAdmin = true
  }
  return { authenticate: vi.fn(set), requireAuth: vi.fn(set), requireAdmin: vi.fn(set) }
})
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: vi.fn(async () => {}) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/workflow-template-versions.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  snapshotTemplateVersion: vi.fn(async () => {})
}))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((t: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy']) c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => (t === 'nivaro_workflow_transitions' ? stored.tx : undefined))
    c.select = vi.fn(async () =>
      t === 'nivaro_workflow_states'
        ? [{ key: 'draft' }, { key: 'waiting_on_po' }, { key: 'completed' }]
        : []
    )
    c.update = vi.fn(async (row: Record<string, unknown>) => {
      writes.push(row)
      return 1
    })
    return c
  })
  return { db }
})

import { pipelinesRoutes } from '../../../routes/pipelines.js'

async function patch(body: Record<string, unknown>) {
  const app = Fastify({ logger: false })
  await app.register(pipelinesRoutes, { prefix: '/pipelines' })
  return app.inject({
    method: 'PATCH',
    url: '/pipelines/transitions/AAAAAAAA-0000-4000-8000-000000000001',
    payload: body
  })
}

beforeEach(() => {
  writes.length = 0
})

describe('PATCH /pipelines/transitions/:txId — open_when', () => {
  it('turning owner-only off clears open_when in the same write', async () => {
    const res = await patch({ require_owner: false })
    expect(res.statusCode).toBe(200)
    expect(writes[0]).toMatchObject({ require_owner: 0, open_when: null })
  })

  it('a step the pipeline does not have is refused, naming it', async () => {
    const res = await patch({
      open_when: { workflows: [{ field: '$state', op: 'neq', value: 'waiting_on_fusion' }] }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe(
      'open_when names a step that is not on this pipeline: waiting_on_fusion'
    )
    expect(writes).toHaveLength(0)
  })

  it('a key typed in another case is stored as the exact key', async () => {
    const res = await patch({
      open_when: { workflows: [{ field: '$state', op: 'neq', value: 'Waiting_On_PO' }] }
    })
    expect(res.statusCode).toBe(200)
    expect(writes[0]?.open_when).toBe(
      '{"workflows":[{"field":"$state","op":"neq","value":"waiting_on_po"}]}'
    )
  })

  it('leaves open_when alone when neither switch nor rules are sent', async () => {
    await patch({ label: 'Send Back' })
    expect(writes[0] && 'open_when' in writes[0]).toBe(false)
  })
})
