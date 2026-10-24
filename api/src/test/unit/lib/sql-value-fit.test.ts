import { describe, expect, it } from 'vitest'
import { fitFilterOps, numberProblem, valueFitsSqlType } from '../../../lib/sql-value-fit.js'

describe('valueFitsSqlType', () => {
  it('judges ints by text and range', () => {
    expect(valueFitsSqlType('372783', 'int')).toBe(true)
    expect(valueFitsSqlType(5, 'int')).toBe(true)
    expect(valueFitsSqlType('abc', 'int')).toBe(false)
    expect(valueFitsSqlType('99999999999', 'int')).toBe(false)
    expect(valueFitsSqlType('99999999999', 'bigint')).toBe(true)
    expect(valueFitsSqlType(1e308, 'bigint')).toBe(false)
    expect(valueFitsSqlType(1.5, 'int')).toBe(false)
    expect(valueFitsSqlType('', 'int')).toBe(false)
    expect(valueFitsSqlType(null, 'int')).toBe(true)
  })

  it('judges uuids, decimals and bits; leaves other types alone', () => {
    expect(valueFitsSqlType('999999', 'uniqueidentifier')).toBe(false)
    expect(valueFitsSqlType('241FC3F9-C3C2-4BDB-B8B1-9E7BD12D5412', 'uniqueidentifier')).toBe(true)
    expect(valueFitsSqlType('12.50', 'decimal')).toBe(true)
    expect(valueFitsSqlType('1e3', 'float')).toBe(true)
    expect(valueFitsSqlType('twelve', 'decimal')).toBe(false)
    expect(valueFitsSqlType('true', 'bit')).toBe(true)
    expect(valueFitsSqlType('yes', 'bit')).toBe(false)
    expect(valueFitsSqlType('anything', 'nvarchar')).toBe(true)
    expect(valueFitsSqlType('abc', undefined)).toBe(true)
  })
})

describe('fitFilterOps', () => {
  it('turns an _eq the column cannot hold into a match on nothing', () => {
    const ops: Record<string, unknown> = { _eq: 'abc' }
    expect(fitFilterOps(ops, 'int')).toBeNull()
    expect(ops).toEqual({ _in: [] })
  })

  it('keeps the values of _in/_nin that can match, even next to a bad _eq', () => {
    const ops: Record<string, unknown> = { _in: ['372783', '999999999', 'abc'] }
    fitFilterOps(ops, 'int')
    expect(ops).toEqual({ _in: ['372783', '999999999'] })
    const both: Record<string, unknown> = { _in: ['1'], _eq: 'x' }
    fitFilterOps(both, 'int')
    expect(both._in).toEqual([])
    const nin: Record<string, unknown> = { _nin: ['abc', 2] }
    fitFilterOps(nin, 'int')
    expect(nin).toEqual({ _nin: [2] })
  })

  it('reads _neq of an impossible value as every non-null row', () => {
    const ops: Record<string, unknown> = { _neq: 'abc' }
    fitFilterOps(ops, 'uniqueidentifier')
    expect(ops).toEqual({ _nnull: true })
  })

  it('accepts any number as a range bound and refuses only what is not one', () => {
    const half: Record<string, unknown> = { _gt: 0.5 }
    expect(fitFilterOps(half, 'int')).toBeNull()
    expect(half).toEqual({ _gt: 0.5 })
    expect(fitFilterOps({ _lt: 1000 }, 'tinyint')).toBeNull()
    expect(fitFilterOps({ _between: [1, 3000000000] }, 'int')).toBeNull()
    const text: Record<string, unknown> = { _gte: '0.5', _between: ['1', '3000000000'] }
    expect(fitFilterOps(text, 'int')).toBeNull()
    expect(text).toEqual({ _gte: 0.5, _between: ['1', 3000000000] })
    const dec: Record<string, unknown> = { _gt: '12.3456789012345678' }
    fitFilterOps(dec, 'decimal')
    expect(dec._gt).toBe('12.3456789012345678')
    expect(fitFilterOps({ _gt: 'abc' }, 'int')).toBe('_gt')
    expect(fitFilterOps({ _between: [1, 'x'] }, 'decimal')).toBe('_between')
    expect(fitFilterOps({ _lt: '5' }, 'uniqueidentifier')).toBe('_lt')
    const ok: Record<string, unknown> = { _eq: '5', _gte: 2 }
    expect(fitFilterOps(ok, 'int')).toBeNull()
    expect(ok).toEqual({ _eq: '5', _gte: 2 })
    const plain: Record<string, unknown> = { _eq: 'abc' }
    fitFilterOps(plain, 'nvarchar')
    expect(plain).toEqual({ _eq: 'abc' })
  })

  it('keeps integer text exact on a bigint column', () => {
    const big: Record<string, unknown> = { _gt: '9007199254740993', _between: ['1', '2'] }
    expect(fitFilterOps(big, 'bigint')).toBeNull()
    expect(big).toEqual({ _gt: '9007199254740993', _between: ['1', '2'] })
    const over: Record<string, unknown> = { _lt: '99999999999999999999' }
    expect(fitFilterOps(over, 'bigint')).toBeNull()
    expect(typeof over._lt).toBe('number')
  })

  it('reads a _nin left empty as every non-null row, like NOT IN', () => {
    const ops: Record<string, unknown> = { _nin: ['abc'] }
    fitFilterOps(ops, 'int')
    expect(ops).toEqual({ _nnull: true })
  })
})

describe('numberProblem', () => {
  it('refuses what the driver or the column cannot take', () => {
    expect(numberProblem(1e308, { type: 'int' })).toBe('is too large')
    expect(numberProblem(1e308, { type: 'float' })).toBe('is too large')
    expect(numberProblem(Number.POSITIVE_INFINITY, { type: 'decimal' })).toBe(
      'must be a finite number'
    )
    expect(numberProblem(3_000_000_000, { type: 'int' })).toMatch(/^must be between/)
    expect(numberProblem('abc', { type: 'int' })).toBe('must be a number')
    expect(numberProblem(1e15, { type: 'decimal', precision: 18, scale: 4 })).toBe(
      'must be smaller than 100,000,000,000,000'
    )
  })

  it('lets ordinary values through', () => {
    expect(numberProblem(250, { type: 'int' })).toBeNull()
    expect(numberProblem('12.5', { type: 'decimal', precision: 18, scale: 4 })).toBeNull()
    expect(numberProblem(-500, { type: 'decimal', precision: 18, scale: 2 })).toBeNull()
    expect(numberProblem(null, { type: 'int' })).toBeNull()
    expect(numberProblem('', { type: 'int' })).toBeNull()
    expect(numberProblem('hello', { type: 'nvarchar' })).toBeNull()
    expect(numberProblem(5, undefined)).toBeNull()
    expect(numberProblem(true, { type: 'bit' })).toBeNull()
  })
})
