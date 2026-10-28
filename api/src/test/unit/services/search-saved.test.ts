import { beforeEach, describe, expect, it, vi } from 'vitest'

// Saved searches (search program item 13): the caller's own list in
// preferences.saved_searches, written through updateUser.

const store = vi.hoisted(() => ({ prefs: null as unknown, writes: 0 }))

vi.mock('../../../db/index.js', () => {
  const db = vi.fn(() => ({
    where: () => ({ first: async () => ({ preferences: store.prefs }) })
  }))
  return { db }
})
vi.mock('../../../services/users.js', () => ({
  updateUser: vi.fn(async (_id: string, data: { preferences: unknown }) => {
    store.prefs = JSON.stringify(data.preferences)
    store.writes++
  })
}))

const {
  addSaved,
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  normalizeSaved,
  SAVED_MAX,
  SavedSearchError
} = await import('../../../services/search-saved.js')

beforeEach(() => {
  store.prefs = JSON.stringify({ theme_accent: 'rose' })
  store.writes = 0
})

describe('saved searches — pure', () => {
  it('normalizes a stored list: drops junk, dedupes ids, caps', () => {
    const raw = [
      { id: 'a', q: 'wf: canton', name: 'Canton' },
      { id: 'a', q: 'dup' },
      { id: 'b' },
      'junk',
      ...Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, q: `q${i}` }))
    ]
    const list = normalizeSaved(raw)
    expect(list[0]).toMatchObject({ id: 'a', name: 'Canton', q: 'wf: canton', scope: null })
    expect(list).toHaveLength(SAVED_MAX)
    expect(normalizeSaved('nope')).toEqual([])
  })

  it('adds newest first, replaces the same query, refuses past the cap', () => {
    const now = new Date('2026-10-28T12:00:00Z')
    const one = addSaved([], { q: '  wf:   canton ', name: '' }, now, 'id1')
    expect(one.entry).toEqual({
      id: 'id1',
      name: 'wf: canton',
      q: 'wf: canton',
      scope: null,
      created_at: now.toISOString()
    })
    const again = addSaved(one.list, { q: 'wf: canton', name: 'Mine' }, now, 'id2')
    expect(again.list.map((s) => s.id)).toEqual(['id2'])
    expect(() => addSaved([], { q: '' })).toThrow(SavedSearchError)
    const full = Array.from({ length: SAVED_MAX }, (_, i) => ({
      id: `s${i}`,
      name: 'n',
      q: `q${i}`,
      scope: null,
      created_at: ''
    }))
    expect(() => addSaved(full, { q: 'new' })).toThrow(/At most/)
  })
})

describe('saved searches — CRUD on preferences', () => {
  it('creates, lists and deletes, keeping the other preferences', async () => {
    const entry = await createSavedSearch('u-1', { q: 'status:open', name: 'Open' })
    expect(store.writes).toBe(1)
    expect(JSON.parse(store.prefs as string).theme_accent).toBe('rose')
    expect((await listSavedSearches('u-1')).map((s) => s.name)).toEqual(['Open'])
    expect(await deleteSavedSearch('u-1', 'missing')).toBe(false)
    expect(store.writes).toBe(1)
    expect(await deleteSavedSearch('u-1', entry.id)).toBe(true)
    expect(await listSavedSearches('u-1')).toEqual([])
  })

  it('a malformed preferences blob reads as no saved searches', async () => {
    store.prefs = '{oops'
    expect(await listSavedSearches('u-1')).toEqual([])
  })
})
