import { describe, expect, it } from 'vitest'
import { collapseRepeats } from './EventsView'
import type { IntegrationEvent } from './types'

const ev = (id: number, over: Partial<IntegrationEvent> = {}): IntegrationEvent => ({
  id,
  source: 'efp-ops:mdsi',
  label: 'MDSi',
  text: 'Backorder · SO SO000561123',
  created_at: '2026-10-24T21:40:12.104Z',
  collection: 'inventory_request',
  item_id: '25633',
  status: 'info',
  ...over
})

describe('collapseRepeats', () => {
  it('folds identical rows in the same second into one with a count', () => {
    const out = collapseRepeats([ev(1), ev(2, { created_at: '2026-10-24T21:40:12.900Z' }), ev(3)])
    expect(out).toHaveLength(1)
    expect(out[0].event.id).toBe(1)
    expect(out[0].repeats).toBe(3)
  })

  it('keeps rows apart that differ in words, record, status or second', () => {
    const out = collapseRepeats([
      ev(1),
      ev(2, { text: 'Invoiced · SO SO000560885' }),
      ev(3, { text: 'Invoiced · SO SO000560885', item_id: '1' }),
      ev(4, { text: 'Invoiced · SO SO000560885', item_id: '1', status: 'error' }),
      ev(5, {
        text: 'Invoiced · SO SO000560885',
        item_id: '1',
        status: 'error',
        created_at: '2026-10-24T21:40:13.000Z'
      })
    ])
    expect(out.map((r) => r.repeats)).toEqual([1, 1, 1, 1, 1])
  })

  it('only folds neighbours, and never a replayable row', () => {
    expect(collapseRepeats([ev(1), ev(2, { text: 'other' }), ev(3)]).map((r) => r.repeats)).toEqual(
      [1, 1, 1]
    )
    expect(
      collapseRepeats([ev(1, { replayable: true }), ev(2, { replayable: true })])
    ).toHaveLength(2)
  })
})
