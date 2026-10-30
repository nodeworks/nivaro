import { afterEach, describe, expect, it, vi } from 'vitest'

// The boot warm-up opens connections two at a time (never a login storm), caps at the pool's
// max, honours DB_POOL_WARM=0 and never throws when the database refuses.

const m = vi.hoisted(() => ({ acquired: 0, released: 0, inFlight: 0, peak: 0, fail: false }))
vi.mock('../../../db/index.js', () => ({
  resolveDb: () => ({
    client: {
      acquireConnection: async () => {
        m.inFlight++
        m.peak = Math.max(m.peak, m.inFlight)
        await new Promise((r) => setTimeout(r, 5))
        m.inFlight--
        if (m.fail) throw new Error('Failed to connect')
        m.acquired++
        return {}
      },
      releaseConnection: async () => {
        m.released++
      }
    }
  })
}))

const { warmDbPool } = await import('../../../services/pool-warm.js')

afterEach(() => {
  Object.assign(m, { acquired: 0, released: 0, inFlight: 0, peak: 0, fail: false })
  delete process.env.DB_POOL_WARM
})

describe('warmDbPool', () => {
  it('opens 6 by default, two at a time, and gives them back', async () => {
    expect(await warmDbPool({ max: 40 })).toBe(6)
    expect(m.peak).toBeLessThanOrEqual(2)
    expect(m.released).toBe(6)
  })

  it('caps at the pool max and honours DB_POOL_WARM', async () => {
    process.env.DB_POOL_WARM = '10'
    expect(await warmDbPool({ max: 3 })).toBe(3)
    process.env.DB_POOL_WARM = '0'
    expect(await warmDbPool({ max: 40 })).toBe(0)
  })

  it('never throws when the database refuses', async () => {
    m.fail = true
    expect(await warmDbPool({ max: 40 })).toBe(0)
  })
})
