import { describe, expect, it } from 'vitest'
import { isPresencePageChange } from '../../../services/collection-live-mode.js'

describe('isPresencePageChange', () => {
  const prev = { current_path: '/records/workflows/1', app: null, last_seen: 'a' }

  it('is a move when the page or app really changed', () => {
    expect(isPresencePageChange('user_presence', { current_path: '/my-work' }, prev)).toBe(true)
    expect(isPresencePageChange('user_presence', { app: 'API' }, prev)).toBe(true)
  })

  it('is not when a heartbeat resends the same page, or writes other fields only', () => {
    expect(
      isPresencePageChange(
        'user_presence',
        { current_path: '/records/workflows/1', last_seen: 'b' },
        prev
      )
    ).toBe(false)
    expect(isPresencePageChange('user_presence', { last_seen: 'b', is_idle: true }, prev)).toBe(
      false
    )
    expect(isPresencePageChange('user_presence', { app: null }, prev)).toBe(false)
  })

  it('only ever applies to user_presence, with a previous row', () => {
    expect(isPresencePageChange('workflows', { current_path: '/x' }, prev)).toBe(false)
    expect(isPresencePageChange('user_presence', { current_path: '/x' }, undefined)).toBe(false)
  })
})
