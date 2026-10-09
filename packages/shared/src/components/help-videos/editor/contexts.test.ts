import { describe, expect, it } from 'vitest'
import type { HelpVideoContext } from '../types'
import { addCollection, collectionKeysOf, removeCollection, stepsOf, toggleStep } from './contexts'

// A copy of the server's rankForContext rule (api/src/services/help-videos.ts):
// a step row matches its own step only, a row with no step matches every step.
function shows(rows: HelpVideoContext[], q: { collection: string; state: string | null }) {
  return rows.some(
    (r) =>
      r.kind === 'collection' &&
      r.key === q.collection &&
      (r.state_key ? !!q.state && r.state_key === q.state : true)
  )
}

const page: HelpVideoContext = { kind: 'page', key: 'home', state_key: null }

describe('addCollection', () => {
  it('lists a collection for every step, once', () => {
    const a = addCollection([page], 'orders')
    expect(a).toEqual([page, { kind: 'collection', key: 'orders', state_key: null }])
    expect(addCollection(a, 'orders')).toBe(a)
  })
})

describe('toggleStep', () => {
  const start = addCollection([page], 'orders')

  it('the first chosen step replaces the every-step row', () => {
    const a = toggleStep(start, 'orders', 'draft')
    expect(a).toEqual([page, { kind: 'collection', key: 'orders', state_key: 'draft' }])
    expect(stepsOf(a, 'orders')).toEqual(['draft'])
  })

  it('a step-limited video does not show at other steps', () => {
    const a = toggleStep(start, 'orders', 'draft')
    expect(shows(a, { collection: 'orders', state: 'draft' })).toBe(true)
    expect(shows(a, { collection: 'orders', state: 'approved' })).toBe(false)
    expect(shows(a, { collection: 'orders', state: null })).toBe(false)
    // The unlimited one shows everywhere.
    expect(shows(start, { collection: 'orders', state: 'approved' })).toBe(true)
  })

  it('more steps add rows and never a duplicate', () => {
    const a = toggleStep(toggleStep(start, 'orders', 'draft'), 'orders', 'approved')
    expect(stepsOf(a, 'orders')).toEqual(['draft', 'approved'])
    expect(a.filter((c) => c.key === 'orders')).toHaveLength(2)
  })

  it('removing the last step puts the every-step row back', () => {
    const a = toggleStep(toggleStep(start, 'orders', 'draft'), 'orders', 'draft')
    expect(a).toEqual(start)
    expect(shows(a, { collection: 'orders', state: 'anything' })).toBe(true)
  })

  it('leaves pages and other collections alone and keeps the order', () => {
    const many = addCollection(addCollection([page], 'orders'), 'invoices')
    const a = toggleStep(many, 'orders', 'draft')
    expect(a[0]).toBe(page)
    expect(collectionKeysOf(a)).toEqual(['orders', 'invoices'])
    expect(stepsOf(a, 'invoices')).toEqual([])
  })
})

describe('removeCollection', () => {
  it('removes every row of the collection and nothing else', () => {
    const a = toggleStep(toggleStep(addCollection([page], 'orders'), 'orders', 'a'), 'orders', 'b')
    expect(removeCollection(a, 'orders')).toEqual([page])
  })
})
