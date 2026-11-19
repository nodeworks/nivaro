import { describe, expect, it } from 'vitest'
import {
  buildRecapChanges,
  plainValue,
  type RecapFieldInfo,
  type RecapSave
} from '../../../services/record-recap-changes.js'

// The recap strip's popover (2026-11-18): field by field, before → after, who and when — as the
// viewer may see it.

const SINCE = new Date('2026-11-17T12:00:00Z')
const fields = new Map<string, RecapFieldInfo>([
  ['title', { label: 'Title', system: false }],
  ['amount', { label: 'Amount', system: false, type: 'decimal' }],
  ['salary', { label: 'Salary', system: false }],
  ['date_updated', { label: 'Date Updated', system: true }]
])
const save = (over: Partial<RecapSave>): RecapSave => ({
  id: 1,
  timestamp: '2026-11-18T10:00:00Z',
  user_id: 'nick',
  name: 'Nicholas Desrosiers',
  action: 'update',
  data: null,
  delta: null,
  ...over
})
const baseline = { id: 7, title: 'Old', amount: 100, salary: 50, date_updated: '2026-11-17' }

describe('buildRecapChanges', () => {
  it('lists each changed field with the value before and after', () => {
    const out = buildRecapChanges({
      since: SINCE,
      viewerId: 'me',
      baseline,
      readable: null,
      fields,
      saves: [
        save({
          data: { ...baseline, title: 'New', date_updated: '2026-11-18' },
          delta: { title: 'New', date_updated: '2026-11-18' }
        })
      ]
    })
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0].name).toBe('Nicholas Desrosiers')
    expect(out.groups[0].changes).toEqual([
      { field: 'title', has_before: true, before: 'Old', after: 'New' },
      { field: 'date_updated', has_before: true, before: '2026-11-17', after: '2026-11-18' }
    ])
    // Bookkeeping stamps stay, marked as system.
    expect(out.fields.date_updated.system).toBe(true)
    expect(out.fields.title).toMatchObject({ label: 'Title', system: false })
  })

  it('never names a field the viewer may not read — not its value, not its label', () => {
    const out = buildRecapChanges({
      since: SINCE,
      viewerId: 'me',
      baseline,
      readable: new Set(['id', 'title']),
      fields,
      saves: [
        save({
          data: { ...baseline, title: 'New', salary: 90 },
          delta: { title: 'New', salary: 90 }
        }),
        save({ id: 2, data: { ...baseline, title: 'New', salary: 95 }, delta: { salary: 95 } })
      ]
    })
    const json = JSON.stringify(out)
    expect(json).not.toContain('salary')
    expect(json).not.toContain('Salary')
    expect(json).not.toContain('90')
    expect(json).not.toContain('95')
    expect(out.groups[0].changes.map((c) => c.field)).toEqual(['title'])
  })

  it("leaves out the viewer's own saves but still reads values through them", () => {
    const out = buildRecapChanges({
      since: SINCE,
      viewerId: 'me',
      baseline,
      readable: null,
      fields,
      saves: [
        save({ id: 1, user_id: 'me', data: { ...baseline, amount: 200 }, delta: { amount: 200 } }),
        save({
          id: 2,
          timestamp: '2026-11-18T11:00:00Z',
          data: { ...baseline, amount: 300 },
          delta: { amount: 300 }
        })
      ]
    })
    expect(out.groups).toHaveLength(1)
    // Before = what the viewer's own save left, not the older baseline.
    expect(out.groups[0].changes).toEqual([
      { field: 'amount', has_before: true, before: 200, after: 300 }
    ])
    // everyone: their own save is listed too (the "since this email" strip).
    const all = buildRecapChanges({
      since: SINCE,
      viewerId: 'me',
      everyone: true,
      baseline,
      readable: null,
      fields,
      saves: [
        save({
          id: 1,
          user_id: 'me',
          name: 'Me',
          data: { ...baseline, amount: 200 },
          delta: { amount: 200 }
        }),
        save({
          id: 2,
          timestamp: '2026-11-18T11:00:00Z',
          data: { ...baseline, amount: 300 },
          delta: { amount: 300 }
        })
      ]
    })
    expect(all.groups.map((g) => g.name)).toEqual(['Nicholas Desrosiers', 'Me'])
  })

  it('groups by person and sitting, newest first; a field changed twice reads first → last', () => {
    const out = buildRecapChanges({
      since: SINCE,
      viewerId: 'me',
      baseline,
      readable: null,
      fields,
      saves: [
        save({
          id: 1,
          timestamp: '2026-11-18T10:00:00Z',
          data: { ...baseline, amount: 150 },
          delta: { amount: 150 }
        }),
        save({
          id: 2,
          timestamp: '2026-11-18T10:05:00Z',
          data: { ...baseline, amount: 175 },
          delta: { amount: 175 }
        }),
        save({
          id: 3,
          timestamp: '2026-11-18T12:00:00Z',
          user_id: 'beth',
          name: 'Beth Ray',
          data: { ...baseline, amount: 175, title: 'B' },
          delta: { title: 'B' }
        })
      ]
    })
    expect(out.groups.map((g) => [g.name, g.saves])).toEqual([
      ['Beth Ray', 1],
      ['Nicholas Desrosiers', 2]
    ])
    expect(out.groups[1].changes).toEqual([
      { field: 'amount', has_before: true, before: 100, after: 175 }
    ])
  })

  it('drops a change put back within the sitting, and saves before `since`', () => {
    const out = buildRecapChanges({
      since: SINCE,
      viewerId: 'me',
      baseline: null,
      readable: null,
      fields,
      saves: [
        save({
          id: 1,
          timestamp: '2026-11-16T10:00:00Z',
          action: 'create',
          data: baseline,
          delta: baseline
        }),
        save({ id: 2, data: { ...baseline, title: 'X' }, delta: { title: 'X' } }),
        save({ id: 3, timestamp: '2026-11-18T10:01:00Z', data: baseline, delta: { title: 'Old' } })
      ]
    })
    expect(out.groups).toEqual([])
  })

  it('says when no earlier value is recorded', () => {
    const out = buildRecapChanges({
      since: SINCE,
      viewerId: 'me',
      baseline: null,
      readable: null,
      fields,
      saves: [save({ data: null, delta: { title: 'New' } })]
    })
    expect(out.groups[0].changes[0]).toEqual({
      field: 'title',
      has_before: false,
      before: null,
      after: 'New'
    })
  })
})

describe('plainValue', () => {
  it('turns rich text into words and cuts long values', () => {
    expect(plainValue('<p>Hello&nbsp;<b>world</b></p>')).toBe('Hello world')
    expect(String(plainValue('x'.repeat(400))).length).toBe(281)
    expect(plainValue(42)).toBe(42)
  })
})
