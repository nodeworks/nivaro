import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// What Ask AI plans keep to undo their writes (migration 537) follows the data rules
// around it: never longer than the collection keeps its trash, scrubbed when a person is
// redacted, and never served by the generic items API.

const state = vi.hoisted(() => ({
  ran: [] as FakeQuery[],
  overrides: [] as Array<Record<string, unknown>>,
  /** ids the next prune select answers, per call (then nothing). */
  pages: [] as Array<Array<{ id: number }>>
}))

vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      state.ran.push(q)
      if (q.sql.includes('[nivaro_collections]')) return state.overrides
      if (q.method === 'select' && q.sql.includes('[nivaro_ai_undo_records]'))
        return state.pages.shift() ?? []
      if (q.method === 'del' || q.method === 'update') return 1
      return []
    })
  }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))

const store = await import('../../../services/ai-undo-store.js')
const DAY = 86_400_000
const NOW = new Date('2026-11-18T12:00:00Z').getTime()

beforeEach(() => {
  state.ran.length = 0
  state.overrides = []
  state.pages = []
})

describe('prune', () => {
  it('drops rows past 30 days, and sooner where the collection keeps its trash for less', async () => {
    state.overrides = [{ collection: 'units', trash_retention_days: 7 }]
    state.pages = [[{ id: 1 }], [{ id: 2 }]]
    const removed = await store.pruneUndoRecords(NOW)
    expect(removed).toBe(2)
    const selects = state.ran.filter(
      (q) => q.method === 'select' && q.sql.includes('[nivaro_ai_undo_records]')
    )
    // 30-day pass, then the 7-day pass for units only.
    expect(selects[0].bindings).toContainEqual(new Date(NOW - 30 * DAY))
    expect(selects[1].sql).toMatch(/\[collection\] = @p\d+/)
    expect(selects[1].bindings).toEqual(expect.arrayContaining(['units', new Date(NOW - 7 * DAY)]))
    // Only collections whose window is shorter than 30 days are asked for.
    const asked = state.ran.find((q) => q.sql.includes('[nivaro_collections]'))!
    expect(asked.sql).toMatch(/\[trash_retention_days\] < @p0/)
    expect(asked.bindings).toContain(30)
  })
})

describe('redaction', () => {
  it('clears the values of every row that names the person and marks it redacted', async () => {
    await store.scrubUndoForPeople([
      { id: 'A1B2C3', values: ['pat_x@corp.example', 'Pat [X]', null, 'ab'] }
    ])
    const ups = state.ran.filter((q) => q.method === 'update')
    // Three terms (id, email, name; "ab" is too short to match safely) × two updates.
    expect(ups).toHaveLength(6)
    expect(ups[0].sql).toMatch(/\[before\] like @p\d+ or \[after\] like @p\d+/i)
    expect(ups[0].bindings).toEqual(expect.arrayContaining(['redacted', '%A1B2C3%']))
    // LIKE wildcards in a value match themselves.
    expect(ups.flatMap((q) => q.bindings)).toEqual(
      expect.arrayContaining(['%pat[_]x@corp.example%', '%Pat [[]X]%'])
    )
    // Values are cleared on undone rows too, without changing their status.
    expect(ups[1].sql).not.toMatch(/undo_status/)
    expect(ups[1].sql).toMatch(/\[before\] = @p\d+, \[after\] = @p\d+/)
  })
})

describe('the items API', () => {
  it('never serves the undo table, administrators included', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../../services/items.ts', import.meta.url), 'utf8')
    )
    const block = src.slice(
      src.indexOf('const ROUTE_ONLY_COLLECTIONS'),
      src.indexOf('export class RouteOnlyCollectionError')
    )
    expect(block).toContain("['nivaro_ai_undo_records', '/api/ai/plans/:id/undo']")
    // …and the route-only check runs before the administrator shortcut.
    const gate = src.slice(src.indexOf('async function assertServable'))
    expect(gate.indexOf('assertNotRouteOnly(collection)')).toBeLessThan(
      gate.indexOf('isAdminRole(user)')
    )
  })
})
