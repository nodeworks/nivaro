// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_PRESET,
  forgetHandoff,
  frameNote,
  HANDOFF_MAX_AGE_MS,
  handoffKey,
  outerSizeFor,
  popupFeatures,
  presetById,
  type RecordingHandoff,
  readWindowPref,
  recordingUrl,
  takeHandoff,
  takeResult,
  tokenFromSearch,
  WINDOW_PRESETS,
  withoutRecordParam,
  writeHandoff,
  writeResult,
  writeWindowPref
} from './recordingWindow'

// Recording window at a fixed size (#1516): the presets and the remembered
// choice, the popup's URL and features, the handoff the opener leaves for the
// popup, the result the popup leaves for the opener, and the size maths.

beforeEach(() => window.localStorage.clear())

const handoff = (over: Partial<RecordingHandoff> = {}): RecordingHandoff => ({
  v: 1,
  token: 'tok-1234567',
  at: 1_000_000,
  size: { w: 1280, h: 800 },
  options: { useMic: true, micId: 'default', captureClicks: true, cleanScreen: true, script: '' },
  ...over
})

describe('presets and the remembered choice', () => {
  it('offers three sizes and falls back to the first', () => {
    expect(WINDOW_PRESETS.map((p) => p.id)).toEqual(['1280x800', '1440x900', '1920x1080'])
    expect(presetById('1920x1080')).toMatchObject({ w: 1920, h: 1080 })
    expect(presetById('9x9').id).toBe(DEFAULT_WINDOW_PRESET)
    expect(presetById(null).id).toBe(DEFAULT_WINDOW_PRESET)
  })
  it('remembers the last choice per browser, never an unknown one', () => {
    expect(readWindowPref()).toBe('1280x800')
    writeWindowPref('1440x900')
    expect(readWindowPref()).toBe('1440x900')
    writeWindowPref('nope')
    expect(readWindowPref()).toBe('1280x800')
  })
})

describe('the popup', () => {
  it('is a popup of the inner size asked for', () => {
    expect(popupFeatures({ w: 1440, h: 900 })).toBe('popup,width=1440,height=900')
  })
  it('opens the same page with the token, which can be read and removed again', () => {
    const url = recordingUrl('https://app.example/records/7?tab=notes#x', 'tok-1234567')
    expect(url).toBe('https://app.example/records/7?tab=notes&nvr-record=tok-1234567#x')
    expect(tokenFromSearch(new URL(url).search)).toBe('tok-1234567')
    expect(withoutRecordParam(url)).toBe('https://app.example/records/7?tab=notes#x')
    expect(withoutRecordParam('https://app.example/records/7?nvr-record=a1b2c3d4e5')).toBe(
      'https://app.example/records/7'
    )
  })
  it('ignores a token that does not look like one', () => {
    expect(tokenFromSearch('')).toBeNull()
    expect(tokenFromSearch('?nvr-record=short')).toBeNull()
    expect(tokenFromSearch('?nvr-record=%3Cscript%3Ealert(1)')).toBeNull()
  })
  it('asks for an outer size that leaves the inner size wanted', () => {
    expect(
      outerSizeFor(
        { w: 1280, h: 800 },
        { innerWidth: 1000, innerHeight: 600, outerWidth: 1016, outerHeight: 688 }
      )
    ).toEqual({ w: 1296, h: 888 })
    // A browser that reports no chrome (or nonsense) never shrinks the request.
    expect(
      outerSizeFor(
        { w: 1280, h: 800 },
        { innerWidth: 1000, innerHeight: 600, outerWidth: 900, outerHeight: 500 }
      )
    ).toEqual({ w: 1280, h: 800 })
  })
  it('says when the window is not the size asked for', () => {
    expect(frameNote({ w: 1280, h: 800 }, { w: 1280, h: 800 })).toBeNull()
    expect(frameNote({ w: 1920, h: 1080 }, { w: 1440, h: 900 })).toBe(
      'This window is 1440 × 900, not 1920 × 1080: the screen may have no room for it.'
    )
  })
})

describe('the handoff', () => {
  it('is written under its token and taken once', () => {
    const h = handoff()
    expect(writeHandoff(h)).toBe(true)
    expect(window.localStorage.getItem(handoffKey(h.token))).toBeTruthy()
    expect(takeHandoff(h.token, h.at + 1000)).toEqual(h)
    expect(takeHandoff(h.token, h.at + 1000)).toBeNull()
  })
  it('is null for no token, another token, a stale one or junk', () => {
    const h = handoff()
    writeHandoff(h)
    expect(takeHandoff(null)).toBeNull()
    expect(takeHandoff('other-token')).toBeNull()
    writeHandoff(h)
    expect(takeHandoff(h.token, h.at + HANDOFF_MAX_AGE_MS + 1)).toBeNull()
    window.localStorage.setItem(handoffKey('tok-junk1234'), '{not json')
    expect(takeHandoff('tok-junk1234')).toBeNull()
    window.localStorage.setItem(handoffKey('tok-wrong1234'), JSON.stringify({ ...h, v: 2 }))
    expect(takeHandoff('tok-wrong1234')).toBeNull()
  })
  it('can be forgotten (a blocked popup), with any result', () => {
    const h = handoff()
    writeHandoff(h)
    writeResult(h.token, 'v1')
    forgetHandoff(h.token)
    expect(takeHandoff(h.token, h.at)).toBeNull()
    expect(takeResult(h.token)).toBeNull()
  })
})

describe('the result', () => {
  it('carries the video id, or none, and is taken once', () => {
    writeResult('tok-a', 'v1')
    expect(takeResult('tok-a')).toEqual({ videoId: 'v1' })
    expect(takeResult('tok-a')).toBeNull()
    writeResult('tok-b', null)
    expect(takeResult('tok-b')).toEqual({ videoId: null })
    expect(takeResult('tok-c')).toBeNull()
  })
})
