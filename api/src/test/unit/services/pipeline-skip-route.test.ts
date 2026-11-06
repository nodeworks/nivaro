import { describe, expect, it } from 'vitest'
import {
  activeOwnersOnly,
  instancesWithoutActingOwner,
  isInactivePerson,
  nextSkipTransition,
  pickSkipTransition
} from '../../../services/pipeline-engine.js'

// The IR template as staging has it: Finance Review's first route by sort is a
// Send Back to Started (sort 0), its Approve is sort 2.
const SORT = new Map([
  ['STARTED', 0],
  ['ER', 1],
  ['FIN', 2],
  ['WH', 3]
])
const FIN_ROUTES = [
  { id: 'back-start', label: 'Send Back', to_state: 'started', sort: 0 },
  { id: 'approve', label: 'Approve', to_state: 'wh', sort: 2 },
  { id: 'back-er', label: 'Send Back', to_state: 'er', sort: 5 },
  { id: 'auto', label: 'Auto-advance', to_state: 'wh', sort: 20 }
]

describe('pickSkipTransition — a skip never becomes a send back', () => {
  it('a skipped Finance Review goes on to Warehouse Submission, not back to Started', () => {
    expect(pickSkipTransition(FIN_ROUTES, 2, SORT)?.id).toBe('approve')
  })

  it('to_previous routes never carry a skip', () => {
    const routes = [
      { id: 'prev', to_state: 'wh', sort: 0, to_previous: 1 },
      { id: 'fwd', to_state: 'wh', sort: 1 }
    ]
    expect(pickSkipTransition(routes, 2, SORT)?.id).toBe('fwd')
  })

  it('a template whose states are not sorted keeps the old pick (first by sort)', () => {
    const flat = new Map([
      ['A', 0],
      ['B', 0]
    ])
    const routes = [
      { id: 'second', to_state: 'b', sort: 3 },
      { id: 'first', to_state: 'a', sort: 1 }
    ]
    expect(pickSkipTransition(routes, 0, flat)?.id).toBe('first')
    expect(pickSkipTransition(routes, null, flat)?.id).toBe('first')
  })

  it('no routes = nothing', () => {
    expect(pickSkipTransition([], 1, SORT)).toBeUndefined()
  })

  it('reads the routes and the state sorts (nextSkipTransition)', async () => {
    const fakeDb = ((table: string) => {
      if (table === 'nivaro_workflow_transitions')
        return { where: () => ({ whereNot: () => ({ orderBy: async () => FIN_ROUTES }) }) }
      return {
        where: () => ({
          select: async () => [
            { id: 'started', sort: 0 },
            { id: 'er', sort: 1 },
            { id: 'fin', sort: 2 },
            { id: 'wh', sort: 3 }
          ]
        })
      }
    }) as any
    const tx = await nextSkipTransition(fakeDb, 'T', { id: 'fin', sort: 2 })
    expect(tx?.id).toBe('approve')
  })
})

describe('inactive owners', () => {
  it('suspended, archived, redacted and "Redacted Redacted" people cannot act', () => {
    expect(isInactivePerson({ status: 'suspended' })).toBe(true)
    expect(isInactivePerson({ status: 'Archived' })).toBe(true)
    expect(isInactivePerson({ status: 'active', is_redacted: 1 })).toBe(true)
    expect(
      isInactivePerson({ status: 'active', first_name: 'Redacted', last_name: 'redacted' })
    ).toBe(true)
    expect(isInactivePerson({ status: 'active' })).toBe(false)
    expect(isInactivePerson({ status: 'invited' })).toBe(false)
  })

  const usersDb = (rows: Array<Record<string, unknown>>) =>
    ((_table: string) => ({
      whereIn: (_c: string, ids: string[]) => ({
        select: async () => rows.filter((r) => ids.includes(String(r.id)))
      })
    })) as any

  it('activeOwnersOnly drops inactive owners and keeps order', async () => {
    const db = usersDb([
      { id: 'a', status: 'active' },
      { id: 'b', status: 'suspended' },
      { id: 'c', status: 'active', is_redacted: true }
    ])
    const out = await activeOwnersOnly([{ id: 'a' }, { id: 'b' }, { id: 'c' }], db)
    expect(out.map((o) => o.id)).toEqual(['a'])
  })

  it('a failed read keeps the list as it was', async () => {
    const broken = (() => {
      throw new Error('down')
    }) as any
    const owners = [{ id: 'a' }, { id: 'b' }]
    expect(await activeOwnersOnly(owners, broken)).toEqual(owners)
  })
})

describe('owner gaps — who covers a step (army4 a15-1 / a14-4)', () => {
  const insts = [{ item: '1' }, { item: '2' }, { item: '3' }, { item: '4' }]
  it('no assigned owner, or only inactive ones, is a gap; one active owner is cover', () => {
    const owners = new Map([
      // '1': resolved with {skipFallback} → the creator fallback is not there
      ['1', []],
      ['2', [{ id: 'gone' }]],
      ['3', [{ id: 'gone' }, { id: 'live' }]]
      // '4': no entry at all
    ])
    const live = new Set(['LIVE'])
    expect(instancesWithoutActingOwner(insts, owners, live).map((i) => i.item)).toEqual([
      '1',
      '2',
      '4'
    ])
  })
})
