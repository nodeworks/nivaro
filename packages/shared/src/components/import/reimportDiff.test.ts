import { describe, expect, it } from 'vitest'
import { diffReimportLines, reimportPendingNotice, reimportRestoredDeletes } from './reimportDiff'

describe('diffReimportLines', () => {
  it('replace deletes all existing rows and creates all file rows', () => {
    const fileRows = [{ sku: 'a' }, { sku: 'b' }]
    const existingRows = [
      { id: 'e1', sku: 'x' },
      { id: 'e2', sku: 'y' }
    ]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'replace',
      match_by: []
    })
    expect(result.deletes.sort()).toEqual(['e1', 'e2'])
    expect(result.creates).toEqual(fileRows)
    expect(result.updates).toEqual([])
    expect(result.matchedUnchanged).toBe(0)
  })

  it('append creates every file row with no updates or deletes', () => {
    const fileRows = [{ sku: 'a' }, { sku: 'b' }]
    const existingRows = [{ id: 'e1', sku: 'a' }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'append',
      match_by: ['sku']
    })
    expect(result.creates).toEqual(fileRows)
    expect(result.updates).toEqual([])
    expect(result.deletes).toEqual([])
    expect(result.matchedUnchanged).toBe(0)
  })

  it('upsert counts matched rows with no differing columns as matchedUnchanged', () => {
    const fileRows = [{ sku: 'a', qty: 5 }]
    const existingRows = [{ id: 'e1', sku: 'a', qty: 5 }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.matchedUnchanged).toBe(1)
    expect(result.updates).toEqual([])
    expect(result.creates).toEqual([])
    expect(result.deletes).toEqual([])
  })

  it('upsert minimizes updates to only the differing columns present in the file row', () => {
    const fileRows = [{ sku: 'a', qty: 9, label: 'same' }]
    const existingRows = [{ id: 'e1', sku: 'a', qty: 5, label: 'same', extra: 'untouched' }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.updates).toEqual([{ id: 'e1', changes: { qty: 9 } }])
    expect(result.matchedUnchanged).toBe(0)
  })

  it('upsert_delete deletes unmatched existing rows and creates unmatched file rows', () => {
    const fileRows = [{ sku: 'a', qty: 1 }]
    const existingRows = [
      { id: 'e1', sku: 'a', qty: 1 },
      { id: 'e2', sku: 'gone', qty: 2 }
    ]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert_delete',
      match_by: ['sku']
    })
    expect(result.deletes).toEqual(['e2'])
    expect(result.matchedUnchanged).toBe(1)
    expect(result.creates).toEqual([])
  })

  it('upsert treats numeric strings and numbers as equal', () => {
    const fileRows = [{ sku: 'a', qty: '26' }]
    const existingRows = [{ id: 'e1', sku: 'a', qty: 26 }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.matchedUnchanged).toBe(1)
    expect(result.updates).toEqual([])
  })

  it('upsert treats numeric strings with trailing zero decimals as equal', () => {
    const fileRows = [{ sku: 'a', qty: '26.0' }]
    const existingRows = [{ id: 'e1', sku: 'a', qty: 26 }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.matchedUnchanged).toBe(1)
    expect(result.updates).toEqual([])
  })

  it('upsert trims whitespace before comparing non-numeric values', () => {
    const fileRows = [{ sku: 'a', label: '  same  ' }]
    const existingRows = [{ id: 'e1', sku: 'a', label: 'same' }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.matchedUnchanged).toBe(1)
    expect(result.updates).toEqual([])
  })

  it('throws on duplicate match keys among file rows in upsert mode', () => {
    const fileRows = [
      { sku: 'a', qty: 1 },
      { sku: 'a', qty: 2 }
    ]
    const existingRows = [{ id: 'e1', sku: 'a', qty: 1 }]
    expect(() =>
      diffReimportLines(fileRows, existingRows, { lines: 'upsert', match_by: ['sku'] })
    ).toThrow('Duplicate match key: a')
  })

  it('throws on duplicate match keys among file rows in upsert_delete mode', () => {
    const fileRows = [
      { sku: 'a', qty: 1 },
      { sku: 'a', qty: 2 }
    ]
    const existingRows: Record<string, unknown>[] = []
    expect(() =>
      diffReimportLines(fileRows, existingRows, { lines: 'upsert_delete', match_by: ['sku'] })
    ).toThrow('Duplicate match key: a')
  })

  it('empty file rows with upsert_delete deletes every existing row', () => {
    const fileRows: Record<string, unknown>[] = []
    const existingRows = [
      { id: 'e1', sku: 'a' },
      { id: 'e2', sku: 'b' }
    ]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert_delete',
      match_by: ['sku']
    })
    expect(result.deletes.sort()).toEqual(['e1', 'e2'])
    expect(result.creates).toEqual([])
    expect(result.updates).toEqual([])
    expect(result.matchedUnchanged).toBe(0)
  })

  it('empty existing rows creates every file row under upsert', () => {
    const fileRows = [{ sku: 'a' }, { sku: 'b' }]
    const existingRows: Record<string, unknown>[] = []
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.creates).toEqual(fileRows)
    expect(result.updates).toEqual([])
    expect(result.deletes).toEqual([])
    expect(result.matchedUnchanged).toBe(0)
  })

  it('upsert treats empty string vs zero as unequal and stages an update', () => {
    const fileRows = [{ sku: 'a', qty: '' }]
    const existingRows = [{ id: 'e1', sku: 'a', qty: '0' }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.updates).toEqual([{ id: 'e1', changes: { qty: '' } }])
    expect(result.matchedUnchanged).toBe(0)
  })

  it('upsert treats empty string vs empty string as equal', () => {
    const fileRows = [{ sku: 'a', qty: '' }]
    const existingRows = [{ id: 'e1', sku: 'a', qty: '' }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.matchedUnchanged).toBe(1)
    expect(result.updates).toEqual([])
  })

  it('upsert treats string zero vs number zero as equal', () => {
    const fileRows = [{ sku: 'a', qty: '0' }]
    const existingRows = [{ id: 'e1', sku: 'a', qty: 0 }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.matchedUnchanged).toBe(1)
    expect(result.updates).toEqual([])
  })

  it('throws on duplicate match keys among existing rows in upsert modes', () => {
    const fileRows = [{ sku: 'a', qty: 1 }]
    const existingRows = [
      { id: 'e1', sku: 'a', qty: 1 },
      { id: 'e2', sku: 'a', qty: 2 }
    ]
    expect(() =>
      diffReimportLines(fileRows, existingRows, { lines: 'upsert_delete', match_by: ['sku'] })
    ).toThrow('Duplicate match key among existing lines: a')
  })

  it('matches a file row and existing row whose match_by columns are all empty', () => {
    const fileRows = [{ sku: '', qty: 5 }]
    const existingRows = [{ id: 'e1', sku: null, qty: 3 }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.updates).toEqual([{ id: 'e1', changes: { qty: 5 } }])
    expect(result.creates).toEqual([])
    expect(result.matchedUnchanged).toBe(0)
  })

  it('ignores __o2m_ keys when comparing matched rows but keeps them on creates', () => {
    const fileRows = [
      { sku: 'a', qty: 5, __o2m_members: [{ name: 'x' }] },
      { sku: 'new', qty: 1, __o2m_members: [{ name: 'y' }] }
    ]
    const existingRows = [{ id: 'e1', sku: 'a', qty: 5 }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.matchedUnchanged).toBe(1)
    expect(result.updates).toEqual([])
    expect(result.creates).toEqual([{ sku: 'new', qty: 1, __o2m_members: [{ name: 'y' }] }])
  })

  it('upsert matches a numeric match key across file/DB format drift instead of delete+create', () => {
    const fileRows = [{ item_no: '26.0', label: 'widget' }]
    const existingRows = [{ id: 'e1', item_no: 26, label: 'widget' }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['item_no']
    })
    expect(result.creates).toEqual([])
    expect(result.deletes).toEqual([])
    expect(result.matchedUnchanged).toBe(1)
    expect(result.updates).toEqual([])
  })

  it('upsert_delete matches a numeric match key across format drift and preserves the line id', () => {
    const fileRows = [{ item_no: '26.0', label: 'updated' }]
    const existingRows = [{ id: 'e1', item_no: 26, label: 'widget' }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert_delete',
      match_by: ['item_no']
    })
    expect(result.creates).toEqual([])
    expect(result.deletes).toEqual([])
    expect(result.updates).toEqual([{ id: 'e1', changes: { label: 'updated' } }])
  })

  it('upsert leaves non-numeric match keys unaffected by the numeric canonicalization rule', () => {
    const fileRows = [{ sku: 'abc', label: 'widget' }]
    const existingRows = [{ id: 'e1', sku: 'abc', label: 'widget' }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.matchedUnchanged).toBe(1)
    expect(result.creates).toEqual([])
  })

  it('upsert leaves an empty match-key component unchanged by the numeric canonicalization rule', () => {
    const fileRows = [{ sku: '', label: 'widget' }]
    const existingRows = [{ id: 'e1', sku: null, label: 'widget' }]
    const result = diffReimportLines(fileRows, existingRows, {
      lines: 'upsert',
      match_by: ['sku']
    })
    expect(result.matchedUnchanged).toBe(1)
    expect(result.creates).toEqual([])
  })
})

