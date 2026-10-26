import { describe, expect, it } from 'vitest'
import { peopleSearchOrder } from './people-search-rank.js'

describe('people search ranking', () => {
  it('ranks a full-name prefix first for a two-word search', () => {
    const o = peopleSearchOrder('Sam Pat')
    expect(o?.sql).toBe(
      'CASE WHEN first_name LIKE ? AND last_name LIKE ? THEN 0 WHEN first_name LIKE ? THEN 1 ' +
        'WHEN last_name LIKE ? THEN 2 WHEN email LIKE ? THEN 3 ELSE 4 END, first_name, last_name'
    )
    expect(o?.bindings).toEqual(['Sam%', 'Pat%', 'Sam%', 'Sam%', 'Sam%'])
  })

  it('one word ranks first/last-name prefixes, then email', () => {
    expect(peopleSearchOrder('  sam ')?.bindings).toEqual(['sam%', 'sam%', 'sam%'])
  })

  it('escapes LIKE wildcards and skips a blank search', () => {
    expect(peopleSearchOrder('50%_x')?.bindings[0]).toBe('50[%][_]x%')
    expect(peopleSearchOrder('   ')).toBeNull()
    expect(peopleSearchOrder(undefined)).toBeNull()
  })
})
