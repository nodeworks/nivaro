import { describe, expect, it } from 'vitest'
import {
  draftDiffers,
  everyShownFieldLocked,
  lineConflictKey,
  lineLabelOf,
  liveCrossFieldErrors,
  o2mCountIsStale,
  refusalStepText,
  resolveLineCollision,
  withRowBaseRevision
} from './ItemEditForm'

// army4 P2 — line-grid concurrency, locks, form save.

describe('a10-3: a staged line PATCH carries the revision its edit was based on', () => {
  it('adds _base_revision when known', () => {
    expect(withRowBaseRevision({ quantity: 103 }, 9001)).toEqual({
      quantity: 103,
      _base_revision: 9001
    })
  })

  it('leaves the body alone without a usable base (older behaviour)', () => {
    const body = { quantity: 103 }
    expect(withRowBaseRevision(body, null)).toBe(body)
    expect(withRowBaseRevision(body, undefined)).toBe(body)
    expect(withRowBaseRevision(body, 0)).toBe(body)
    expect(withRowBaseRevision(body, Number.NaN)).toBe(body)
  })

  it('"Theirs" fields leave the staged edit; nothing left = no staged edit', () => {
    const staged = { quantity: 103, notes: 'mine', _change_reason: 'fix' }
    expect(resolveLineCollision(staged, new Set(['quantity']))).toEqual({
      notes: 'mine',
      _change_reason: 'fix'
    })
    expect(resolveLineCollision(staged, new Set(['quantity', 'notes']))).toBeNull()
    // Staged grandchild ops are still work to do.
    expect(
      resolveLineCollision({ quantity: 1, __nested_ops_x: { created: [] } }, new Set(['quantity']))
    ).toEqual({ __nested_ops_x: { created: [] } })
    expect(resolveLineCollision({ quantity: 1 }, new Set())).toEqual({ quantity: 1 })
  })

  it('names a line by its line number, else its position', () => {
    const rows = [{ id: 10, line_number: 4 }, { id: 11 }]
    expect(lineLabelOf(rows, '10')).toBe('Line 4')
    expect(lineLabelOf(rows, '11')).toBe('Line 2')
    expect(lineLabelOf(rows, '99')).toBe('Row 99')
  })

  it('keeps one chooser key per line and field', () => {
    const a = lineConflictKey({ key: 'wli.workflow', rowId: '1' }, 'quantity')
    const b = lineConflictKey({ key: 'wli.workflow', rowId: '2' }, 'quantity')
    expect(a).not.toBe(b)
  })
})

describe('a10-1: a line the grid shows counts toward "at least one line"', () => {
  const lines = ['o2m-rows', 'wli', 'workflow', '372933']
  it('an unfiltered read that disagrees with the count makes it stale', () => {
    expect(o2mCountIsStale(lines, '372933', [], [{ id: 1 }])).toBe(true)
    expect(o2mCountIsStale(lines, '372933', [{ id: 1 }], [{ id: 1 }])).toBe(false)
  })

  it('a filtered grid proves it only when it shows MORE rows than the count', () => {
    const filtered = [...lines, '{"type":"goods"}']
    expect(o2mCountIsStale(filtered, '372933', [], [{ id: 1 }])).toBe(true)
    expect(o2mCountIsStale(filtered, '372933', [{ id: 1 }, { id: 2 }], [{ id: 1 }])).toBe(false)
  })

  it('never the count itself, another record, or a count still loading', () => {
    expect(o2mCountIsStale([...lines, ''], '372933', [], [{ id: 1 }])).toBe(false)
    expect(o2mCountIsStale(lines, '1', [], [{ id: 1 }])).toBe(false)
    expect(o2mCountIsStale(lines, '372933', undefined, [{ id: 1 }])).toBe(false)
  })
})

describe('a01-8: a refused line reads "Line 1", not workflow_lines[0]', () => {
  it('names the grid and the line', () => {
    expect(
      refusalStepText(
        { field: 'workflow_lines', message: 'Line 1: Amount must be smaller than 10,000,000,000' },
        [{ field: 'workflow_lines', label: 'PO / REQ Lines' }]
      )
    ).toBe('PO / REQ Lines — Line 1: Amount must be smaller than 10,000,000,000')
  })
})

describe('a07-4: a form with every field locked offers no Save', () => {
  const fields = [
    { field: 'id' },
    { field: 'description' },
    { field: 'type' },
    { field: 'secret', hidden: true }
  ]
  it('all shown fields locked = true; one open field = false; a new record never', () => {
    expect(everyShownFieldLocked(false, fields, () => true)).toBe(true)
    expect(everyShownFieldLocked(false, fields, (f) => f !== 'type')).toBe(false)
    expect(everyShownFieldLocked(true, fields, () => true)).toBe(false)
    expect(everyShownFieldLocked(false, [], () => true)).toBe(false)
  })
})

describe('a01-10: typing the saved value back leaves the form clean', () => {
  it('compares as saved: "" is empty, "2.50" is 2.5', () => {
    expect(draftDiffers({ note: '' }, { note: null })).toBe(false)
    expect(draftDiffers({ price: '2.50' }, { price: 2.5 })).toBe(false)
    expect(draftDiffers({ price: 2.5 }, { price: '2.5' })).toBe(false)
    expect(draftDiffers({ price: 2.6 }, { price: 2.5 })).toBe(true)
    expect(draftDiffers({ note: 'x' }, { note: null })).toBe(true)
    expect(draftDiffers({ __meta: 1 }, {})).toBe(false)
  })
})

describe('a01-4: Service End before Start shows as soon as both are set', () => {
  const fields = [
    { field: 'service_start', label: 'Service Start', type: 'date' },
    {
      field: 'service_end',
      label: 'Service End',
      type: 'date',
      validation_rules: JSON.stringify([
        {
          type: 'gte_field',
          field: 'service_start',
          message: 'Service End must be on or after Service Start'
        }
      ])
    }
  ]
  it('flags the end when it falls before the start, from either side', () => {
    const draft = { service_start: '2026-12-01', service_end: '2026-01-01' }
    expect(liveCrossFieldErrors(fields, draft, 'service_end')).toEqual({
      service_end: 'Service End must be on or after Service Start'
    })
    expect(liveCrossFieldErrors(fields, draft, 'service_start')).toEqual({
      service_end: 'Service End must be on or after Service Start'
    })
  })

  it('clears once fixed, says nothing while a side is empty, ignores other fields', () => {
    expect(
      liveCrossFieldErrors(
        fields,
        { service_start: '2026-01-01', service_end: '2026-12-01' },
        'service_end'
      )
    ).toEqual({ service_end: null })
    expect(
      liveCrossFieldErrors(
        fields,
        { service_start: '2026-12-01', service_end: null },
        'service_start'
      )
    ).toEqual({ service_end: null })
    expect(liveCrossFieldErrors(fields, {}, 'notes')).toEqual({})
  })
})
