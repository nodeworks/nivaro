import { describe, expect, it } from 'vitest'
import {
  backoffMs,
  bootDepsBudgetMs,
  waitForDependencies
} from '../../../services/boot-dependencies.js'

function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    }
  }
}

describe('boot dependencies', () => {
  it('backs off 1, 2, 4, 8 s then caps at 15 s', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000])
  })

  it('returns at once when everything answers', async () => {
    const c = clock()
    const logs: string[] = []
    const left = await waitForDependencies([{ name: 'database', check: async () => {} }], {
      budgetMs: 60_000,
      log: (m) => logs.push(m),
      ...c
    })
    expect(left).toEqual([])
    expect(c.now()).toBe(0)
    expect(logs).toEqual([])
  })

  it('waits for a dependency that comes back, re-probing only what failed', async () => {
    const c = clock()
    let dbCalls = 0
    let redisCalls = 0
    const left = await waitForDependencies(
      [
        {
          name: 'database',
          check: async () => {
            dbCalls++
            if (c.now() < 5_000) throw new Error('ECONNREFUSED')
          }
        },
        {
          name: 'redis',
          check: async () => {
            redisCalls++
          }
        }
      ],
      { budgetMs: 60_000, log: () => {}, ...c }
    )
    expect(left).toEqual([])
    expect(redisCalls).toBe(1)
    expect(dbCalls).toBe(4) // 0 s, 1 s, 3 s, 7 s
  })

  it('gives up with the names still failing once the budget is spent', async () => {
    const c = clock()
    const logs: string[] = []
    const left = await waitForDependencies(
      [
        {
          name: 'redis',
          check: async () => {
            throw new Error('down')
          }
        }
      ],
      { budgetMs: 10_000, log: (m) => logs.push(m), ...c }
    )
    expect(left).toEqual(['redis'])
    expect(c.now()).toBeLessThanOrEqual(10_000)
    expect(logs.at(-1)).toContain('redis still unreachable')
  })

  it('reads the budget from BOOT_DEPS_WAIT_MS', () => {
    expect(bootDepsBudgetMs({})).toBe(120_000)
    expect(bootDepsBudgetMs({ BOOT_DEPS_WAIT_MS: '0' })).toBe(0)
    expect(bootDepsBudgetMs({ BOOT_DEPS_WAIT_MS: '300000' })).toBe(300_000)
    expect(bootDepsBudgetMs({ BOOT_DEPS_WAIT_MS: 'soon' })).toBe(120_000)
  })
})
