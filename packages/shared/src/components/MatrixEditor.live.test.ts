import { describe, expect, it } from 'vitest'
import { matrixCellNote, matrixSaveStatus } from './MatrixEditor'

// E11 (realtime gaps 2026-11-17): Manage Allocations was not live and its absolute saves wrote
// over another planner's numbers with nothing said.
const fmt = (v: number) => v.toLocaleString('en-US')

describe('matrixCellNote', () => {
  it('a typed cell whose saved value moved since the person started says so', () => {
    expect(matrixCellNote(false, undefined, 100, 250, true, fmt)).toBe(
      'Someone else changed this from 100 to 250 since you started.'
    )
  })
  it('nothing to say when the value did not move, or the cell holds no typing', () => {
    expect(matrixCellNote(false, undefined, 100, 100, true, fmt)).toBeNull()
    expect(matrixCellNote(false, undefined, 100, 250, false, fmt)).toBeNull()
    expect(matrixCellNote(false, undefined, undefined, 250, true, fmt)).toBeNull()
  })
  it('a save that met a newer save names their value', () => {
    expect(matrixCellNote(true, 1200, 100, 1200, true, fmt)).toMatch(/Someone else saved 1,200/)
    expect(matrixCellNote(true, null, 100, 0, true, fmt)).toMatch(/saved empty/)
  })
})

describe('matrixSaveStatus', () => {
  it('says what landed and what met someone else', () => {
    expect(matrixSaveStatus(2, 1, 0)).toBe('Saved — 2 updated, 1 created')
    expect(matrixSaveStatus(1, 0, 2)).toMatch(/2 cells were changed by someone else/)
  })
})
