import { describe, expect, it } from 'vitest'
import { coveringFlows, ownerMailFlowCovers } from '../../../services/owner-mail-flows.js'

// Army 4 a14-18: an owner who also subscribes to the state got the owner flow's
// email AND the subscription's. The hook skips its own email only when an owner
// flow would really run for this move.

const workflowsFlow = {
  conditions: [
    { field: 'subject_collection', operator: 'eq', value: 'workflows' },
    { field: 'to_state.key', operator: 'neq', value: 'canceled' }
  ],
  excludesActor: true,
  pingsOwners: true
}
const irFlow = {
  conditions: [{ field: 'collection', operator: 'eq', value: 'inventory_request' }]
}

describe('owner mail flows', () => {
  it('covers a workflow move, not a cancel, not another collection', () => {
    const move = { collection: 'workflows', subjectCollection: 'workflows', toStateKey: 'l1' }
    expect(ownerMailFlowCovers([workflowsFlow, irFlow], move)).toBe(true)
    expect(coveringFlows([workflowsFlow, irFlow], move)).toEqual([workflowsFlow])
    expect(ownerMailFlowCovers([workflowsFlow], { ...move, toStateKey: 'canceled' })).toBe(false)
    expect(
      ownerMailFlowCovers([workflowsFlow], {
        collection: 'projects',
        subjectCollection: 'projects',
        toStateKey: 'l1'
      })
    ).toBe(false)
  })

  it('an addendum move matches on its subject collection', () => {
    expect(
      ownerMailFlowCovers([workflowsFlow], {
        collection: 'nivaro_addendums',
        subjectCollection: 'workflows',
        toStateKey: 'review'
      })
    ).toBe(true)
  })

  it('no flow → nobody is covered', () => {
    expect(
      ownerMailFlowCovers([], { collection: 'x', subjectCollection: 'x', toStateKey: 'y' })
    ).toBe(false)
  })

  it('in / notIn lists', () => {
    const f = { conditions: [{ field: 'collection', operator: 'in', value: 'a, b' }] }
    expect(
      ownerMailFlowCovers([f], { collection: 'b', subjectCollection: 'b', toStateKey: 'k' })
    ).toBe(true)
    const g = { conditions: [{ field: 'to_state.key', operator: 'notIn', value: 'done,canceled' }] }
    expect(
      ownerMailFlowCovers([g], { collection: 'a', subjectCollection: 'a', toStateKey: 'done' })
    ).toBe(false)
  })
})
