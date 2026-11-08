import { describe, expect, it, vi } from 'vitest'

let release: (rows: unknown[]) => void = () => {}
vi.mock('../../../db/index.js', () => {
  const raw = vi.fn(
    () =>
      new Promise((res) => {
        release = res as (rows: unknown[]) => void
      })
  )
  return { db: Object.assign(vi.fn(), { raw }) }
})

const { getStateDurationStats } = await import('../../../services/predictive-sla.js')

describe('getStateDurationStats on a cold process', () => {
  it('wait:false answers an empty map at once while the load runs behind it', async () => {
    const t0 = Date.now()
    const quick = await getStateDurationStats({ wait: false })
    expect(quick.size).toBe(0)
    expect(Date.now() - t0).toBeLessThan(200)
    // the default still waits for the load
    const waiting = getStateDurationStats()
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    release([])
    await waiting
    expect(settled).toBe(true)
  })
})
