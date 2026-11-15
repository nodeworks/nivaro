import { describe, expect, it } from 'vitest'
import { mayAffectMatch } from '../../lib/live-list'
import {
  CHANGED_PATH,
  changedCondition,
  changedFilterEntry,
  changedPhrase,
  changedTip,
  changedWindowShort,
  changedWindowText,
  customChangedValue,
  isChangedFilter,
  parseCustomChanged,
  viewChangedConditions,
  viewChangedTip
} from './changed-by-others'

describe('changed by others chip', () => {
  it('compiles a rolling window to the server condition, leaving my writes out', () => {
    expect(changedCondition(changedFilterEntry('24h'))).toEqual({
      path: [CHANGED_PATH],
      op: '_eq',
      value: { window: '24h', others: true }
    })
    expect(changedCondition({ ...changedFilterEntry('1h'), not: true }).op).toBe('_neq')
    // An unknown stored value falls back to the default window, never to "no filter".
    expect(changedCondition({ value: 'weird' }).value).toEqual({ window: '24h', others: true })
  })

  it('compiles a custom range to a fixed since/until', () => {
    const v = customChangedValue('2026-11-12T09:00', '2026-11-13T17:00')!
    const parsed = parseCustomChanged(v)!
    expect(new Date(parsed.since).getTime()).toBe(new Date('2026-11-12T09:00').getTime())
    expect(changedCondition({ value: v }).value).toEqual({
      since: parsed.since,
      until: parsed.until,
      others: true
    })
    // Open end = up to now.
    const open = customChangedValue('2026-11-12T09:00', '')!
    expect(changedCondition({ value: open }).value).toEqual({
      since: parseCustomChanged(open)!.since,
      others: true
    })
  })

  it('refuses a range that ends before it starts', () => {
    expect(customChangedValue('2026-11-13T09:00', '2026-11-12T09:00')).toBeNull()
    expect(customChangedValue('', '')).toBeNull()
  })

  it('says the window in plain words', () => {
    expect(changedWindowText('5d')).toBe('last 5 days')
    expect(changedPhrase(changedFilterEntry('1h'))).toBe('changed by others in the last hour')
    expect(changedPhrase({ value: '7d', not: true })).toBe(
      'not changed by others in the last 7 days'
    )
  })

  it('keeps the chip short and the tooltip explanatory', () => {
    expect(changedWindowShort('24h')).toBe('24 hours')
    expect(changedWindowShort('1h')).toBe('1 hour')
    expect(changedWindowShort(customChangedValue('2026-11-12T09:00', '')!)).toMatch(/– now$/)
    expect(changedTip({ value: '2d' })).toBe(
      'Records someone else created, edited or moved in the last 2 days. Click to change the period.'
    )
  })

  it('is recognised by its path only', () => {
    expect(isChangedFilter(changedFilterEntry('2d'))).toBe(true)
    expect(isChangedFilter({ path: ['$unseen'] })).toBe(false)
  })
})

describe('saved view changed count', () => {
  it("adds 'changed by others since I last opened it' to the view's own filter", () => {
    const view = [{ path: ['status'], op: '_eq', value: 'open' }]
    expect(viewChangedConditions(view, '2026-11-14T10:00:00.000Z')).toEqual([
      { path: ['status'], op: '_eq', value: 'open' },
      {
        path: [CHANGED_PATH],
        op: '_eq',
        value: { since: '2026-11-14T10:00:00.000Z', others: true }
      }
    ])
    expect(viewChangedTip(12)).toBe('12 changed since you last opened this view')
  })
})

describe('live: rows entering the window', () => {
  it('any real edit may bring a record into a changed-by-others list', () => {
    const fields = new Set([CHANGED_PATH])
    expect(mayAffectMatch({ action: 'update', changed_fields: ['title'] }, fields)).toBe(true)
    // Aspect-only notices (a comment, a lock) never move a list.
    expect(mayAffectMatch({ action: 'update', changed_fields: ['$comments'] }, fields)).toBe(false)
    // Without the chip, an edit outside the filtered fields does not.
    expect(
      mayAffectMatch({ action: 'update', changed_fields: ['title'] }, new Set(['status']))
    ).toBe(false)
  })
})
