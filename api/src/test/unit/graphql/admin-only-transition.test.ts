import { afterEach, describe, expect, it, vi } from 'vitest'

// Post-approval lock: the GraphQL transition mutations run the same admin-only
// gate as the REST transition route — a non-admin cannot run a move the
// collection keeps for administrators while the record rests in an admin-only
// state, and nothing moves before the refusal.

const writes: string[] = []
function builder(table: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['leftJoin', 'join', 'orderBy', 'limit', 'select', 'where', 'whereIn'])
    b[m] = () => b
  b.first = async () =>
    table === 'nivaro_workflow_transitions'
      ? { id: 'T-CANCEL', from_state: null, to_state: 'S-X', required_roles: null }
      : undefined
  b.update = async () => {
    writes.push(`update:${table}`)
    return 1
  }
  b.insert = async () => {
    writes.push(`insert:${table}`)
    return [1]
  }
  return b
}

vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => builder(t)) }))
vi.mock('../../../services/instance-guard.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/instance-guard.js')>()),
  assertInstanceAccess: vi.fn(async () => {})
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => ({
    id: 'I1',
    template: 'T',
    current_state: 'S-APPROVED',
    completed_at: null
  }))
}))
vi.mock('../../../services/edit-lock.js', () => ({
  adminOnlyTransitionsFor: vi.fn(async () => new Set(['T-CANCEL'])),
  adminOnlyStateOf: vi.fn(async () => ({ key: 'approved', label: 'Approved' }))
}))
vi.mock('../../../services/pipeline-engine.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/pipeline-engine.js')>()),
  // Reaching the target lookup = the gates let the move through.
  resolveTransitionTarget: vi.fn(async () => {
    throw new Error('PAST_GATE')
  })
}))

import { domainMutationFields } from '../../../graphql/resolvers.js'

type Resolve = (src: unknown, args: Record<string, unknown>, ctx: unknown) => Promise<unknown>
const resolve = (name: string) => domainMutationFields[name].resolve as unknown as Resolve
const user = { id: 'U1', role: 'R' }
const args = { collection: 'orders', item: '7', transition_id: 'T-CANCEL' }

afterEach(() => {
  writes.length = 0
})

describe.each([
  'execute_workflow_transition',
  'execute_pipeline_transition'
])('%s — admin-only moves', (name) => {
  it('refuses a non-admin with ADMIN_ONLY_TRANSITION before anything moves', async () => {
    const err = (await resolve(name)(null, args, { user, isAdmin: false }).catch(
      (e) => e
    )) as Error & { extensions?: Record<string, unknown> }
    expect(err.message).toBe(
      'Only administrators can make this move at Approved. Use Request help to ask for a change.'
    )
    expect(err.extensions).toMatchObject({ code: 'ADMIN_ONLY_TRANSITION', status: 403 })
    expect(writes).toEqual([])
  })

  it('lets an administrator through', async () => {
    await expect(resolve(name)(null, args, { user, isAdmin: true })).rejects.toThrow('PAST_GATE')
  })
})
