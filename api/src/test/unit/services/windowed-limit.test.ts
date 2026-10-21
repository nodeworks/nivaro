import { beforeEach, describe, expect, it } from 'vitest'
import {
  overWindowLimit,
  resetWindowedMemory,
  takeWindowed
} from '../../../services/windowed-limit.js'

function fakeRedis() {
  const counts = new Map<string, number>()
  const expires: string[] = []
  return {
    expires,
    incrby: async (k: string, n: number) => {
      counts.set(k, (counts.get(k) ?? 0) + n)
      return counts.get(k) as number
    },
    expire: async (k: string) => {
      expires.push(k)
      return 1
    }
  }
}

beforeEach(() => resetWindowedMemory())

describe('takeWindowed', () => {
  it('grants a straddling batch the remainder and nothing after', async () => {
    const r = fakeRedis()
    expect(await takeWindowed(r, 'k', 40, 60, 60)).toBe(40)
    expect(await takeWindowed(r, 'k', 40, 60, 60)).toBe(20)
    expect(await takeWindowed(r, 'k', 5, 60, 60)).toBe(0)
    expect(r.expires).toHaveLength(1)
  })
  it('counts in memory without Redis', async () => {
    expect(await takeWindowed(null, 'm', 8, 10, 60)).toBe(8)
    expect(await takeWindowed(null, 'm', 8, 10, 60)).toBe(2)
    expect(await overWindowLimit(null, 'm', 10, 60)).toBe(true)
    expect(await overWindowLimit(null, 'other', 10, 60)).toBe(false)
  })
})
