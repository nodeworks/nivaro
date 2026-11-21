import { describe, expect, it } from 'vitest'
import { mysqlTypeCast } from '../../../db/mysql-session.js'

const field = (type: string, length: number, value: string | null, table = '') => ({
  type,
  length,
  table,
  string: () => value
})

describe('mysqlTypeCast', () => {
  it('reads TINYINT(1) as true / false and keeps NULL', () => {
    const next = () => 'driver'
    expect(mysqlTypeCast(field('TINY', 1, '1'), next)).toBe(true)
    expect(mysqlTypeCast(field('TINY', 1, '0'), next)).toBe(false)
    expect(mysqlTypeCast(field('TINY', 1, null), next)).toBeNull()
  })
  it('leaves every other column to the driver (a plain TINYINT, an INT)', () => {
    const next = () => 'driver'
    expect(mysqlTypeCast(field('TINY', 4, '3'), next)).toBe('driver')
    expect(mysqlTypeCast(field('LONG', 1, '1'), next)).toBe('driver')
  })
  it('reads DECIMAL as a number (like SQL Server) and keeps NULL', () => {
    const next = () => 'driver'
    expect(mysqlTypeCast(field('NEWDECIMAL', 10, '12.50'), next)).toBe(12.5)
    expect(mysqlTypeCast(field('NEWDECIMAL', 10, '-0.25'), next)).toBe(-0.25)
    expect(mysqlTypeCast(field('NEWDECIMAL', 10, null), next)).toBeNull()
  })
  it("reads a BIGINT column as its digits (like SQL Server); a computed BIGINT stays the driver's", () => {
    const next = () => 'driver'
    expect(mysqlTypeCast(field('LONGLONG', 20, '9007199254740993', 't'), next)).toBe(
      '9007199254740993'
    )
    expect(mysqlTypeCast(field('LONGLONG', 20, null, 't'), next)).toBeNull()
    expect(mysqlTypeCast(field('LONGLONG', 21, '5'), next)).toBe('driver')
  })
})
