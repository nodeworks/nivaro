import { describe, expect, it } from 'vitest'
import { MESH_OVERLAP_MS, routeSfuTrack, socketFromIdentity } from './huddle-sfu'

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

describe('routeSfuTrack (#2858)', () => {
  it('sends a camera to the camera tile and a screen share to the screen slot', () => {
    expect(routeSfuTrack('video', 'camera')).toBe('camera')
    expect(routeSfuTrack('video', 'screen_share')).toBe('screen')
    expect(routeSfuTrack('audio', 'microphone')).toBe('mic')
  })

  it('never lets screen audio replace a voice; an unlabelled video stays a screen', () => {
    expect(routeSfuTrack('audio', 'screen_share_audio')).toBeNull()
    expect(routeSfuTrack('video', 'unknown')).toBe('screen')
    expect(routeSfuTrack('video', 'microphone')).toBeNull()
    expect(routeSfuTrack('unknown', 'camera')).toBeNull()
  })
})
