import { describe, expect, it } from 'vitest'
import { canonicalDmRoom, parseRoom } from '../../../services/chat.js'

describe('canonicalDmRoom', () => {
  it('uppercases the participants of a direct-message key, as the clients build it', () => {
    const a = '71d1a510-7e6b-4745-bcb8-0d427d2c6445'
    const b = '22222222-2222-4222-8222-222222222222'
    expect(canonicalDmRoom(`dm:${b}:${a}`)).toBe(`dm:${b.toUpperCase()}:${a.toUpperCase()}`)
    expect(parseRoom(canonicalDmRoom(`dm:${b}:${a}`)).kind).toBe('dm')
  })

  it('leaves every other key as sent', () => {
    for (const key of ['global', 'ch:ops-team', 'wf:CM26-1', 'p5:12', ''])
      expect(canonicalDmRoom(key)).toBe(key)
  })
})
