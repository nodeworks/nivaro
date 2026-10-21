import { describe, expect, it } from 'vitest'
import { MESH_OVERLAP_MS, socketFromIdentity } from './huddle-sfu'

describe('huddle-sfu (#2859)', () => {
  it('maps a LiveKit identity back to the socket id the roster keys on', () => {
    expect(socketFromIdentity('U-ROB#S1')).toBe('S1')
    expect(socketFromIdentity('a#b#S9')).toBe('S9')
    expect(socketFromIdentity('legacy')).toBe('legacy')
  })

  it('keeps the mesh open for at most three seconds after the switch', () => {
    expect(MESH_OVERLAP_MS).toBe(3000)
  })
})
