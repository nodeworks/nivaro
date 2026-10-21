import { describe, expect, it } from 'vitest'
import { newGroup, newPlacement, ungroupedGroup } from '../../lib/layout-ops'
import { targetKey } from './design-context'
import { initials, peersByTarget, peersFrom, peerTone } from './presence'
import { describeTarget, opTargets, targetFromKey, unsavedKeys } from './unsaved-marks'

const bundle = {
  layout: { id: 1, collection: 'orders' },
  groups: [{ ...newGroup('main', 'Main', 'section', null), id: 1, sort: 0 }, ungroupedGroup(1)],
  placements: [
    { ...newPlacement('title', 'main'), id: 10, sort: 0, label_override: 'PO title' },
    { ...newPlacement('amount', '__header__'), id: 11, sort: 0 }
  ],
  rev: 'r'
}

describe('unsaved markers (#2629)', () => {
  it('names the node each op leaves changed', () => {
    const keys = (op: Parameters<typeof opTargets>[0]) => opTargets(op).map(targetKey)
    expect(keys({ op: 'place', field: 'a', group_key: 'main', index: 0 })).toEqual(['field:a:main'])
    expect(keys({ op: 'place', field: '__pdf__', group_key: 'main', index: 0 })).toEqual([
      'slot:__pdf__:main'
    ])
    expect(keys({ op: 'place', field: 'a', group_key: '__header__', index: 0 })).toEqual([
      'header:a'
    ])
    expect(
      keys({ op: 'move', from: { field: 'a', group_key: 'main' }, to_group_key: null, index: 0 })
    ).toEqual(['field:a:'])
    expect(keys({ op: 'remove', at: { field: 'a', group_key: 'main' } })).toEqual(['group:main'])
    expect(keys({ op: 'remove', at: { field: 'a', group_key: null } })).toEqual([
      'group:__ungrouped__'
    ])
    expect(keys({ op: 'group_update', key: 'main', patch: { label: 'X' } })).toEqual(['group:main'])
    expect(keys({ op: 'group_move', key: '__pipeline__', parent_key: null, index: 0 })).toEqual([
      'slot:__pipeline__:'
    ])
    expect(keys({ op: 'layout_update', patch: { name: 'X' } })).toEqual([])
  })

  it('collects every touched key across steps', () => {
    const set = unsavedKeys([
      { label: 'a', ops: [{ op: 'group_update', key: 'main', patch: { label: 'X' } }] },
      {
        label: 'b',
        ops: [{ op: 'update_placement', at: { field: 't', group_key: 'main' }, patch: {} }]
      }
    ])
    expect([...set].sort()).toEqual(['field:t:main', 'group:main'])
  })

  it('turns keys back into targets and targets into words', () => {
    for (const k of ['field:title:main', 'field:x:', 'slot:__pdf__:main', 'group:main', 'header:a'])
      expect(targetKey(targetFromKey(k) as never)).toBe(k)
    expect(targetFromKey('nonsense')).toBeNull()
    expect(describeTarget({ kind: 'field', field: 'title', group_key: 'main' }, bundle)).toBe(
      'PO title in Main'
    )
    expect(
      describeTarget({ kind: 'field', field: 'vendor', group_key: null }, bundle, [
        { field: 'vendor', label: 'Vendor name' }
      ])
    ).toBe('Vendor name in Ungrouped')
    expect(describeTarget({ kind: 'header', field: 'amount' }, bundle)).toBe('Amount in the header')
    expect(describeTarget({ kind: 'slot', field: '__pdf__', group_key: 'main' }, bundle)).toBe(
      'PDF button in Main'
    )
  })
})

describe('presence helpers (#2651)', () => {
  it('leaves me out, keeps selections and gives each person a stable colour', () => {
    const peers = peersFrom(
      [
        { id: 'ME', name: 'Me' },
        { id: 'u2', name: 'Ben Ode', selected: 'group:main' },
        { id: 'u3', name: '' },
        { name: 'no id' }
      ],
      'me'
    )
    expect(peers.map((p) => [p.id, p.name, p.selected])).toEqual([
      ['u2', 'Ben Ode', 'group:main'],
      ['u3', 'Someone', null]
    ])
    expect(peerTone('u2')).toBe(peerTone('U2'))
    expect(
      peersByTarget(peers)
        .get('group:main')
        ?.map((p) => p.id)
    ).toEqual(['u2'])
    expect(peersFrom('nope', null)).toEqual([])
    expect(initials('Ben de Ode')).toBe('BO')
    expect(initials('  ')).toBe('?')
  })
})
