import { describe, expect, it } from 'vitest'
import { mysqlTypeCast } from '../../../db/mysql-session.js'

const field = (type: string, length: number, value: string | null) => ({
  type,
  length,
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
})
