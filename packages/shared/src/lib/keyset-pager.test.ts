import { describe, expect, it } from 'vitest'
import {
  createCursorBook,
  isCursorRefusal,
  noteNextCursor,
  pageRequest,
  stopCursors,
  withIdTieBreak
} from './keyset-pager'

describe('keyset pager (#2447)', () => {
  it('page 1 starts a walk; the next page uses the cursor written down', () => {
    const book = createCursorBook()
    expect(pageRequest(book, 'k', 1, 'name')).toEqual({ after: 'start', sort: 'name' })
    noteNextCursor(book, 'k', 1, 'c2')
    expect(pageRequest(book, 'k', 2, 'name')).toEqual({ after: 'c2', sort: 'name' })
  })

  it('a page with no cursor asks by number in the same order (id tie-break)', () => {
    const book = createCursorBook()
    expect(pageRequest(book, 'k', 9, '-date')).toEqual({ page: 9, sort: '-date,id' })
    expect(pageRequest(book, 'k', 9, '')).toEqual({ page: 9, sort: 'id' })
  })

  it('forgets cursors when the list changes; the end of the list clears the next page', () => {
    const book = createCursorBook()
    noteNextCursor(book, 'k', 1, 'c2')
    expect(pageRequest(book, 'other', 2, '').after).toBeUndefined()
    noteNextCursor(book, 'other', 1, 'x')
    noteNextCursor(book, 'other', 1, null)
    expect(pageRequest(book, 'other', 2, '').after).toBeUndefined()
  })

  it('linked/computed sorts and refusals page by number until the key changes', () => {
    const book = createCursorBook()
    expect(pageRequest(book, 'k', 1, 'vendor.name')).toEqual({ page: 1, sort: 'vendor.name' })
    const b2 = createCursorBook()
    stopCursors(b2, 'k')
    expect(pageRequest(b2, 'k', 1, 'name')).toEqual({ page: 1, sort: 'name' })
    expect(pageRequest(b2, 'k2', 1, 'name').after).toBe('start')
  })

  it('recognises cursor refusals and never repeats id in a sort', () => {
    expect(isCursorRefusal({ status: 400, response: { code: 'CURSOR_SORT_UNSUPPORTED' } })).toBe(
      true
    )
    expect(isCursorRefusal({ status: 400, response: { code: 'UNKNOWN_FIELD' } })).toBe(false)
    expect(withIdTieBreak('-id')).toBe('-id')
    expect(withIdTieBreak('name, ID')).toBe('name,ID')
  })
})
