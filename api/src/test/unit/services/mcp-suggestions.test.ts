import { describe, expect, it } from 'vitest'
import {
  type CallRow,
  mineSequences,
  prefillFor,
  suggestName,
  topCollections
} from '../../../services/mcp-suggestions.js'

const MIN = 60_000
let clock = Date.UTC(2026, 9, 1)

/** One session: tools called a few seconds apart; the next session starts an hour later. */
function session(conn: string, user: string, tools: string[]): CallRow[] {
  clock += 60 * MIN
  return tools.map((tool, i) => ({
    conn,
    user,
    tool,
    at: clock + i * 5_000,
    chain: `${conn}-${clock}-${i}`
  }))
}

describe('mineSequences', () => {
  it('finds a pattern repeated across sessions and people', () => {
    const rows = [
      ...session('o1', 'U1', ['search', 'read_item', 'update_item']),
      ...session('o1', 'U1', ['search', 'read_item', 'update_item']),
      ...session('k2', 'U2', ['whoami', 'search', 'read_item', 'update_item']),
      ...session('k2', 'U2', ['list_tasks'])
    ]
    const out = mineSequences(rows)
    expect(out[0]).toMatchObject({
      key: 'search>read_item>update_item',
      sessions: 3,
      connections: 2,
      people: 2
    })
    // The 2-step pieces are covered by the 3-step pattern, so they are not offered as well.
    expect(out.map((s) => s.key)).not.toContain('search>read_item')
  })

  it('folds repeats of one tool in a row into one step', () => {
    const rows = [1, 2, 3].flatMap(() =>
      session('o1', 'U1', ['read_items', 'read_item', 'read_item', 'read_item', 'add_comment'])
    )
    expect(mineSequences(rows)[0].key).toBe('read_items>read_item>add_comment')
  })

  it('cuts sessions at a quiet gap', () => {
    clock += 60 * MIN
    const rows: CallRow[] = [
      { conn: 'o1', user: 'U1', tool: 'search', at: clock },
      { conn: 'o1', user: 'U1', tool: 'read_item', at: clock + 20 * MIN }
    ]
    expect(mineSequences(rows, { minSessions: 1 })).toEqual([])
  })

  it('ignores discovery-only runs and rare ones', () => {
    const rows = [
      ...[1, 2, 3].flatMap(() => session('o1', 'U1', ['whoami', 'list_collections'])),
      ...session('o1', 'U1', ['search', 'transition'])
    ]
    expect(mineSequences(rows)).toEqual([])
  })
})

describe('prefill', () => {
  it('names the tool from its first and last step, avoiding taken names', () => {
    expect(suggestName(['search', 'read_item'], new Set())).toBe('search_then_read_item')
    expect(suggestName(['search', 'read_item'], new Set(['search_then_read_item']))).toBe(
      'search_then_read_item_2'
    )
  })
  it('offers a query for reads and a flow for writes', () => {
    const read = new Set(['search', 'read_item'])
    expect(
      prefillFor(
        { tools: ['search', 'read_item'], sessions: 4, collections: ['projects'] },
        read,
        new Set()
      )
    ).toMatchObject({ kind: 'custom_query', read_only: true })
    const w = prefillFor(
      { tools: ['search', 'update_item'], sessions: 4, collections: [] },
      read,
      new Set()
    )
    expect(w).toMatchObject({ kind: 'flow', read_only: false })
    expect(w.description).toContain('search → update_item')
  })
  it('counts collections from item paths, never system tables', () => {
    expect(
      topCollections([
        '/api/items/projects/1',
        '/api/items/projects',
        '/api/items/nivaro_users/2',
        '/api/items/orders?limit=5',
        '/api/my-work'
      ])
    ).toEqual(['projects', 'orders'])
  })
})
