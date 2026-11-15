import { describe, expect, it } from 'vitest'
import { lineLockMoves, lineLockView, lockRefusalHolder } from './line-locks'

describe('line locks — per-line view', () => {
  const locks = new Map([
    ['7', { is_mine: false, locked_by_name: 'Beth Ray' }],
    ['8', { is_mine: true, locked_by_name: 'Me' }],
    ['9', { is_mine: false, locked_by_name: null }]
  ])
  it('a line someone else holds is read-only and names them', () => {
    expect(lineLockView(locks, '7')).toEqual({ readOnly: true, by: 'Beth Ray' })
    expect(lineLockView(locks, '9')).toEqual({ readOnly: true, by: 'Someone' })
  })
  it('my own line and a free line stay editable', () => {
    expect(lineLockView(locks, '8').readOnly).toBe(false)
    expect(lineLockView(locks, '10').readOnly).toBe(false)
    expect(lineLockView(locks, null).readOnly).toBe(false)
  })
  it('a refused claim reads as held until the next read', () => {
    expect(lineLockView(new Map(), '3', new Map([['3', 'Kim']]))).toEqual({
      readOnly: true,
      by: 'Kim'
    })
  })
})

describe('line locks — moving between lines', () => {
  it('claims the line opened, releases the one left', () => {
    expect(lineLockMoves(null, '5')).toEqual({ release: null, claim: '5' })
    expect(lineLockMoves('5', '6')).toEqual({ release: '5', claim: '6' })
    expect(lineLockMoves('5', null)).toEqual({ release: '5', claim: null })
    expect(lineLockMoves('5', '5')).toEqual({ release: null, claim: null })
  })
  it('a new, unsaved line has no row to lock', () => {
    expect(lineLockMoves(null, 'new')).toEqual({ release: null, claim: null })
    expect(lineLockMoves('5', 'pending:0')).toEqual({ release: '5', claim: null })
  })
})

describe('lockRefusalHolder', () => {
  it('reads the holder from either client error shape', () => {
    expect(lockRefusalHolder({ response: { code: 'RECORD_LOCKED', locked_by_name: 'Beth' } })).toBe(
      'Beth'
    )
    expect(
      lockRefusalHolder({ response: { data: { code: 'RECORD_LOCKED', locked_by_name: null } } })
    ).toBeNull()
  })
  it('anything else is not a lock refusal', () => {
    expect(lockRefusalHolder(new Error('offline'))).toBeUndefined()
    expect(lockRefusalHolder({ response: { code: 'MIDAIR_COLLISION' } })).toBeUndefined()
  })
})
