import { describe, expect, it } from 'vitest'
import type { DocsIndexSection } from './docs-search.js'
import { defaultExtraDeps, endUserSections } from './search-extra.js'

// Decision R13 (army 5 b16-N5): search outside administration offered developer docs
// (API references, setup pages) because `all` sections reached every caller.

const section = (id: string, audience: string): DocsIndexSection =>
  ({
    id,
    label: id,
    group: 'g',
    group_label: 'G',
    audience,
    blocks: [{ h: null, t: 'tasks are assigned to people' }]
  }) as DocsIndexSection

describe('docs in search (R13)', () => {
  it('a non-administrator finds only sections marked for end users', () => {
    const index = [section('a', 'admin'), section('b', 'all'), section('c', 'user')]
    expect(endUserSections(index).map((s) => s.id)).toEqual(['c'])
    // memoised per index (the ranker caches its preparation by array identity)
    expect(endUserSections(index)).toBe(endUserSections(index))
  })

  it('with the shipped index: an admin finds docs, a non-admin finds none', async () => {
    const admin = await defaultExtraDeps.docs('tasks', true, 5)
    expect(admin.length).toBeGreaterThan(0)
    const someone = await defaultExtraDeps.docs('tasks', false, 5)
    expect(someone).toEqual([])
  })
})
