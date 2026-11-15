import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  noteUrgentChime,
  URGENT_SOUND_DEFER_MS,
  URGENT_SOUND_WINDOW_MS,
  urgentChimeJustPlayed
} from './notification-sound'
import { shouldChime, type UrgentChimeContext, urgentSoundOn } from './urgent-chime'

const base: UrgentChimeContext = {
  enabled: true,
  liveMode: 'normal',
  dnd: false,
  focus: false,
  huddle: false,
  recording: false,
  activated: true
}

describe('shouldChime', () => {
  it('chimes for an urgent arrival when the person asked for it', () => {
    expect(shouldChime({ urgent: true }, base)).toBe(true)
  })
  it('is off by default and only for urgent arrivals', () => {
    expect(shouldChime({ urgent: true }, { ...base, enabled: false })).toBe(false)
    expect(shouldChime({}, base)).toBe(false)
    expect(shouldChime({ urgent: 'yes' }, base)).toBe(false)
  })
  it('stays silent in quiet hours, Live updates Off, do not disturb, focus, huddles, recordings', () => {
    expect(shouldChime({ urgent: true, quiet: true }, base)).toBe(false)
    expect(shouldChime({ urgent: true }, { ...base, liveMode: 'off' })).toBe(false)
    expect(shouldChime({ urgent: true }, { ...base, dnd: true })).toBe(false)
    expect(shouldChime({ urgent: true }, { ...base, focus: true })).toBe(false)
    expect(shouldChime({ urgent: true }, { ...base, huddle: true })).toBe(false)
    expect(shouldChime({ urgent: true }, { ...base, recording: true })).toBe(false)
  })
  it('still chimes in Calm (a sound the person asked for is not a live-change effect)', () => {
    expect(shouldChime({ urgent: true }, { ...base, liveMode: 'calm' })).toBe(true)
  })
  it('never before the page was used (autoplay rules)', () => {
    expect(shouldChime({ urgent: true }, { ...base, activated: false })).toBe(false)
  })
})

describe('urgentSoundOn', () => {
  it('only an explicit true turns it on', () => {
    expect(urgentSoundOn({ urgent_sound: true })).toBe(true)
    expect(urgentSoundOn({ urgent_sound: 'true' })).toBe(false)
    expect(urgentSoundOn(null)).toBe(false)
  })
})

describe('one sound per arrival', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('the ordinary sound is skipped right after the urgent chime', () => {
    const now = Date.now()
    noteUrgentChime(now)
    expect(urgentChimeJustPlayed(now + URGENT_SOUND_DEFER_MS)).toBe(true)
    expect(urgentChimeJustPlayed(now + URGENT_SOUND_WINDOW_MS + 1)).toBe(false)
  })
})
