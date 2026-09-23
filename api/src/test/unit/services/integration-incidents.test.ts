import { describe, expect, it } from 'vitest'
import { healthFlips } from '../../../services/integration-incidents.js'

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
      [{ api: 'A', open: 1 }, { api: 'B', open: 0 }],
      [{ api: 'A', open: 0 }, { api: 'B', open: 2 }]
    )
    expect(out).toEqual([
      { api: 'A', direction: 'recovered', from: 1, to: 0 },
      { api: 'B', direction: 'degraded', from: 0, to: 2 }
    ])
  })
})
