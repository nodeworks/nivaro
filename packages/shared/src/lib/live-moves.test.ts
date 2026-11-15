import { describe, expect, it } from 'vitest'
import { MOVES_GAP_MS, movesMayChange, nextMovesRefresh } from './live-moves'

describe('movesMayChange', () => {
  it('re-reads moves for column writes, unknown writes and move-relevant aspects', () => {
    expect(movesMayChange({ changedFields: ['po_number'], deleted: false })).toBe(true)
    expect(movesMayChange({ changedFields: null, deleted: false })).toBe(true)
    for (const a of ['$state', '$integrations', '$related', '$addendums', '$owners'])
      expect(movesMayChange({ changedFields: [a], deleted: false })).toBe(true)
  })
  it('ignores notices that cannot change a move, and deletes', () => {
    expect(movesMayChange({ changedFields: ['$comments', '$tasks'], deleted: false })).toBe(false)
    expect(movesMayChange({ changedFields: ['$lock'], deleted: false })).toBe(false)
    expect(movesMayChange({ changedFields: ['$sla'], deleted: false })).toBe(false)
    expect(movesMayChange({ changedFields: ['amount'], deleted: true })).toBe(false)
  })
})

describe('nextMovesRefresh — one re-read per record per gap', () => {
  it('runs now the first time, then no sooner than the gap', () => {
    expect(nextMovesRefresh(undefined, 1000)).toBe(1000)
    expect(nextMovesRefresh(1000, 1200)).toBe(1000 + MOVES_GAP_MS)
    expect(nextMovesRefresh(1000, 1000 + MOVES_GAP_MS + 5)).toBe(1000 + MOVES_GAP_MS + 5)
  })
})
