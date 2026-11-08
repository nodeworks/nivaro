// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  arrivedByListReturn,
  LIST_RETURN_STATE,
  pageWhileSettling,
  rememberedListPage,
  rememberListPage,
  restoreWindowOutcome
} from './list-page-memory'

// army 8 b14: Back from a record put the list on page 1 again.
describe('list page memory (per history entry)', () => {
  beforeEach(() => window.sessionStorage.clear())
  it('Back to the same history entry finds its page', () => {
    rememberListPage('cbv:workflows', 2, 'entry-a')
    expect(rememberedListPage('cbv:workflows', 'entry-a')).toBe(2)
  })
  it('a new visit (another entry) and another list start on page 1', () => {
    rememberListPage('cbv:workflows', 3, 'entry-a')
    expect(rememberedListPage('cbv:workflows', 'entry-b')).toBeNull()
    expect(rememberedListPage('cbv:invoices', 'entry-a')).toBeNull()
  })
  it('page 1 forgets; no history key remembers nothing', () => {
    rememberListPage('cbv:workflows', 4, 'entry-a')
    rememberListPage('cbv:workflows', 1, 'entry-a')
    expect(rememberedListPage('cbv:workflows', 'entry-a')).toBeNull()
    rememberListPage('cbv:workflows', 4, null)
    expect(rememberedListPage('cbv:workflows', null)).toBeNull()
  })
  it('reads the react-router key from history.state by default', () => {
    window.history.replaceState({ key: 'k1', idx: 0 }, '')
    rememberListPage('cbv:workflows', 5)
    expect(rememberedListPage('cbv:workflows')).toBe(5)
    window.history.replaceState({ key: 'k2', idx: 1 }, '')
    expect(rememberedListPage('cbv:workflows')).toBeNull()
  })
  // army 9 b14: the first entry after a full load has only {idx: 0} — nothing was remembered.
  it('mints a key for an entry without one, keeping the router state', () => {
    window.history.replaceState({ idx: 0, usr: { from: 'mail' } }, '')
    rememberListPage('cbv:workflows', 2)
    const st = window.history.state as { key?: string; idx?: number; usr?: unknown }
    expect(typeof st.key).toBe('string')
    expect(st.idx).toBe(0)
    expect(st.usr).toEqual({ from: 'mail' })
    expect(rememberedListPage('cbv:workflows')).toBe(2)
  })
  it('page 1 on a keyless entry mints nothing', () => {
    window.history.replaceState({ idx: 0 }, '')
    rememberListPage('cbv:workflows', 1)
    expect((window.history.state as { key?: string }).key).toBeUndefined()
  })
  it('an automatic reset to page 1 while settling keeps the restored page', () => {
    expect(pageWhileSettling(2, 1)).toBe(2)
    expect(pageWhileSettling(2, 3)).toBe(3)
    expect(pageWhileSettling(null, 1)).toBe(1)
  })
})

describe('restoreWindowOutcome', () => {
  const base = {
    pending: 3,
    gateOpen: true,
    fetching: false,
    failed: false,
    placeholder: false,
    loaded: true,
    total: 100,
    totalUnknown: false,
    pageSize: 25,
    page: 3
  }
  it('closes on the first settled page; a page past the end moves to the last', () => {
    expect(restoreWindowOutcome(base)).toEqual({ close: true, page: null })
    expect(restoreWindowOutcome({ ...base, total: 40, page: 3 })).toEqual({ close: true, page: 2 })
  })
  it('keeps waiting while the read is in flight, a placeholder, or the gate is shut', () => {
    expect(restoreWindowOutcome({ ...base, fetching: true })).toBeNull()
    expect(restoreWindowOutcome({ ...base, placeholder: true })).toBeNull()
    expect(restoreWindowOutcome({ ...base, gateOpen: false, loaded: false })).toBeNull()
  })
  // army 9 review L3: a failed first load left the window open for good.
  it('a failed first read closes it', () => {
    expect(restoreWindowOutcome({ ...base, loaded: false, failed: true })).toEqual({
      close: true,
      page: null
    })
    expect(restoreWindowOutcome({ ...base, pending: null })).toBeNull()
  })
})

// army 10: a record's back arrow opens the list as a NEW entry (it never steps back).
describe('list page memory — return to the list', () => {
  beforeEach(() => window.sessionStorage.clear())
  it('a return navigation (usr carries LIST_RETURN_STATE) starts on the page last left', () => {
    window.history.replaceState({ key: 'list-a', idx: 0 }, '')
    rememberListPage('cbv:workflows', 2)
    window.history.replaceState({ key: 'list-b', idx: 2, usr: LIST_RETURN_STATE }, '')
    expect(arrivedByListReturn()).toBe(true)
    expect(rememberedListPage('cbv:workflows')).toBe(2)
    expect(rememberedListPage('cbv:invoices')).toBeNull()
  })
  it('a plain new visit does not inherit the last page', () => {
    window.history.replaceState({ key: 'list-a', idx: 0 }, '')
    rememberListPage('cbv:workflows', 2)
    window.history.replaceState({ key: 'list-b', idx: 2, usr: null }, '')
    expect(arrivedByListReturn()).toBe(false)
    expect(rememberedListPage('cbv:workflows')).toBeNull()
  })
  it("the entry's own page wins over the last page; page 1 forgets both", () => {
    rememberListPage('cbv:workflows', 4, 'list-a')
    rememberListPage('cbv:workflows', 2, 'list-b')
    window.history.replaceState({ key: 'list-a', idx: 0, usr: LIST_RETURN_STATE }, '')
    expect(rememberedListPage('cbv:workflows')).toBe(4)
    rememberListPage('cbv:workflows', 1, 'list-b')
    window.history.replaceState({ key: 'list-c', idx: 3, usr: LIST_RETURN_STATE }, '')
    expect(rememberedListPage('cbv:workflows')).toBeNull()
  })
})
