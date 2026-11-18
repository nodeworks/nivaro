import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pipeline import (review round 3, item G): a transition's open_when is
// stored with `$state` values rewritten to the document's EXACT step keys (as
// a save does); a value naming no step in the document drops open_when (the
// move stays owner-only); none is stored without require_owner.

const inserted = vi.hoisted(() => [] as Array<{ table: string; row: Record<string, unknown> }>)

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
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((table: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy']) c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => undefined)
    c.insert = vi.fn(async (row: Record<string, unknown>) => {
      inserted.push({ table, row })
      return [1]
    })
    return c
  })
  return { db }
})

import { pipelinesRoutes } from '../../../routes/pipelines.js'

const states = [
  { key: 'draft', label: 'Draft', is_initial: true },
  { key: 'waiting_on_po', label: 'Waiting on PO' }
]

async function importDoc(transitions: Array<Record<string, unknown>>) {
  const app = Fastify({ logger: false })
  await app.register(pipelinesRoutes, { prefix: '/pipelines' })
  return app.inject({
    method: 'POST',
    url: '/pipelines/import',
    payload: { type: 'nivaro/pipeline', pipeline: { name: 'Approval', states, transitions } }
  })
}
const imported = () => inserted.filter((i) => i.table === 'nivaro_workflow_transitions')

beforeEach(() => {
  inserted.length = 0
})

describe('POST /pipelines/import — open_when', () => {
  it('rewrites $state values to the document exact keys', async () => {
    const res = await importDoc([
      {
        from_state: null,
        to_state: 'draft',
        label: 'Send Back',
        require_owner: true,
        open_when: {
          workflows: [
            { field: '$state', op: 'neq', value: 'WAITING_ON_PO' },
            { field: '$state', op: 'in', value: ' Draft , waiting_on_po' }
          ]
        }
      }
    ])
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(String(imported()[0].row.open_when))).toEqual({
      workflows: [
        { field: '$state', op: 'neq', value: 'waiting_on_po' },
        { field: '$state', op: 'in', value: 'draft,waiting_on_po' }
      ]
    })
  })

  it('drops open_when naming a step the document does not have, or without require_owner', async () => {
    await importDoc([
      {
        to_state: 'draft',
        label: 'Send Back',
        require_owner: true,
        open_when: [{ field: '$state', op: 'neq', value: 'waiting_on_fusion' }]
      },
      {
        to_state: 'draft',
        label: 'Cancel',
        require_owner: false,
        open_when: [{ field: '$state', op: 'neq', value: 'waiting_on_po' }]
      }
    ])
    expect(imported().map((i) => i.row.open_when)).toEqual([undefined, undefined])
    expect(imported()[0].row.require_owner).toBe(1)
  })
})
