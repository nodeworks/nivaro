import { beforeEach, describe, expect, it, vi } from 'vitest'

// The bulk action 'transition' path copies the transition gate chain; it
// skipped a move's "note required" (army 2026-10-25). Delegation coverage
// warnings printed raw owner-group keys ("legacy:owners:4635").

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) => ({ id })),
  updateOne: vi.fn(async () => ({}))
}))
vi.mock('../../../services/live-progress.js', () => ({
  openBulkRowProgress: vi.fn(() => ({
    next: () => {},
    end: () => {},
    done: () => {},
    close: () => {}
  }))
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const row =
      t === 'nivaro_workflow_bindings'
        ? { template: 'tpl' }
        : t === 'nivaro_workflow_instances'
          ? { id: 'inst-1', collection: 'workflows', item: '1', current_state: 'S1' }
          : undefined
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy']) c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => row)
    c.select = vi.fn(async () =>
      t === 'nivaro_workflow_transitions'
        ? [
            {
              id: 'T-SB',
              label: 'Send Back',
              from_state: 'S1',
              to_state: 'S0',
              required_roles: null,
              comment_mode: 'required'
            }
          ]
        : []
    )
    return c
  })
}))

import { runDefinition } from '../../../services/bulk-actions.js'
import { coverageGroupPhrase, readableGroupName } from '../../../services/delegate-coverage.js'

const def = {
  kind: 'transition',
  collection: 'workflows',
  config: { transition_label: 'Send Back' },
  guard: []
} as never
const req = { user: { id: 'u-1', role: 'R' }, isAdmin: false } as never

beforeEach(() => vi.clearAllMocks())

describe('bulk transition — required note', () => {
  it('fails each record when no reason is given', async () => {
    const r = await runDefinition(def, ['1'], null, req, { dryRun: true })
    expect(r.failed).toBe(1)
    expect(r.outcomes[0]).toMatchObject({
      outcome: 'fail',
      reason: 'A note is required for this move'
    })
  })

  it('goes through with a reason', async () => {
    const r = await runDefinition(def, ['1'], 'Quote missing', req, { dryRun: true })
    expect(r.succeeded).toBe(1)
    expect(r.outcomes[0].outcome).toBe('change')
  })
})

describe('coverage warning group names', () => {
  it('never prints a machine key', () => {
    expect(readableGroupName('legacy:owners:4635')).toBeNull()
    expect(
      coverageGroupPhrase('legacy:owners:4635', 'Waiting on Level 1 Approval', 'Workflows')
    ).toBe('Your owner group for Waiting on Level 1 Approval in Workflows')
  })
  it('keeps a name a person gave the group', () => {
    expect(coverageGroupPhrase('Zone 3 Approvers', 'Level 1')).toBe('"Zone 3 Approvers" (Level 1)')
  })
})
