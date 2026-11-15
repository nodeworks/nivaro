import { describe, expect, it } from 'vitest'
import {
  foldGridEditing,
  freshGridEditors,
  GRID_MARK_TTL_MS,
  type GridEditor,
  gridPageKey,
  gridPresenceCell,
  parseGridPresenceCell
} from './grid-presence'

const ev = (over: Record<string, unknown> = {}) => ({
  collection: 'workflows',
  item: '4471',
  field: '.2',
  page: 'forecast-worksheet',
  state: 'start',
  user: { id: 'beth', name: 'Beth Ray' },
  ...over
})

describe('grid presence (client)', () => {
  it('cell keys round-trip, fields may hold dots and colons', () => {
    expect(parseGridPresenceCell(gridPresenceCell('4471', 'g1:o2'))).toEqual({
      item: '4471',
      field: 'g1:o2'
    })
    expect(parseGridPresenceCell('workflows:4471:amount')).toBeNull()
    expect(parseGridPresenceCell('pg||x')).toBeNull()
  })

  it('page keys are stable, short and in the server alphabet', () => {
    const a = gridPageKey('matrix', 'allocations', '2026')
    expect(a).toBe(gridPageKey('matrix', 'allocations', '2026'))
    expect(a).not.toBe(gridPageKey('matrix', 'allocations', '2027'))
    expect(a).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/)
  })

  it('one mark per person per page; a move replaces it; end clears only that row', () => {
    let book = foldGridEditing(new Map(), ev(), 'me', 1000)
    book = foldGridEditing(book, ev({ item: '4472', field: '.3' }), 'me', 2000)
    expect([...book.values()].map((e) => [e.item, e.field])).toEqual([['4472', '.3']])
    // A late end for the row she left keeps her current mark.
    book = foldGridEditing(book, ev({ state: 'end' }), 'me', 2100)
    expect(book.size).toBe(1)
    book = foldGridEditing(book, ev({ item: '4472', state: 'end' }), 'me', 2200)
    expect(book.size).toBe(0)
  })

  it("never shows the viewer's own other tabs", () => {
    expect(foldGridEditing(new Map(), ev({ user: { id: 'ME' } }), 'me', 1).size).toBe(0)
  })

  it('a mark nobody repeated fades after the TTL', () => {
    const book = foldGridEditing(new Map(), ev(), 'me', 0)
    expect(freshGridEditors(book, GRID_MARK_TTL_MS)).toHaveLength(1)
    expect(freshGridEditors(book, GRID_MARK_TTL_MS + 1)).toHaveLength(0)
  })

  it('people are listed by name, each with a stable colour', () => {
    let book: Map<string, GridEditor> = new Map()
    book = foldGridEditing(book, ev({ user: { id: 'z', name: 'Zoe' } }), null, 1)
    book = foldGridEditing(book, ev({ user: { id: 'a', name: 'Ann' } }), null, 1)
    const list = freshGridEditors(book, 1)
    expect(list.map((e) => e.name)).toEqual(['Ann', 'Zoe'])
    expect(list[0].color).toMatch(/^#/)
  })
})
