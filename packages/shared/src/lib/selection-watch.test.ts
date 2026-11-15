import { describe, expect, it } from 'vitest'
import {
  batchChangesRecord,
  changedNoticeText,
  changedRowsOf,
  changeLineText,
  namesText,
  openNoticeText,
  reconcilePicks,
  selectionSums,
  selKey,
  splitSelKey
} from './selection-watch'

describe('picks', () => {
  it('stamps new rows, keeps old stamps, forgets dropped rows', () => {
    const prev = new Map([
      ['orders:1', 100],
      ['orders:2', 200]
    ])
    const next = reconcilePicks(prev, ['orders:2', 'orders:3'], 900)
    expect([...next]).toEqual([
      ['orders:2', 200],
      ['orders:3', 900]
    ])
  })
  it('round-trips keys whose ids carry colons', () => {
    expect(splitSelKey(selKey('orders', 'a:b'))).toEqual({ collection: 'orders', id: 'a:b' })
  })
})

describe('batchChangesRecord', () => {
  const b = (o: Partial<Parameters<typeof batchChangesRecord>[0]>) =>
    batchChangesRecord({
      changedFields: null,
      aspectsOnly: false,
      deleted: false,
      created: false,
      ...o
    })
  it('counts field writes, moves, creates and deletes — not locks or comments', () => {
    expect(b({ changedFields: ['amount'] })).toBe(true)
    expect(b({ changedFields: ['$state'], aspectsOnly: true })).toBe(true)
    expect(b({ deleted: true, aspectsOnly: true })).toBe(true)
    expect(b({ changedFields: ['$lock'], aspectsOnly: true })).toBe(false)
    expect(b({ changedFields: ['$comments', '$tasks'], aspectsOnly: true })).toBe(false)
  })
})

describe('words', () => {
  it('names people briefly', () => {
    expect(namesText(['Beth'])).toBe('Beth')
    expect(namesText(['Beth', 'Sam'])).toBe('Beth and Sam')
    expect(namesText(['Beth', 'Sam', 'Ana', 'Lee'])).toBe('Beth, Sam and 2 others')
    expect(namesText([], 2)).toBe('2 people')
    expect(namesText(['Beth', 'Beth'])).toBe('Beth')
  })

  it('says who has selected rows open or is editing them', () => {
    const open = (key: string, names: string[], editing = false, unnamed = 0) => ({
      key,
      names,
      editing,
      unnamed
    })
    expect(openNoticeText([open('a', ['Beth']), open('b', ['Beth'])], 5)).toBe(
      '2 of these are open by Beth right now'
    )
    expect(openNoticeText([open('a', ['Sam'], true)], 3)).toBe(
      '1 of these is being edited by Sam right now'
    )
    expect(openNoticeText([open('a', ['Sam'], true)], 1)).toBe(
      'This one is being edited by Sam right now'
    )
    expect(openNoticeText([open('a', [], false, 1)], 4)).toBe(
      '1 of these is open by someone right now'
    )
    expect(openNoticeText([open('a', [], false, 3)], 4)).toBe(
      '1 of these is open by 3 people right now'
    )
    expect(openNoticeText([], 4)).toBeNull()
  })

  it('counts changed rows', () => {
    expect(changedNoticeText(0)).toBeNull()
    expect(changedNoticeText(1)).toBe('1 selected row changed since you picked it')
    expect(changedNoticeText(3)).toBe('3 selected rows changed since you picked them')
  })

  it('says what changed', () => {
    const base = { names: ['Beth'], fieldLabels: [] as string[] }
    expect(changeLineText({ ...base, fieldLabels: ['Amount', 'Status'] })).toBe(
      'Beth changed Amount and Status'
    )
    expect(changeLineText({ ...base, moved_to: 'Finance' })).toBe('Beth moved it to Finance')
    expect(changeLineText({ ...base, moved_to: 'Finance', fieldLabels: ['Amount'] })).toBe(
      'Beth moved it to Finance and changed Amount'
    )
    expect(changeLineText({ ...base, deleted: true })).toBe('Beth deleted it')
    expect(changeLineText({ names: [], fieldLabels: [], fields_unknown: true })).toBe(
      'Someone changed it'
    )
  })
})

describe('changedRowsOf', () => {
  it('labels records, people and fields as the server read them for the viewer', () => {
    const rows = changedRowsOf('orders', {
      changes: {
        '7': { at: '2026-11-15T12:00:00Z', by: ['u-beth', 'u-gone'], fields: ['amount', 'po_ref'] }
      },
      labels: {
        records: { 'orders:7': 'Order 7' },
        users: { 'u-beth': 'Beth Ray' },
        fields: { 'orders.amount': 'Amount' }
      }
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('orders:7')
    expect(rows[0].label).toBe('Order 7')
    expect(rows[0].names).toEqual(['Beth Ray', 'someone'])
    expect(rows[0].fieldLabels).toEqual(['Amount', 'Po Ref'])
  })
})

describe('selectionSums', () => {
  it('sums the numbers the selected rows hold, skipping blanks', () => {
    const r = selectionSums(
      [{ amount: '10.50', hours: 2 }, { amount: 4, hours: null }, undefined, { amount: 'x' }],
      ['amount', 'hours', 'missing']
    )
    expect(r.known).toBe(3)
    expect(r.sums).toEqual([
      { key: 'amount', sum: 14.5, counted: 2 },
      { key: 'hours', sum: 2, counted: 1 }
    ])
  })
  it('reads through a custom reader (queue extras, formulas)', () => {
    const r = selectionSums(
      [{ extra: { total: 3 } }, { extra: { total: 4 } }],
      ['extra.total'],
      (row, k) => (row.extra as Record<string, unknown>)[k.slice(6)]
    )
    expect(r.sums[0].sum).toBe(7)
  })
})
