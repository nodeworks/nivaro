import { vi } from 'vitest'

// db must be a vi.fn() so tests can override it with mockReturnValue / mockImplementation.
// The factory runs at hoist time — everything is defined inline.
vi.mock('../db/index.js', () => {
  function makeChain() {
    const chain: Record<string, unknown> = {
      select: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockResolvedValue([1]),
      update: vi.fn().mockResolvedValue(1),
      delete: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
      first: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue([{ total: 0 }]),
    }
    // Chainable methods return the same chain object
    for (const m of [
      'where', 'orWhere', 'andWhere', 'whereIn', 'whereNotIn',
      'whereNull', 'whereNotNull', 'whereLike', 'whereRaw',
      'orderBy', 'orderByRaw', 'limit', 'offset',
      'returning', 'join', 'leftJoin', 'rightJoin',
      'groupBy', 'having', 'distinct', 'modify',
      'onConflict', 'ignore', 'merge',
    ]) {
      chain[m] = vi.fn().mockReturnValue(chain)
    }
    return chain
  }

  const db = vi.fn().mockImplementation(() => makeChain())
  // db.raw used by health route and permissions row filter
  ;(db as unknown as Record<string, unknown>).raw = vi.fn().mockResolvedValue([])

  return { db }
})
