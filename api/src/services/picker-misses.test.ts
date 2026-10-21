import { describe, expect, it } from 'vitest'
import {
  clearPickerMisses,
  type MissRedis,
  mergeDailyMisses,
  normalizeMissTerm,
  recordPickerMisses,
  sessionTerms,
  suggestMissFix,
  topPickerMisses
} from './picker-misses.js'

/** In-memory sorted sets + sets, enough of ioredis for this module. */
function fakeRedis() {
  const z = new Map<string, Map<string, number>>()
  const s = new Map<string, Set<string>>()
  const r: MissRedis & { z: typeof z } = {
    z,
    multi() {
      const ops: Array<() => void> = []
      const m = {
        zincrby(key: string, n: number, member: string) {
          ops.push(() => {
            const set = z.get(key) ?? new Map()
            set.set(member, (set.get(member) ?? 0) + n)
            z.set(key, set)
          })
          return m
        },
        zremrangebyrank: () => m,
        expire: () => m,
        sadd(key: string, member: string) {
          ops.push(() => s.set(key, new Set([...(s.get(key) ?? []), member])))
          return m
        },
        async exec() {
          for (const op of ops) op()
          return []
        }
      }
      return m
    },
    async zrevrange(key: string) {
      const set = z.get(key)
      if (!set) return []
      return [...set.entries()].sort((a, b) => b[1] - a[1]).flatMap(([k, v]) => [k, String(v)])
    },
    async smembers(key: string) {
      return [...(s.get(key) ?? [])]
    },
    async del(...keys: string[]) {
      for (const k of keys) z.delete(k)
      return keys.length
    },
    async srem(key: string, member: string) {
      s.get(key)?.delete(member)
      return 1
    }
  }
  return r
}

describe('terms', () => {
  it('normalizes and drops unusable input', () => {
    expect(normalizeMissTerm('  Acme   Corp ')).toBe('acme corp')
    expect(normalizeMissTerm('a')).toBeNull()
    expect(normalizeMissTerm('x'.repeat(61))).toBeNull()
    expect(normalizeMissTerm(42)).toBeNull()
  })

  it('keeps distinct session terms, dropping ones a longer term starts with', () => {
    expect(sessionTerms(['ac', 'acm', 'acme', 'Zeta', 'zeta'])).toEqual(['acme', 'zeta'])
    expect(sessionTerms('solo')).toEqual(['solo'])
    expect(sessionTerms(['aa', 'bb', 'cc', 'dd'])).toHaveLength(3)
  })
})

describe('storage', () => {
  it('counts misses per placement per day and reads the top over 14 days', async () => {
    const r = fakeRedis()
    const day1 = new Date('2026-10-20T10:00:00Z')
    const day2 = new Date('2026-10-21T10:00:00Z')
    await recordPickerMisses(r, 7, 'vendor', ['acme', 'zeta'], day1)
    await recordPickerMisses(r, 7, 'vendor', ['acme'], day2)
    await recordPickerMisses(r, 7, 'site', ['north'], day2)
    const top = await topPickerMisses(r, 7, null, day2)
    expect(top.map((f) => f.field)).toEqual(['vendor', 'site'])
    expect(top[0]).toEqual({
      field: 'vendor',
      total: 3,
      misses: [
        { term: 'acme', count: 2, last: '2026-10-21' },
        { term: 'zeta', count: 1, last: '2026-10-20' }
      ]
    })
    // Older than the window: gone.
    expect(await topPickerMisses(r, 7, 'vendor', new Date('2026-11-20T10:00:00Z'))).toEqual([])
    await clearPickerMisses(r, 7, 'vendor', day2)
    expect((await topPickerMisses(r, 7, null, day2)).map((f) => f.field)).toEqual(['site'])
  })

  it('merges daily lists newest-first', () => {
    expect(
      mergeDailyMisses([
        { day: '2026-10-21', flat: ['b', '1'] },
        { day: '2026-10-20', flat: ['a', '1', 'b', '2'] }
      ])
    ).toEqual([
      { term: 'b', count: 3, last: '2026-10-21' },
      { term: 'a', count: 1, last: '2026-10-20' }
    ])
  })

  it('is a no-op without Redis', async () => {
    await recordPickerMisses(null, 1, 'f', ['xx'])
    expect(await topPickerMisses(null, 1)).toEqual([])
  })
})

describe('suggestMissFix', () => {
  const base = {
    term: 'acme',
    target: 'Vendors',
    shown: 0,
    withoutFilter: null,
    withoutCuration: 0,
    hasFilter: false,
    filterDependsOnRecord: false,
    quickCreate: false
  }
  it('names the filter when it hides matches', () => {
    expect(
      suggestMissFix({ ...base, hasFilter: true, withoutFilter: 4, withoutCuration: 4 })
    ).toMatchObject({ kind: 'filter' })
  })
  it('names picker curation when only it hides matches', () => {
    const s = suggestMissFix({ ...base, withoutCuration: 2 })
    expect(s.kind).toBe('hidden')
    expect(s.text).toContain('2 records')
  })
  it('suggests adding the option, or Quick create', () => {
    expect(suggestMissFix(base).text).toContain('turn on Quick create')
    expect(suggestMissFix({ ...base, quickCreate: true }).text).toContain('with Quick create')
  })
  it('says when the term finds something now', () => {
    expect(suggestMissFix({ ...base, shown: 1 }).kind).toBe('found_now')
  })
})
