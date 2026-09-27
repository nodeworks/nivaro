import { describe, expect, it } from 'vitest'
import { type BootPhase, judgePhases, median } from '../../../services/boot-phases.js'

const phase = (name: string, ms: number, failed = false): BootPhase => ({
  name,
  ms,
  at: 0,
  background: false,
  ...(failed ? { failed } : {})
})

describe('boot phases', () => {
  it('takes the middle of earlier boots as usual', () => {
    expect(median([])).toBeNull()
    expect(median([900, 1100, 1000])).toBe(1000)
    expect(median([1000, 2000])).toBe(1500)
  })

  it('flags a phase that took twice its usual time and a second more', () => {
    const earlier = [
      [phase('Extensions', 900)],
      [phase('Extensions', 1000)],
      [phase('Extensions', 1100)]
    ]
    const [v] = judgePhases([phase('Extensions', 3200)], earlier)
    expect(v.usual_ms).toBe(1000)
    expect(v.slow).toBe(true)
  })

  it('does not flag a short phase that merely doubled', () => {
    const earlier = [[phase('Routes', 100)], [phase('Routes', 120)], [phase('Routes', 110)]]
    expect(judgePhases([phase('Routes', 400)], earlier)[0].slow).toBe(false)
  })

  it('has no opinion before three earlier boots, and ignores failed ones', () => {
    const two = [[phase('Migrations', 500)], [phase('Migrations', 600)]]
    expect(judgePhases([phase('Migrations', 9000)], two)[0]).toMatchObject({
      usual_ms: null,
      slow: false
    })
    const withFailed = [...two, [phase('Migrations', 40, true)]]
    expect(judgePhases([phase('Migrations', 9000)], withFailed)[0].usual_ms).toBeNull()
  })
})
