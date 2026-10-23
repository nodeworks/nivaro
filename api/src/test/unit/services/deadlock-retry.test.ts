import { describe, expect, it, vi } from 'vitest'
import { isDeadlockError, withDeadlockRetry } from '../../../services/deadlock-retry.js'

const mssqlDeadlock = () =>
  Object.assign(
    new Error('Transaction was deadlocked and has been chosen as the deadlock victim'),
    {
      number: 1205
    }
  )

describe('deadlock retry', () => {
  it('recognises deadlock victims on every dialect', () => {
    expect(isDeadlockError(mssqlDeadlock())).toBe(true)
    expect(isDeadlockError({ originalError: { info: { number: 1205 } } })).toBe(true)
    expect(isDeadlockError({ code: '40P01' })).toBe(true)
    expect(isDeadlockError({ errno: 1213 })).toBe(true)
    expect(isDeadlockError(new Error('Timeout: Request failed to complete in 15000ms'))).toBe(false)
    expect(isDeadlockError(null)).toBe(false)
  })

  it('runs again once after a deadlock', async () => {
    const fn = vi.fn().mockRejectedValueOnce(mssqlDeadlock()).mockResolvedValueOnce('rows')
    expect(await withDeadlockRetry(fn, { baseDelayMs: 0 })).toBe('rows')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('rethrows other errors at once, and the last deadlock', async () => {
    const other = vi.fn().mockRejectedValue(new Error('syntax'))
    await expect(withDeadlockRetry(other, { baseDelayMs: 0 })).rejects.toThrow('syntax')
    expect(other).toHaveBeenCalledTimes(1)
    const always = vi.fn().mockRejectedValue(mssqlDeadlock())
    await expect(withDeadlockRetry(always, { retries: 1, baseDelayMs: 0 })).rejects.toThrow(
      'deadlock victim'
    )
    expect(always).toHaveBeenCalledTimes(2)
  })
})
