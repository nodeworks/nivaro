import { describe, expect, it } from 'vitest'
import { recordingShareLink } from './ShareRecordingLink'

const ID = 'CA916B8A-F62C-444A-90EE-264EB0FDE9DA'
const ORIGIN = 'https://efp-staging-api.cable.example.com'

describe('recordingShareLink', () => {
  it('links the replay page to the recording', () => {
    expect(recordingShareLink(ORIGIN, ID)).toBe(`${ORIGIN}/analytics/replays?recording=${ID}`)
  })

  it('adds the playhead as ?t= in whole milliseconds', () => {
    expect(recordingShareLink(ORIGIN, ID, 295_400.6)).toBe(
      `${ORIGIN}/analytics/replays?recording=${ID}&t=295401`
    )
  })

  it('leaves out a playhead at the start or unknown', () => {
    for (const at of [0, null, undefined, Number.NaN, -5]) {
      expect(recordingShareLink(ORIGIN, ID, at)).not.toContain('t=')
    }
  })
})
