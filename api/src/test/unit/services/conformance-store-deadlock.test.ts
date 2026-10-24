import { describe, expect, it, vi } from 'vitest'
import { retryOnDeadlock, sameFindings } from '../../../services/config-conformance.js'

const row = (field: string, message: string | null = 'Required') => ({
  item_id: '42',
  field,
  rule: 'required',
  message
})

describe('record integrity store — no rewrite when nothing changed', () => {
  it('matches the same findings in any order, and an empty set', () => {
    expect(
      sameFindings([row('a'), row('b')], [row('b', 'Required'), row('a', 'Required')] as never)
    ).toBe(true)
    expect(sameFindings([], [])).toBe(true)
  })

  it('differs on a missing, extra or reworded finding, and counts duplicates', () => {
    expect(sameFindings([row('a')], [] as never)).toBe(false)
    expect(sameFindings([], [row('a', 'x')] as never)).toBe(false)
    expect(sameFindings([row('a', 'old')], [row('a', 'new')] as never)).toBe(false)
    expect(sameFindings([row('a'), row('a')], [row('a'), row('b')] as never)).toBe(false)
  })

  it('compares the stored message as it was truncated (1000 chars)', () => {
    const long = 'x'.repeat(1500)
    expect(sameFindings([row('a', long.slice(0, 1000))], [row('a', long)] as never)).toBe(true)
  })
})

describe('retryOnDeadlock', () => {
  it('runs again once when SQL Server picked the statement as a deadlock victim', async () => {
    let n = 0
    const out = await retryOnDeadlock(async () => {
      n++
      if (n === 1)
        throw Object.assign(new Error('Transaction was deadlocked on lock'), { number: 1205 })
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(n).toBe(2)
  })

  it('never retries any other error, and gives up after the one retry', async () => {
    const other = vi.fn(async () => {
      throw new Error('Invalid column name')
    })
    await expect(retryOnDeadlock(other)).rejects.toThrow(/Invalid column/)
    expect(other).toHaveBeenCalledTimes(1)
    const always = vi.fn(async () => {
      throw Object.assign(new Error('was deadlocked on lock'), { number: 1205 })
    })
    await expect(retryOnDeadlock(always)).rejects.toThrow(/deadlocked/)
    expect(always).toHaveBeenCalledTimes(2)
  })
})
