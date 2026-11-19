import { describe, expect, it } from 'vitest'
import { kindOfRow, personLabel } from './person-names.js'

/** Who an activity person id is — never a bare "Someone". */

describe('person names', () => {
  it('reads the kind of a directory row', () => {
    expect(kindOfRow({ first_name: 'Pat', last_name: 'Lee' })).toBe('person')
    expect(kindOfRow({ first_name: 'Pat', is_redacted: 1 })).toBe('redacted')
    expect(kindOfRow({ first_name: 'Sync', account_kind: 'integration' })).toBe('machine')
    expect(kindOfRow({ email: 'x@invalid.local', account_kind: 'placeholder' })).toBe('placeholder')
    expect(kindOfRow({})).toBe('unnamed')
    expect(kindOfRow({ email: 'pat@example.com' })).toBe('person')
  })

  it('labels every kind, and a deleted name only for administrators', () => {
    const del = { id: 'A', name: 'Sam Doe', kind: 'deleted' as const }
    expect(personLabel(del, { revealDeletedName: true })).toBe('Sam Doe (deleted user)')
    expect(personLabel(del, { revealDeletedName: false })).toBe('Deleted user')
    expect(personLabel({ ...del, name: null }, { revealDeletedName: true })).toBe('Deleted user')
    expect(
      personLabel({ id: 'A', name: 'Pat', kind: 'redacted' }, { revealDeletedName: true })
    ).toBe('Redacted person')
    expect(personLabel({ id: 'A', name: null, kind: 'machine' }, { revealDeletedName: true })).toBe(
      'Service account'
    )
    expect(
      personLabel(
        { id: 'A', name: null, kind: 'machine', machine: 'bot' },
        { revealDeletedName: true }
      )
    ).toBe('Bot account')
    expect(
      personLabel({ id: 'A', name: 'Old Pat', kind: 'placeholder' }, { revealDeletedName: true })
    ).toBe('Old Pat (placeholder)')
    expect(personLabel({ id: 'A', name: null, kind: 'unnamed' }, { revealDeletedName: true })).toBe(
      'Account with no name'
    )
    for (const kind of [
      'person',
      'deleted',
      'redacted',
      'placeholder',
      'machine',
      'unnamed'
    ] as const)
      expect(personLabel({ id: 'A', name: null, kind }, { revealDeletedName: false })).not.toBe(
        'Someone'
      )
  })
})
