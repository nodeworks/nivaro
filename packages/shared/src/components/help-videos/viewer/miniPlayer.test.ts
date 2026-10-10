import { describe, expect, it } from 'vitest'
import { handOver, hasDocumentPip, MINI_INITIAL, type MiniState, miniReducer } from './miniPlayer'

const sheet: MiniState = { place: 'sheet', kind: null, at: 0, playing: false }

describe('miniReducer', () => {
  it('opens into the sheet and pops out from there only', () => {
    expect(miniReducer(MINI_INITIAL, { type: 'open' })).toEqual(sheet)
    const out = miniReducer(sheet, { type: 'pop-out', kind: 'pip', at: 42_000, playing: true })
    expect(out).toEqual({ place: 'mini', kind: 'pip', at: 42_000, playing: true })
    // already out: a second pop-out changes nothing
    expect(miniReducer(out, { type: 'pop-out', kind: 'panel', at: 1, playing: false })).toBe(out)
    // closed: cannot pop out
    expect(miniReducer(MINI_INITIAL, { type: 'pop-out', kind: 'pip', at: 1, playing: true })).toBe(
      MINI_INITIAL
    )
  })
  it('popping in, or the pop-out closing, returns to the sheet at that moment', () => {
    const out: MiniState = { place: 'mini', kind: 'panel', at: 10_000, playing: true }
    expect(miniReducer(out, { type: 'pop-in', at: 55_000, playing: true })).toEqual({
      place: 'sheet',
      kind: null,
      at: 55_000,
      playing: true
    })
    expect(miniReducer(out, { type: 'mini-closed', at: 61_500, playing: false })).toEqual({
      place: 'sheet',
      kind: null,
      at: 61_500,
      playing: false
    })
    expect(miniReducer(sheet, { type: 'pop-in', at: 1, playing: false })).toBe(sheet)
  })
  it('close ends everything from either place', () => {
    expect(miniReducer(sheet, { type: 'close' })).toEqual(MINI_INITIAL)
    expect(
      miniReducer({ place: 'mini', kind: 'pip', at: 5, playing: true }, { type: 'close' })
    ).toEqual(MINI_INITIAL)
    expect(miniReducer(MINI_INITIAL, { type: 'close' })).toBe(MINI_INITIAL)
    // open again starts fresh in the sheet
    expect(miniReducer(MINI_INITIAL, { type: 'open' })).toEqual(sheet)
  })
})

describe('handOver', () => {
  it('leaves a player that kept its place alone', () => {
    expect(handOver({ at: 42_000, playing: true }, { at: 42_120, playing: true })).toEqual({
      seekTo: null,
      resume: false
    })
    // a small step back (a keyframe) is not a loss
    expect(handOver({ at: 42_000, playing: false }, { at: 41_500, playing: false })).toEqual({
      seekTo: null,
      resume: false
    })
  })
  it('seeks back when the element reset, and plays again if it was playing', () => {
    expect(handOver({ at: 42_000, playing: true }, { at: 0, playing: false })).toEqual({
      seekTo: 42_000,
      resume: true
    })
    expect(handOver({ at: 42_000, playing: false }, { at: 30_000, playing: false })).toEqual({
      seekTo: 42_000,
      resume: false
    })
  })
  it('a video that was at the very start has nothing to restore', () => {
    expect(handOver({ at: 500, playing: true }, { at: 0, playing: true })).toEqual({
      seekTo: null,
      resume: false
    })
  })
  it('only resumes, never pauses: a move that paused a playing video plays it again', () => {
    expect(handOver({ at: 9000, playing: true }, { at: 9000, playing: false })).toEqual({
      seekTo: null,
      resume: true
    })
  })
})

describe('hasDocumentPip', () => {
  it('needs documentPictureInPicture.requestWindow', () => {
    expect(hasDocumentPip(undefined)).toBe(false)
    expect(hasDocumentPip({})).toBe(false)
    expect(hasDocumentPip({ documentPictureInPicture: {} })).toBe(false)
    expect(hasDocumentPip({ documentPictureInPicture: { requestWindow: () => null } })).toBe(true)
  })
})
