import { describe, expect, it } from 'vitest'
import { fmtFigure, parseFigure, reconcilePatch } from './PlanGrid'

const row = { january: 100, february: 50, march: 0, april: 150 }
const open = ['february', 'march', 'april']

describe('parseFigure / fmtFigure', () => {
  it('reads what people type and paste', () => {
    expect(parseFigure('$1,234.50')).toBe(1234.5)
    expect(parseFigure('')).toBe(0)
    expect(parseFigure('—')).toBe(0)
    expect(parseFigure('(25)')).toBe(-25)
    expect(parseFigure('abc')).toBeNull()
  })
  it('prints whole amounts without cents and the rest with both', () => {
    expect(fmtFigure(1200)).toBe('$1,200')
    expect(fmtFigure(1200.5)).toBe('$1,200.50')
  })
})

describe('reconcilePatch', () => {
  it('moves the leftover to the next open period', () => {
    const r = reconcilePatch({
      row,
      column: 'january',
      actual: 60,
      openColumns: open,
      mode: 'next'
    })
    expect(r.patch).toEqual({ january: 60, february: 90 })
    expect(r.moved).toBe(40)
    expect(r.unabsorbed).toBe(0)
  })
  it('spreads evenly with the cent dust on the last period', () => {
    const r = reconcilePatch({ row, column: 'january', actual: 0, openColumns: open, mode: 'even' })
    expect(r.patch.february + r.patch.march + r.patch.april).toBeCloseTo(50 + 0 + 150 + 100, 2)
    expect(r.patch.march).toBeCloseTo(33.33, 2)
  })
  it('weights by the plan already there and skips empty periods', () => {
    const r = reconcilePatch({
      row,
      column: 'january',
      actual: 0,
      openColumns: open,
      mode: 'weighted'
    })
    expect(r.targets).toEqual(['february', 'april'])
    expect(r.patch.february).toBe(75)
    expect(r.patch.april).toBe(225)
  })
  it('takes a shortfall out without going below zero and reports the rest', () => {
    const r = reconcilePatch({
      row,
      column: 'january',
      actual: 400,
      openColumns: open,
      mode: 'next'
    })
    expect(r.patch.february).toBe(0)
    expect(r.unabsorbed).toBe(-250)
  })
  it('can drop the difference', () => {
    const r = reconcilePatch({
      row,
      column: 'january',
      actual: 60,
      openColumns: open,
      mode: 'none'
    })
    expect(r.patch).toEqual({ january: 60 })
  })
})
