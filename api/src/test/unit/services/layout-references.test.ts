import { beforeEach, describe, expect, it, vi } from 'vitest'

// Every builder method chains and the builder resolves to no rows; the test
// only counts how often the references are read from the database.
const calls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNotNull', 'orWhere', 'select', 'join', 'groupBy'])
      q[m] = () => q
    q.count = () => q
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    q.then = (ok: (r: unknown[]) => unknown) =>
      Promise.resolve(
        table === 'nivaro_collection_layouts' ? [{ id: 1, name: 'Default', slug: 'default' }] : []
      ).then(ok)
    return q
  }
  return {
    db: vi.fn((table: string) => {
      calls.n++
      return chain(table)
    })
  }
})

import {
  bustLayoutReferences,
  findLayoutReferences,
  layoutReferencesMemoSize
} from '../../../services/layout-references.js'

beforeEach(() => {
  bustLayoutReferences()
  calls.n = 0
})

describe('findLayoutReferences memo', () => {
  it('a second call within the TTL does not re-query', async () => {
    await findLayoutReferences('things')
    const first = calls.n
    expect(first).toBeGreaterThan(0)
    await findLayoutReferences('things')
    expect(calls.n).toBe(first)
  })

  it('a layout write (bustLayoutReferences) makes the next call re-read', async () => {
    await findLayoutReferences('things')
    const first = calls.n
    bustLayoutReferences()
    await findLayoutReferences('things')
    expect(calls.n).toBe(first * 2)
  })

  it('expires after 30 s', async () => {
    vi.useFakeTimers()
    try {
      await findLayoutReferences('things')
      const first = calls.n
      vi.advanceTimersByTime(30_001)
      await findLayoutReferences('things')
      expect(calls.n).toBe(first * 2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops expired entries on read, so the memo does not grow per collection forever', async () => {
    vi.useFakeTimers()
    try {
      await findLayoutReferences('a')
      await findLayoutReferences('b')
      expect(layoutReferencesMemoSize()).toBe(2)
      vi.advanceTimersByTime(30_001)
      await findLayoutReferences('c')
      expect(layoutReferencesMemoSize()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is per collection', async () => {
    await findLayoutReferences('things')
    const first = calls.n
    await findLayoutReferences('others')
    expect(calls.n).toBe(first * 2)
  })
})
