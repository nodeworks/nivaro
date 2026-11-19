import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TABLE_STATE,
  mergeLocked,
  nextTableSort,
  pageRangeText,
  plainValueLines,
  tableFilterParams,
  tableStateFromParams,
  tableStateToParams
} from './activity-table'

const UID = '11111111-2222-3333-4444-555555555555'

describe('activity table state', () => {
  it('round-trips through the URL', () => {
    const state = {
      ...DEFAULT_TABLE_STATE,
      filters: {
        users: [UID],
        actions: ['update', 'delete'],
        actor_kinds: ['mcp' as const],
        fields: ['status'],
        range: 'today',
        undoable: true,
        group_key: 'g1'
      },
      sort: 'collection',
      page: 3,
      pageSize: 100,
      fold: false,
      entry: 42
    }
    const p = new URLSearchParams(tableStateToParams(state))
    expect(p.get('action')).toBe('update,delete')
    expect(p.get('t_sort')).toBe('collection')
    expect(tableStateFromParams(p)).toEqual(state)
  })

  it('reads junk as the defaults', () => {
    const s = tableStateFromParams(new URLSearchParams('t_sort=ip&t_page=-2&t_size=7&entry=x'))
    expect(s).toEqual(DEFAULT_TABLE_STATE)
  })

  it('a range wins over from/to in the params', () => {
    expect(tableFilterParams({ range: 'today', from: '2026-01-01' })).toEqual({ range: 'today' })
    expect(tableFilterParams({ records_only: true, undoable: false })).toEqual({
      records_only: '1'
    })
  })

  it('a locked preset bounds the person’s own picks', () => {
    const locked = {
      from: '2026-11-18T05:00:00Z',
      records_only: true,
      actions: ['create', 'update']
    }
    expect(mergeLocked({ range: 'last_7_days', actions: ['update', 'login'] }, locked)).toEqual({
      from: '2026-11-18T05:00:00Z',
      records_only: true,
      actions: ['update']
    })
    expect(mergeLocked({}, locked).actions).toEqual(['create', 'update'])
  })

  it('sorts When newest first, other columns A→Z first', () => {
    expect(nextTableSort('-when', 'collection')).toBe('collection')
    expect(nextTableSort('collection', 'collection')).toBe('-collection')
    expect(nextTableSort('-collection', 'collection')).toBe('collection')
    expect(nextTableSort('action', 'when')).toBe('-when')
    expect(nextTableSort('-when', 'when')).toBe('when')
  })

  it('says where the page sits', () => {
    expect(pageRangeText({ page: 2, pageSize: 50, shown: 50, total: 1234, hasMore: true })).toBe(
      '51–100 of 1,234'
    )
    expect(pageRangeText({ page: 1, pageSize: 50, shown: 50, total: null, hasMore: true })).toBe(
      '1–50 of more'
    )
    expect(pageRangeText({ page: 1, pageSize: 50, shown: 0, total: 0, hasMore: false })).toBe(
      'No entries'
    )
  })

  it('never shows a value as JSON', () => {
    expect(plainValueLines({ city: 'Ames', tags: ['a', 'b'] })).toEqual([
      'city: Ames',
      'tags: 2 values'
    ])
    expect(plainValueLines([1, { a: 1 }])).toEqual(['• 1', '• a: 1'])
    expect(plainValueLines(null)).toEqual(['empty'])
    expect(plainValueLines(true)).toEqual(['Yes'])
  })
})
