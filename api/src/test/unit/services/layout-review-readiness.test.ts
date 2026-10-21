import { describe, expect, it } from 'vitest'
import {
  addMonths,
  monthsBetween,
  parseMonths,
  reviewDue,
  reviewNotice
} from '../../../services/layout-review.js'
import {
  diffSeen,
  formFields,
  nextState,
  type PinRef,
  pinKey,
  pinsOf,
  type SeenView
} from '../../../services/layout-test-readiness.js'

describe('review reminders (#2718)', () => {
  const d = (s: string) => new Date(`${s}T12:00:00Z`)

  it('parses months 0..36 only', () => {
    expect(parseMonths('6')).toBe(6)
    expect(parseMonths(0)).toBe(0)
    expect(parseMonths('37')).toBeNull()
    expect(parseMonths('1.5')).toBeNull()
    expect(parseMonths(null)).toBeNull()
  })

  it('adds calendar months, clamping to the month end', () => {
    expect(addMonths(d('2026-01-31'), 1).toISOString().slice(0, 10)).toBe('2026-02-28')
    expect(addMonths(d('2026-03-15'), 6).toISOString().slice(0, 10)).toBe('2026-09-15')
    expect(monthsBetween(d('2026-01-20'), d('2026-07-19'))).toBe(5)
    expect(monthsBetween(d('2026-01-20'), d('2026-07-20'))).toBe(6)
  })

  it('is due once the form is unchanged for the months, then again every that many months', () => {
    const changedAt = d('2026-01-10')
    const base = { changedAt, months: 6, remindedAt: null as Date | null }
    expect(reviewDue({ ...base, now: d('2026-07-09') })).toBe(false)
    expect(reviewDue({ ...base, now: d('2026-07-10') })).toBe(true)
    const reminded = { ...base, remindedAt: d('2026-07-10') }
    expect(reviewDue({ ...reminded, now: d('2026-12-01') })).toBe(false)
    expect(reviewDue({ ...reminded, now: d('2027-01-10') })).toBe(true)
    // A change after the reminder starts the count over.
    expect(
      reviewDue({
        changedAt: d('2026-08-01'),
        months: 6,
        remindedAt: d('2026-07-10'),
        now: d('2026-12-01')
      })
    ).toBe(false)
    expect(reviewDue({ ...base, months: 0, now: d('2030-01-01') })).toBe(false)
    expect(reviewDue({ ...base, changedAt: null, now: d('2030-01-01') })).toBe(false)
  })

  it('names the health score and usage in the notice', () => {
    const n = reviewNotice({
      layoutName: 'Unit order',
      changedAt: d('2026-01-10'),
      now: d('2026-08-11'),
      health: { score: 82, errors: 0, warnings: 2 },
      usage: { opens: 140, saves: 120, abandons: 3, people: 12 }
    })
    expect(n.subject).toBe('Time to review the form “Unit order”')
    expect(n.message).toContain('It has not changed in 7 months.')
    expect(n.message).toContain('Health 82/100 (2 warnings).')
    expect(n.message).toContain(
      'opened 140 times by 12 people, 120 saves, 3 new records left unfinished'
    )
    const quiet = reviewNotice({
      layoutName: 'X',
      changedAt: d('2026-01-10'),
      now: d('2026-08-11'),
      health: null,
      usage: { opens: 0, saves: 0, abandons: 0, people: 0 }
    })
    expect(quiet.message).toContain('Nobody opened it in the last 30 days.')
  })
})

describe('test records readiness (#2720)', () => {
  const pin: PinRef = {
    layout_id: 4,
    layout_name: 'Unit order',
    collection: 'orders',
    item: '12',
    role_id: 'R1'
  }
  const ok = (form_id: number, fields: string[], form_name = `F${form_id}`): SeenView => ({
    state: 'ok',
    form_id,
    form_name,
    fields
  })

  it('reads pins from conditions.testing, deduplicated', () => {
    const pins = pinsOf([
      {
        id: 4,
        name: 'Unit order',
        collection: 'orders',
        conditions: JSON.stringify({
          testing: {
            records: [{ item: 12, role_id: 'R1' }, { item: '12', role_id: 'r1' }, { item: '' }]
          }
        })
      },
      { id: 5, name: 'Other', collection: 'orders', conditions: null }
    ])
    expect(pins).toEqual([pin])
  })

  it('moves the previous version into prev on a new version only', () => {
    const s1 = nextState(null, '0.2.78', { a: { state: 'missing' } }, 't1')
    expect(s1.prev).toBeNull()
    const s2 = nextState(s1, '0.2.78', { a: { state: 'no_form' } }, 't2')
    expect(s2.prev).toBeNull()
    const s3 = nextState(s2, '0.2.79', { a: ok(1, []) }, 't3')
    expect(s3).toMatchObject({ prev_version: '0.2.78', prev: { a: { state: 'no_form' } } })
    const s4 = nextState(s3, '0.2.79', { a: ok(2, []) }, 't4')
    expect(s4.prev).toEqual(s3.prev)
  })

  it('says what changed for each record', () => {
    const k = pinKey(pin)
    const role = () => 'Field Tech'
    expect(diffSeen([pin], { [k]: ok(1, ['a']) }, { [k]: ok(1, ['a']) }, role)).toEqual([])
    expect(
      diffSeen([pin], { [k]: ok(1, ['a'], 'Old') }, { [k]: ok(2, ['a'], 'New') }, role)
    ).toEqual(['“Unit order” test record orders 12 as Field Tech: now opens “New” (was “Old”)'])
    expect(
      diffSeen(
        [pin],
        { [k]: ok(1, ['a', 'b', 'c:ro', 'd']) },
        { [k]: ok(1, ['a:ro', 'c', 'd', 'e']) },
        role
      )
    ).toEqual([
      '“Unit order” test record orders 12 as Field Tech: no longer shows b; now shows e; can no longer edit a; can now edit c'
    ])
    expect(diffSeen([pin], { [k]: ok(1, []) }, { [k]: { state: 'missing' } }, role)[0]).toMatch(
      /now is not found \(before: opens “F1”\)/
    )
    // A record not seen before is not a change.
    expect(diffSeen([pin], {}, { [k]: ok(1, []) }, role)).toEqual([])
  })

  it('lists the fields a form shows a role, read-only where it may not edit', () => {
    const groups = [
      { id: 1, key: 'main', container_id: null },
      { id: 2, key: 'secret', container_id: null, hidden_for_roles: JSON.stringify(['R1']) },
      { id: 3, key: 'tab', container_id: null, locked_for_roles: '["r1"]' },
      { id: 4, key: 'inner', container_id: 3 }
    ]
    const assignments = [
      { field: 'name', group_key: 'main', is_visible: true },
      { field: 'off', group_key: 'main', is_visible: false },
      { field: '__pipeline__', group_key: null },
      { field: 'pay', group_key: 'secret' },
      { field: 'note', group_key: 'inner' },
      { field: 'cost', group_key: 'main' },
      { field: 'qty', group_key: 'main' },
      { field: 'loose', group_key: null }
    ]
    const access = {
      role: { id: 'R1', name: 'Field Tech', admin_access: false },
      can_read: true,
      can_update: true,
      hidden_fields: ['cost'],
      readonly_fields: ['qty']
    }
    expect(formFields(groups, assignments, 'R1', access)).toEqual([
      'loose',
      'name',
      'note:ro',
      'qty:ro'
    ])
    expect(formFields(groups, assignments, null, null)).toEqual([
      'cost',
      'loose',
      'name',
      'note',
      'pay',
      'qty'
    ])
  })
})
