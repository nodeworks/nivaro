import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { deployRegressed } from '../../../services/ops-monitors.js'

const opts = { worsenPct: 50, floorMs: 500 }

describe('deployRegressed', () => {
  it('ignores a big relative slowdown that is still fast (0.3.95, 2026-11-08)', () => {
    const r = deployRegressed({ p95: 64, errorRate: 0.001 }, { p95: 176, errorRate: 0 }, opts)
    expect(r.regressed).toBe(false)
    expect(Math.round(r.p95Delta)).toBe(175)
  })

  it('fails a slowdown that is worse by the percentage and above the floor', () => {
    expect(deployRegressed({ p95: 300 }, { p95: 700, errorRate: 0 }, opts).regressed).toBe(true)
  })

  it('needs the percentage too, not only the floor', () => {
    expect(deployRegressed({ p95: 600 }, { p95: 700, errorRate: 0 }, opts).regressed).toBe(false)
  })

  it('needs at least 100 ms more when the floor is off', () => {
    const noFloor = { worsenPct: 50, floorMs: 0 }
    expect(deployRegressed({ p95: 40 }, { p95: 90, errorRate: 0 }, noFloor).regressed).toBe(false)
    expect(deployRegressed({ p95: 40 }, { p95: 160, errorRate: 0 }, noFloor).regressed).toBe(true)
  })

  it('fails on a 5xx rise of more than 5 points on its own', () => {
    expect(
      deployRegressed({ p95: 60, errorRate: 0.001 }, { p95: 60, errorRate: 0.08 }, opts).regressed
    ).toBe(true)
    expect(
      deployRegressed({ p95: 60, errorRate: 0.001 }, { p95: 60, errorRate: 0.03 }, opts).regressed
    ).toBe(false)
  })
})
