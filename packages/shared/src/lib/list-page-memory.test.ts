// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { rememberedListPage, rememberListPage } from './list-page-memory'

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
})
