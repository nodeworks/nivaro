import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))

import {
  byText,
  clampSince,
  foldFieldChanges,
  UNSEEN_LOOKBACK_MS,
  unseenValueText
} from './move-unseen.js'

const ME = 'AAAAAAAA-0000-0000-0000-000000000001'
const BETH = 'BBBBBBBB-0000-0000-0000-000000000002'
const KIM = 'CCCCCCCC-0000-0000-0000-000000000003'

const rev = (
  id: number,
  user: string | null,
  delta: Record<string, unknown>,
  data: Record<string, unknown>,
  at = `2026-11-14T10:0${id}:00.000Z`
) => ({ id, at, user, delta, data })

describe('foldFieldChanges — what someone else changed since the page read the record', () => {
  it('lists another person’s change with the value before it and the value now', () => {
    const out = foldFieldChanges(
      { amount: 1200, title: 'Pumps' },
      [rev(1, BETH, { amount: 1450 }, { amount: 1450, title: 'Pumps' })],
      ME
    )
    expect(out).toEqual([
      { field: 'amount', from: 1200, to: 1450, at: '2026-11-14T10:01:00.000Z', by: [BETH] }
    ])
  })

  it('never lists the mover’s own changes, but they move the “now” value', () => {
    const out = foldFieldChanges(
      { amount: 1200, title: 'Pumps' },
      [
        rev(1, ME, { title: 'Pumps 2' }, { amount: 1200, title: 'Pumps 2' }),
        rev(2, BETH, { amount: 1450 }, { amount: 1450, title: 'Pumps 2' }),
        rev(3, ME, { amount: 1500 }, { amount: 1500, title: 'Pumps 2' })
      ],
      ME
    )
    expect(out.map((f) => f.field)).toEqual(['amount'])
    expect(out[0]).toMatchObject({ from: 1200, to: 1500 })
  })

  it('folds several changes to one field: first value before, value now, everyone who changed it', () => {
    const out = foldFieldChanges(
      { status: 'open' },
      [
        rev(1, BETH, { status: 'review' }, { status: 'review' }),
        rev(2, KIM, { status: 'approved' }, { status: 'approved' }),
        rev(3, BETH, { status: 'closed' }, { status: 'closed' })
      ],
      ME
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ from: 'open', to: 'closed', by: [BETH, KIM] })
    expect(out[0].at).toBe('2026-11-14T10:03:00.000Z')
  })

  it('leaves out a field changed and changed back (it reads as when the page opened)', () => {
    const out = foldFieldChanges(
      { amount: 100 },
      [
        rev(1, BETH, { amount: 200 }, { amount: 200 }),
        rev(2, BETH, { amount: '100.00' }, { amount: '100.00' })
      ],
      ME
    )
    expect(out).toEqual([])
  })

  it('an automated write (no person) counts as someone else', () => {
    const out = foldFieldChanges(
      { po_number: null },
      [rev(1, null, { po_number: 'PO-77' }, { po_number: 'PO-77' })],
      ME
    )
    expect(out[0]).toMatchObject({ from: null, to: 'PO-77', by: [null] })
  })

  it('the newest change comes first', () => {
    const out = foldFieldChanges(
      {},
      [rev(1, BETH, { a: 1 }, { a: 1 }), rev(2, KIM, { b: 2 }, { a: 1, b: 2 })],
      ME
    )
    expect(out.map((f) => f.field)).toEqual(['b', 'a'])
  })
})

describe('byText', () => {
  const names = new Map([
    [BETH.toLowerCase(), 'Beth Smith'],
    [KIM.toLowerCase(), 'Kim Lee']
  ])
  it('names one, two, or the first and a count', () => {
    expect(byText([BETH], names)).toBe('Beth Smith')
    expect(byText([BETH, KIM], names)).toBe('Beth Smith and Kim Lee')
    expect(byText([BETH, KIM, null], names)).toBe('Beth Smith and 2 others')
    expect(byText([null], names)).toBe('An automated process')
  })
})

describe('unseenValueText — values as the mover may read them', () => {
  const labels = {
    links: { 'orders.vendor': 'vendors' },
    records: { 'vendors:7': 'Acme', 'vendors:9': null },
    fields: { 'orders.amount': 'Amount' }
  }
  it('groups numbers', () => {
    expect(unseenValueText('orders', 'amount', 1450, labels)).toBe('1,450')
    expect(unseenValueText('orders', 'amount', '1200.5', labels)).toBe('1,200.5')
  })
  it('names a linked record as the reader may see it, never its id', () => {
    expect(unseenValueText('orders', 'vendor', 7, labels)).toBe('Acme')
    expect(unseenValueText('orders', 'vendor', 9, labels)).toBe("a record you can't see")
  })
  it('empty is null', () => {
    expect(unseenValueText('orders', 'amount', null, labels)).toBeNull()
    expect(unseenValueText('orders', 'amount', '', labels)).toBeNull()
  })
})

describe('clampSince', () => {
  const now = Date.parse('2026-11-14T12:00:00Z')
  it('refuses a missing or broken time', () => {
    expect(clampSince(undefined, now)).toBeNull()
    expect(clampSince('nope', now)).toBeNull()
  })
  it('never looks into the future or further back than a week', () => {
    expect(clampSince('2027-01-01T00:00:00Z', now)?.getTime()).toBe(now)
    expect(clampSince('2020-01-01T00:00:00Z', now)?.getTime()).toBe(now - UNSEEN_LOOKBACK_MS)
    expect(clampSince('2026-11-14T11:00:00Z', now)?.toISOString()).toBe('2026-11-14T11:00:00.000Z')
  })
})
