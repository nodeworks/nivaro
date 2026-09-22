import { describe, expect, it } from 'vitest'
import { isMigrationLockedError } from '../../../db/migration-lock.js'

describe('isMigrationLockedError', () => {
  it('recognises knex MigrationLocked by name', () => {
    expect(isMigrationLockedError({ name: 'MigrationLocked', message: 'x' })).toBe(true)
  })
  it('recognises it by message when the name is lost', () => {
    expect(isMigrationLockedError(new Error('Migration table is already locked'))).toBe(true)
  })
  it('leaves other errors alone', () => {
    expect(isMigrationLockedError(new Error('Invalid object name'))).toBe(false)
    expect(isMigrationLockedError(null)).toBe(false)
  })
})
