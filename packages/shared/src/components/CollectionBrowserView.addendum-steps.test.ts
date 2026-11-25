import { describe, expect, it } from 'vitest'

import { takeStatePicks, widenStatePicksToAddenda } from './CollectionBrowserView'

// "Being amended" + a state pick asks the addendum's step (Lindsey Pham, prod 2026-11-25).
describe('takeStatePicks', () => {
  it('takes the $state include picks out and answers their keys', () => {
    const conds: Array<{ path?: unknown; op?: unknown; value?: unknown }> = [
      { path: ['funding_years'], op: '_in', value: [2026] },
      { path: ['$state'], op: '_in', value: ['waiting_on_manager_approval'] },
      { path: ['$state'], op: '_eq', value: 'started' }
    ]
    expect(takeStatePicks(conds)?.sort()).toEqual(['started', 'waiting_on_manager_approval'])
    expect(conds).toEqual([{ path: ['funding_years'], op: '_in', value: [2026] }])
  })

  it('leaves excludes and nested paths alone; null when there was no pick', () => {
    const conds = [
      { path: ['$state'], op: '_nin', value: ['canceled'] },
      { path: ['project', '$state'], op: '_in', value: ['x'] }
    ]
    expect(takeStatePicks(conds)).toBeNull()
    expect(conds).toHaveLength(2)
  })
})

describe('widenStatePicksToAddenda', () => {
  it('a step pick also matches an open addendum in that step (Rob 2026-11-25)', () => {
    const conds: Array<{ path?: unknown; op?: unknown; value?: unknown; or?: unknown }> = [
      { path: ['$state'], op: '_in', value: ['waiting_on_manager_approval'] },
      { path: ['$state'], op: '_nin', value: ['canceled'] }
    ]
    widenStatePicksToAddenda(conds)
    expect(conds[0]).toEqual({
      or: [
        { path: ['$state'], op: '_in', value: ['waiting_on_manager_approval'] },
        {
          path: ['$addendums'],
          op: '_eq',
          value: { status: 'active', state: ['waiting_on_manager_approval'] }
        }
      ]
    })
    expect(conds[1]).toEqual({ path: ['$state'], op: '_nin', value: ['canceled'] })
  })
})
