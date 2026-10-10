import { describe, expect, it } from 'vitest'
import { stuckText } from './presence-state'

describe('stuckText', () => {
  it('says where and for how long', () => {
    expect(stuckText({ minutes: 12, label: 'CM26-80332' })).toBe('stuck on CM26-80332 for 12m')
    expect(stuckText({ minutes: 75.9, label: null })).toBe('stuck for 1h 15m')
  })
})