// army 10 item 3 (BLOCKER): on an IR, remove a material line on the form
// (unsaved), then BOM Re-Upload a file that still lists it. The form asked
// "Unsaved changes will be combined…" through window.confirm — a native modal
// the page blocks on, which an automated tab can never answer, so the tab
// froze for good. The review dialog now carries that note itself, and the
// removed line the file still lists comes back instead of being deleted AND
// edited in one save.
describe('reimportRestoredDeletes', () => {
  const existing = [
    { id: '163117', cifa: 39767, quantity: 3 },
    { id: '163118', cifa: 53580, quantity: 20 },
    { id: '163119', cifa: 40900, quantity: 2 }
  ]

  it('a line removed on the form that the file still lists comes back', () => {
    const file = [{ cifa: '39767', quantity: 4 }]
    expect(reimportRestoredDeletes(file, existing, ['cifa'], new Set(['163117']))).toEqual([
      '163117'
    ])
  })

  it('a removed line the file no longer lists stays removed', () => {
    const file = [{ cifa: 53580, quantity: 20 }]
    expect(reimportRestoredDeletes(file, existing, ['cifa'], new Set(['163117']))).toEqual([])
  })

  it('nothing staged, or no match key = nothing to restore', () => {
    const file = [{ cifa: 39767, quantity: 4 }]
    expect(reimportRestoredDeletes(file, existing, ['cifa'], new Set())).toEqual([])
    expect(reimportRestoredDeletes(file, existing, [], new Set(['163117']))).toEqual([])
  })

  it('the diff still pairs the removed line as an update, never a second create', () => {
    const file = [{ cifa: '39767', quantity: 4 }]
    const diff = diffReimportLines(file, existing, { lines: 'upsert', match_by: ['cifa'] })
    expect(diff.updates).toEqual([{ id: '163117', changes: { quantity: 4 } }])
    expect(diff.creates).toEqual([])
  })
})

describe('reimportPendingNotice', () => {
  it('says nothing when the record has no unsaved work', () => {
    expect(
      reimportPendingNotice({
        headerDirty: false,
        pendingRows: 0,
        pendingEdits: 0,
        pendingDeletes: 0,
        restored: 0
      })
    ).toBeNull()
  })

  it('names the unsaved work and the line that comes back', () => {
    const one = reimportPendingNotice({
      headerDirty: false,
      pendingRows: 0,
      pendingEdits: 0,
      pendingDeletes: 1,
      restored: 1
    })
    expect(one).toContain('stay in place')
    expect(one).toContain('One line you removed is still in the file')
    const two = reimportPendingNotice({
      headerDirty: true,
      pendingRows: 0,
      pendingEdits: 0,
      pendingDeletes: 2,
      restored: 2
    })
    expect(two).toContain('2 lines you removed')
  })

  it('a removed line the file dropped is not promised back', () => {
    const note = reimportPendingNotice({
      headerDirty: false,
      pendingRows: 0,
      pendingEdits: 0,
      pendingDeletes: 1,
      restored: 0
    })
    expect(note).toContain('stay in place')
    expect(note).not.toContain('comes back')
  })
})
