import { describe, expect, it } from 'vitest'
import { readAllPages, wantsManyPages } from './graphql-list-pages.js'

// A table of `n` rows read 10 at a time; records each call.
function table(n: number) {
  const calls: Array<{ limit: number; offset: number; first: boolean }> = []
  const read = async (limit: number, offset: number, first: boolean) => {
    calls.push({ limit, offset, first })
    const data = Array.from(
      { length: Math.max(0, Math.min(limit, n - offset)) },
      (_, i) => offset + i
    )
    return { data, total: first ? n : null, limit, offset, limit_capped: true, applied_limit: 10 }
  }
  return { read, calls }
}

describe('wantsManyPages', () => {
  it('pages for -1 and for limits above one read, never with a keyset cursor', () => {
    expect(wantsManyPages(-1, 10, undefined)).toBe(true)
    expect(wantsManyPages(25, 10, undefined)).toBe(true)
    expect(wantsManyPages(10, 10, undefined)).toBe(false)
    expect(wantsManyPages(undefined, 10, undefined)).toBe(false)
    expect(wantsManyPages(-1, 10, 'start')).toBe(false)
  })
})

describe('readAllPages', () => {
  it('limit -1 returns every row (1,206 vendors past a 1,000 cut)', async () => {
    const t = table(26)
    const r = await readAllPages(t.read, -1, 0, 10)
    expect(r.data).toHaveLength(26)
    expect(r.data.at(-1)).toBe(25)
    expect(r.total).toBe(26)
    expect(r.limit).toBe(-1)
    expect(r.limit_capped).toBeUndefined()
    // count only on the first read
    expect(t.calls.map((c) => c.first)).toEqual([true, false, false])
  })

  it('an explicit limit returns exactly that many', async () => {
    const t = table(100)
    const r = await readAllPages(t.read, 25, 0, 10)
    expect(r.data).toHaveLength(25)
    expect(t.calls.map((c) => [c.limit, c.offset])).toEqual([
      [10, 0],
      [10, 10],
      [5, 20]
    ])
  })

  it('starts at the given offset and stops at the end of the table', async () => {
    const t = table(23)
    const r = await readAllPages(t.read, 50, 5, 10)
    expect(r.data).toEqual(Array.from({ length: 18 }, (_, i) => 5 + i))
    expect(r.offset).toBe(5)
  })

  it('a table that ends exactly on a page boundary asks once more, then stops', async () => {
    const t = table(20)
    const r = await readAllPages(t.read, -1, 0, 10)
    expect(r.data).toHaveLength(20)
    expect(t.calls).toHaveLength(3)
  })
})
