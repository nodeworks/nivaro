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

describe('reconcilePatch across rows', () => {
  const closedYear = { january: 100, february: 50 }
  it('carries the leftover into the first open period of the next row', () => {
    const r = reconcilePatch({
      row: closedYear,
      column: 'february',
      actual: 20,
      openColumns: ['january', 'february'],
      mode: 'next',
      targetRow: { january: 10, february: 0 }
    })
    expect(r.patch).toEqual({ february: 20 })
    expect(r.targetPatch).toEqual({ january: 40 })
    expect(r.moved).toBe(30)
    expect(r.unabsorbed).toBe(0)
  })
  it('seeds a row that does not exist yet', () => {
    const r = reconcilePatch({
      row: closedYear,
      column: 'january',
      actual: 0,
      openColumns: ['january', 'february'],
      mode: 'weighted',
      targetRow: {}
    })
    expect(r.patch).toEqual({ january: 0 })
    expect(r.targetPatch).toEqual({ january: 50, february: 50 })
  })
  it('reports an overspend the next row cannot give back', () => {
    const r = reconcilePatch({
      row: closedYear,
      column: 'january',
      actual: 160,
      openColumns: ['january'],
      mode: 'next',
      targetRow: { january: 25 }
    })
    expect(r.targetPatch).toEqual({ january: 0 })
    expect(r.moved).toBe(-25)
    expect(r.unabsorbed).toBe(-35)
  })
  it('keeps the closed column alone when nothing moves', () => {
    const r = reconcilePatch({
      row: closedYear,
      column: 'january',
      actual: 60,
      openColumns: ['january'],
      mode: 'none',
      targetRow: {}
    })
    expect(r.patch).toEqual({ january: 60 })
    expect(r.targetPatch).toBeUndefined()
  })
})
