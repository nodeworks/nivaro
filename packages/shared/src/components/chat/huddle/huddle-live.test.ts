import { describe, expect, it } from 'vitest'
import { liveLookups } from './huddle-live'

describe('liveLookups', () => {
  const l = liveLookups([
    { room: 'ch:ops', label: 'Ops', count: 2, users: ['aa', 'BB'] },
    { room: 'tasks:9', label: '9', count: 1, users: ['cc'] }
  ])
  it('counts per room', () => {
    expect(l.countFor('ch:ops')).toBe(2)
    expect(l.countFor('ch:none')).toBe(0)
    expect(l.countFor(null)).toBe(0)
  })
  it('finds the huddle a person is in, case-insensitively', () => {
    expect(l.roomOf('bb')?.label).toBe('Ops')
    expect(l.roomOf('zz')).toBeNull()
  })
})
