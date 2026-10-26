import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
vi.mock('@/lib/contrast-audit', () => ({ showContrastAudit: vi.fn() }))

import { personFlag, personName, type SearchPerson } from './command-palette'

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
