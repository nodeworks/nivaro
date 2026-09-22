import { describe, expect, it } from 'vitest'
import { pickInstance, splitStateField, stateKeysFromOps } from '../../../services/record-state.js'

describe('splitStateField', () => {
  it('removes $state and reports it', () => {
    expect(splitStateField(['id', '$state', 'name'])).toEqual({
      fields: ['id', 'name'],
      wantsState: true
    })
  })
  it('leaves other lists alone', () => {
    expect(splitStateField(['*'])).toEqual({ fields: ['*'], wantsState: false })
  })
})

describe('pickInstance', () => {
  const open = { id: 'a', item: '1', completed_at: null, started_at: new Date('2026-01-01') }
  const done = {
    id: 'b',
    item: '1',
    completed_at: new Date('2026-02-01'),
    started_at: new Date('2026-03-01')
  }
  it('prefers an open instance over a newer completed one', () => {
    expect(pickInstance([done, open])?.id).toBe('a')
  })
  it('falls back to the newest completed instance', () => {
    const older = { ...done, id: 'c', started_at: new Date('2025-01-01') }
    expect(pickInstance([older, done])?.id).toBe('b')
  })
})

describe('stateKeysFromOps', () => {
  it('reads _eq/_in as include and _neq/_nin as exclude', () => {
    expect(stateKeysFromOps({ _eq: 'started' })).toEqual({ include: ['started'], exclude: [] })
    expect(stateKeysFromOps({ _nin: ['completed', 'canceled'] })).toEqual({
      include: [],
      exclude: ['completed', 'canceled']
    })
  })
  it('drops non-string values', () => {
    expect(stateKeysFromOps({ _in: ['a', 5, ''] })).toEqual({ include: ['a'], exclude: [] })
  })
})
