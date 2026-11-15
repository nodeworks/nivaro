// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { pillPlacement } from './ScreenShare'

const rect = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom
})

describe('sharing pill placement', () => {
  it('floats bottom-centre when nothing is open', () => {
    expect(pillPlacement([], 1600, 1000)).toEqual({ kind: 'free' })
    // A dialog that ends well above the bottom does not matter.
    expect(pillPlacement([rect(500, 200, 1100, 600)], 1600, 1000)).toEqual({ kind: 'free' })
  })

  it('moves beside a side sheet (the sheet keeps its actions)', () => {
    expect(pillPlacement([rect(1040, 0, 1600, 1000)], 1600, 1000)).toEqual({
      kind: 'beside',
      left: 0,
      width: 1040
    })
    expect(pillPlacement([rect(0, 0, 420, 1000)], 1600, 1000)).toEqual({
      kind: 'beside',
      left: 420,
      width: 1180
    })
  })

  it('sits above a bottom sheet or a dialog footer that reaches the bottom', () => {
    expect(pillPlacement([rect(0, 640, 390, 844)], 390, 844)).toEqual({
      kind: 'above',
      bottom: 844 - 640 + 12
    })
  })

  it('folds to its dot when a sheet fills the screen', () => {
    expect(pillPlacement([rect(0, 0, 390, 844)], 390, 844)).toEqual({ kind: 'covered' })
  })
})
