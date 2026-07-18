import { describe, expect, it } from 'vitest'
import { diffReimportLines } from './reimportDiff'

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
})
