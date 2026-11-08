import { describe, expect, it } from 'vitest'
import { registerStagedRowLabel, stagedRowLabel } from './staged-row-labels'

describe('staged row labels', () => {
  it('names a row through the mounted grid, and forgets it on unmount', () => {
    const off = registerStagedRowLabel('forecasts', (id) =>
      id === '7917890' ? '2027 forecast' : null
    )
    expect(stagedRowLabel('forecasts', '7917890')).toBe('2027 forecast')
    expect(stagedRowLabel('forecasts', '1')).toBeNull()
    expect(stagedRowLabel('line_items', '7917890')).toBeNull()
    off()
    expect(stagedRowLabel('forecasts', '7917890')).toBeNull()
  })
})
