import { describe, expect, it } from 'vitest'
import { normalizeWatchList, WATCH_PINS_MAX } from './store.js'
import { autoPinPlan, withAutoPin, withoutAutoPin } from './transitions.js'

const T0 = new Date('2026-11-14T10:00:00Z')
const person = (settings: Record<string, boolean>, pins: unknown[] = []) =>
  normalizeWatchList({ settings, pins })

describe('auto-add / auto-remove on a move', () => {
  it('adds for new owners who turned it on, removes automatic pins from people who left', () => {
    const people = new Map([
      ['u-owner', person({ auto_add: true })],
      ['u-owner-off', person({ auto_add: false })],
      ['u-left', person({ auto_add: true, auto_remove: true }, [{ c: 'po', id: '1', auto: true }])],
      ['u-left-mine', person({ auto_add: true, auto_remove: true }, [{ c: 'po', id: '1' }])],
      ['u-left-keep', person({ auto_add: true }, [{ c: 'po', id: '1', auto: true }])]
    ])
    const plan = autoPinPlan(people, {
      collection: 'po',
      item: '1',
      ownerIds: ['U-OWNER', 'u-owner-off'],
      terminal: false
    })
    expect(plan.add).toEqual(['u-owner'])
    // A pin the person made themselves stays; so does one when auto-remove is off.
    expect(plan.remove).toEqual(['u-left'])
  })

  it('a finished record is added for nobody and leaves everyone’s automatic pins', () => {
    const people = new Map([
      ['u-owner', person({ auto_add: true, auto_remove: true }, [{ c: 'po', id: '1', auto: true }])]
    ])
    const plan = autoPinPlan(people, {
      collection: 'po',
      item: '1',
      ownerIds: ['u-owner'],
      terminal: true
    })
    expect(plan).toEqual({ add: [], remove: ['u-owner'] })
  })

  it('never adds past the cap, never twice, never when turned off', () => {
    const full = person(
      { auto_add: true },
      Array.from({ length: WATCH_PINS_MAX }, (_, i) => ({ c: 'po', id: String(i + 100) }))
    )
    expect(withAutoPin(full, 'po', '1', T0)).toBeNull()
    const on = person({ auto_add: true })
    const added = withAutoPin(on, 'po', '1', T0)
    expect(added?.pins[0]).toMatchObject({ c: 'po', id: '1', auto: true })
    expect(withAutoPin(added as never, 'po', '1', T0)).toBeNull()
    expect(withAutoPin(person({}), 'po', '1', T0)).toBeNull()
  })

  it('removes only an automatic pin', () => {
    const auto = person({ auto_add: true, auto_remove: true }, [{ c: 'po', id: '1', auto: true }])
    expect(withoutAutoPin(auto, 'po', '1')?.pins).toEqual([])
    const mine = person({ auto_add: true, auto_remove: true }, [{ c: 'po', id: '1' }])
    expect(withoutAutoPin(mine, 'po', '1')).toBeNull()
  })
})
