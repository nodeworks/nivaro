import { describe, expect, it } from 'vitest'
import { stateAspectEffect } from './live-state-aspect'

describe('stateAspectEffect (army 4 a06-1)', () => {
  it('a record entering the worklist off screen raises the updates pill', () => {
    expect(stateAspectEffect(false, false)).toEqual({ refresh: false, pill: 1, stats: true })
  })
  it('a row on screen, or any card on the board, refreshes in place', () => {
    expect(stateAspectEffect(true, false)).toEqual({ refresh: true, pill: 0, stats: true })
    expect(stateAspectEffect(false, true)).toEqual({ refresh: true, pill: 0, stats: true })
  })
})
