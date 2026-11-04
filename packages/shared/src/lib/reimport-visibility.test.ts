import { describe, expect, it } from 'vitest'
import { reimportAllowed } from './reimport-visibility'

const t = (states?: string[] | null, enabled = true) => ({ reimport: { enabled, states } })

describe('reimportAllowed', () => {
  it('needs the template enabled', () => {
    expect(reimportAllowed(t(undefined, false), 'a', true)).toBe(false)
    expect(reimportAllowed({}, 'a', true)).toBe(false)
  })
  it('allows any state when the list is empty or absent', () => {
    expect(reimportAllowed(t(), 'a', false)).toBe(true)
    expect(reimportAllowed(t([]), null, false)).toBe(true)
    expect(reimportAllowed(t(null), 'a', false)).toBe(true)
  })
  it('limits non-admins to the listed states', () => {
    expect(reimportAllowed(t(['started']), 'started', false)).toBe(true)
    expect(reimportAllowed(t(['started']), 'approved', false)).toBe(false)
    expect(reimportAllowed(t(['started']), null, false)).toBe(false)
  })
  it('never limits administrators', () => {
    expect(reimportAllowed(t(['started']), 'approved', true)).toBe(true)
  })
})
