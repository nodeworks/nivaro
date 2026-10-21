import { describe, expect, it } from 'vitest'
import { entryConfigOf, isBeginner, sanitizeEntryConfig } from './entry-config'

// Same loading as layout-ops.test.ts (a static JSON import trips TS6307).
const FIXTURES = './entry-config.fixtures.json'
const cases = (await import(/* @vite-ignore */ FIXTURES)).default as Array<{
  name: string
  in: unknown
  out: unknown
}>

describe('entry config', () => {
  for (const c of cases)
    it(c.name, () => {
      expect(sanitizeEntryConfig(c.in)).toEqual(c.out)
    })

  it('reads a layout row, empty when unset', () => {
    expect(entryConfigOf(null)).toEqual({})
    expect(entryConfigOf({ entry_config: '{"enter_next":true}' })).toEqual({ enter_next: true })
  })

  it('beginner is under the threshold, three by default', () => {
    expect(isBeginner(2, {})).toBe(true)
    expect(isBeginner(3, {})).toBe(false)
    expect(isBeginner(9, { adaptive_threshold: 10 })).toBe(true)
  })
})
