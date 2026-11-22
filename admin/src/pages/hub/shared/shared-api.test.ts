import { describe, expect, it } from 'vitest'
import { extensionDrift, holdsLatest, reapplyWords, SHARED_COPY } from './shared-api'

describe('shared deployment helpers', () => {
  it('says whether a replica holds the latest list, or that it cannot tell', () => {
    const s = { instance: 'w', version: null, etag: '"a"', at: '' }
    expect(holdsLatest(s, '"a"')).toBe(true)
    expect(holdsLatest(s, '"b"')).toBe(false)
    expect(holdsLatest(s, null)).toBeNull()
  })

  it('names loaded extensions that differ from the allow-list, both ways', () => {
    expect(extensionDrift(['a', 'b'], ['b', 'c'])).toEqual({ missing: ['a'], extra: ['c'] })
  })

  it('words the re-apply after a Redis change: applied, busy (next upgrade), last run failed', () => {
    expect(reapplyWords('started', null).tone).toBe('ok')
    expect(reapplyWords('failed', 'BUSY').text).toMatch(/next upgrade/)
    expect(reapplyWords('failed', 'LAST_RUN_FAILED').text).toMatch(/last upgrade failed/)
    expect(reapplyWords('unavailable', null).text).toMatch(/next upgrade/)
  })

  it('has plain words for the shared refusals', () => {
    for (const code of ['BAD_SECRETS', 'SHARED_OPERATOR_ONLY', 'SHARED_IN_USE', 'TOKEN_CHANGED'])
      expect(SHARED_COPY[code]?.title, code).toBeTruthy()
  })
})
