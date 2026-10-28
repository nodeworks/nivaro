import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('@/lib/contrast-audit', () => ({ showContrastAudit: vi.fn() }))

import { personFlag, personName, type SearchPerson, searchTabs } from './command-palette'

const person = (p: Partial<SearchPerson>): SearchPerson => ({
  id: 'u1',
  first_name: null,
  last_name: null,
  email: null,
  title: null,
  department: null,
  ...p
})

describe('command palette people', () => {
  it('names a person, falling back to the email', () => {
    expect(personName(person({ first_name: 'Ann', last_name: 'Lee' }))).toBe('Ann Lee')
    expect(personName(person({ email: 'a@x' }))).toBe('a@x')
    expect(personName(person({}))).toBe('Unnamed person')
  })

  it('flags machine and suspended accounts (only an admin answer carries them)', () => {
    expect(personFlag(person({ account_kind: 'service', status: 'suspended' }))).toBe('Service')
    expect(personFlag(person({ status: 'suspended' }))).toBe('Suspended')
    // A directory row (non-admin answer) has neither column: no flag.
    expect(personFlag(person({ first_name: 'Ann' }))).toBeNull()
  })
})

describe('searchTabs', () => {
  const rec = (collection: string, id: number, display_name?: string | null) => ({
    collection,
    display_name,
    id,
    label: String(id),
    snippet: ''
  })
  const hits = [rec('workflows', 1, 'Workflows'), rec('workflows', 2, 'Workflows'), rec('units', 3)]

  it('shows the first answer as a floor until the counts land', () => {
    expect(searchTabs(hits, undefined)).toEqual([
      { collection: 'workflows', label: 'Workflows', count: '2+' },
      { collection: 'units', label: 'Units', count: '1+' }
    ])
  })

  it('uses the counts and keeps a floor where one is missing', () => {
    expect(
      searchTabs(hits, [{ collection: 'workflows', display_name: 'Workflows', count: 12 }])
    ).toEqual([
      { collection: 'workflows', label: 'Workflows', count: '12' },
      { collection: 'units', label: 'Units', count: '1+' }
    ])
  })
})
