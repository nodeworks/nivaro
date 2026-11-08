import { describe, expect, it } from 'vitest'
import { healthFlips, incidentExampleTail } from '../../../services/integration-incidents.js'

describe('healthFlips', () => {
  it('reports a partner that went from unmet obligations to none', () => {
    expect(healthFlips([{ api: 'A', open: 4 }], [{ api: 'A', open: 0 }])).toEqual([
      { api: 'A', direction: 'recovered', from: 4, to: 0 }
    ])
  })

  it('reports a partner that went from none to some', () => {
    expect(healthFlips([{ api: 'A', open: 0 }], [{ api: 'A', open: 3 }])).toEqual([
      { api: 'A', direction: 'degraded', from: 0, to: 3 }
    ])
  })

  it('says nothing when a partner merely got worse — that is not a flip', () => {
    expect(healthFlips([{ api: 'A', open: 2 }], [{ api: 'A', open: 9 }])).toEqual([])
  })

  it('says nothing when a partner was healthy and stayed healthy', () => {
    expect(healthFlips([{ api: 'A', open: 0 }], [{ api: 'A', open: 0 }])).toEqual([])
  })

  it('treats a partner absent from the earlier sweep as having been healthy', () => {
    expect(healthFlips([], [{ api: 'A', open: 2 }])).toEqual([
      { api: 'A', direction: 'degraded', from: 0, to: 2 }
    ])
  })

  it('treats a partner absent from the later sweep as recovered', () => {
    expect(healthFlips([{ api: 'A', open: 5 }], [])).toEqual([
      { api: 'A', direction: 'recovered', from: 5, to: 0 }
    ])
  })

  it('reports each partner independently', () => {
    const out = healthFlips(
      [
        { api: 'A', open: 1 },
        { api: 'B', open: 0 }
      ],
      [
        { api: 'A', open: 0 },
        { api: 'B', open: 2 }
      ]
    )
    expect(out).toEqual([
      { api: 'A', direction: 'recovered', from: 1, to: 0 },
      { api: 'B', direction: 'degraded', from: 0, to: 2 }
    ])
  })
})

// Army9 b13: the incident note names records the way people know them.
describe('incidentExampleTail', () => {
  it('uses record labels, never collection #id (kind)', () => {
    expect(
      incidentExampleTail([{ collection: 'inventory_request', item: '37826' }], {
        'inventory_request:37826': 'SE26INV-37443'
      })
    ).toBe(' — SE26INV-37443')
  })
  it('leaves out a record with no name (or a bare id) and says nothing when none has one', () => {
    expect(
      incidentExampleTail(
        [
          { collection: 'inventory_request', item: '1' },
          { collection: 'workflows', item: '2' }
        ],
        { 'inventory_request:1': '1', 'workflows:2': 'CR26-81433' }
      )
    ).toBe(' — CR26-81433')
    expect(incidentExampleTail([{ collection: 'x', item: '9' }], {})).toBe('')
  })
})
