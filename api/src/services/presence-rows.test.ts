import { describe, expect, it } from 'vitest'
import { distinctViewerIds, parseWatchItems, rowsRoomName } from './presence-rows.js'

describe('presence rows helpers (#2486)', () => {
  it('names the watch room after the (tenant-scoped) record room', () => {
    expect(rowsRoomName('record:orders:12')).toBe('rows:record:orders:12')
    expect(rowsRoomName('t:acme:record:orders:12')).toBe('rows:t:acme:record:orders:12')
  })

  it('cleans watch items: strings and numbers, distinct, capped', () => {
    expect(parseWatchItems([1, '2', ' 2 ', null, {}, '', 3])).toEqual(['1', '2', '3'])
    expect(parseWatchItems('nope')).toEqual([])
    expect(parseWatchItems(Array.from({ length: 150 }, (_, i) => i)).length).toBe(100)
    expect(parseWatchItems(['x'.repeat(201)])).toEqual([])
  })

  it('collapses one person on several tabs to one id', () => {
    expect(distinctViewerIds([{ id: 'A1' }, { id: 'a1' }, { id: 'B2' }])).toEqual(['A1', 'B2'])
    expect(distinctViewerIds(undefined)).toEqual([])
  })
})
