import { vi } from 'vitest'

// config.ts refuses to load without DB_* and a SESSION_SECRET that passes auth/secret-policy.ts.
// Tests never reach a database, so placeholders do — set only when absent, so `npx vitest run`
// works in a fresh worktree (no .env) and a real environment keeps its own values.
const TEST_ENV: Record<string, string> = {
  DB_HOST: 'localhost',
  DB_DATABASE: 'nivaro_test',
  DB_USER: 'nivaro_test',
  DB_PASSWORD: 'not-a-real-password',
  SESSION_SECRET: 'vitest-only-9f3c1a7e5b2d8046-session-key-x'
}
for (const [k, v] of Object.entries(TEST_ENV)) if (!process.env[k]) process.env[k] = v

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
      count: vi.fn().mockResolvedValue([{ total: 0 }])
    }
    // Chainable methods return the same chain object
    for (const m of [
      'where',
      'orWhere',
      'andWhere',
      'whereIn',
      'whereNotIn',
      'whereNull',
      'whereNotNull',
      'whereLike',
      'whereRaw',
      'orderBy',
      'orderByRaw',
      'limit',
      'offset',
      'returning',
      'join',
      'leftJoin',
      'rightJoin',
      'groupBy',
      'having',
      'distinct',
      'modify',
      'onConflict',
      'ignore',
      'merge'
    ]) {
      chain[m] = vi.fn().mockReturnValue(chain)
    }
    return chain
  }

  const db = vi.fn().mockImplementation(() => makeChain())
  // db.raw used by health route and permissions row filter
  ;(db as unknown as Record<string, unknown>).raw = vi.fn().mockResolvedValue([])

  // #1321 — no separate background pool under test; resolveDb() is the mock db.
  // _staticDb is the same mock: pool readers name the main pool explicitly now.
  return { db, _staticDb: db, _backgroundDb: null, resolveDb: () => db }
})
