import { describe, expect, it } from 'vitest'
import {
  type FocusKind,
  gradeQuality,
  meterFill,
  micChange,
  NO_FOCUS,
  orderByLastSpoke,
  PoorDetector,
  qualityTip,
  reconcileOrder,
  rms,
  SpeakingGate,
  shortcutFor,
  summarizeStats
} from './huddle-audio-logic'
import { micConstraints, parseDevicePrefs } from './huddle-device-prefs'

describe('SpeakingGate (#2845)', () => {
  it('starts above the on bar and survives a short pause', () => {
    const g = new SpeakingGate(0.02, 0.012, 300)
    expect(g.push(0.005, 0)).toBe(false)
    expect(g.push(0.03, 100)).toBe(true)
    expect(g.push(0.001, 200)).toBe(true) // quiet starts
    expect(g.push(0.001, 400)).toBe(true) // 200 ms < hold
    expect(g.push(0.03, 450)).toBe(true) // talking again resets the hold
    expect(g.push(0.001, 500)).toBe(true)
    expect(g.push(0.001, 800)).toBe(false) // 300 ms of quiet
  })
  it('a level between the bars neither starts nor stops (hysteresis)', () => {
    const g = new SpeakingGate(0.02, 0.012, 300)
    expect(g.push(0.015, 0)).toBe(false)
    g.push(0.05, 10)
    expect(g.push(0.015, 20)).toBe(true)
    expect(g.push(0.015, 2000)).toBe(true)
  })
  it('rms and meter fill', () => {
    expect(rms([])).toBe(0)
    expect(rms([0.5, -0.5])).toBeCloseTo(0.5)
    expect(meterFill(0)).toBe(0)
    expect(meterFill(1)).toBe(1)
    expect(meterFill(0.001)).toBe(0) // -60 dBFS
    expect(meterFill(0.01)).toBeCloseTo(0.4) // -40 dBFS
  })
})

describe('stage order (#2845)', () => {
  it('keeps the previous order, drops leavers, appends arrivals', () => {
    expect(reconcileOrder(['b', 'a', 'c'], ['a', 'c', 'd'])).toEqual(['a', 'c', 'd'])
  })
  it('puts the most recent speaker first and keeps silent people in place', () => {
    expect(orderByLastSpoke(['a', 'b', 'c', 'd'], { c: 5, b: 9 })).toEqual(['b', 'c', 'a', 'd'])
    expect(orderByLastSpoke(['a', 'b'], {})).toEqual(['a', 'b'])
  })
})

describe('shortcutFor (#2846)', () => {
  const idle = { muted: true, canShare: true }
  const at = (over: Partial<FocusKind>): FocusKind => ({ ...NO_FOCUS, ...over })
  it('Space is push-to-talk only while muted and never in a field', () => {
    expect(shortcutFor({ key: ' ', code: 'Space' }, NO_FOCUS, idle)).toBe('ptt')
    expect(shortcutFor({ key: ' ', code: 'Space' }, NO_FOCUS, { ...idle, muted: false })).toBe(null)
    expect(shortcutFor({ key: ' ', code: 'Space' }, at({ editable: true }), idle)).toBe(null)
  })
  it('Space on another button presses the button; on a huddle control it talks', () => {
    expect(shortcutFor({ key: ' ', code: 'Space' }, at({ interactive: true }), idle)).toBe(null)
    expect(
      shortcutFor(
        { key: ' ', code: 'Space' },
        at({ interactive: true, inHuddleControls: true }),
        idle
      )
    ).toBe('ptt')
  })
  it('letters: M, Shift+S, L, ?', () => {
    expect(shortcutFor({ key: 'm' }, NO_FOCUS, idle)).toBe('mute')
    expect(shortcutFor({ key: 'M', shiftKey: true }, NO_FOCUS, idle)).toBe(null)
    expect(shortcutFor({ key: 'S', shiftKey: true }, NO_FOCUS, idle)).toBe('share')
    expect(shortcutFor({ key: 'S', shiftKey: true }, NO_FOCUS, { ...idle, canShare: false })).toBe(
      null
    )
    expect(shortcutFor({ key: 's' }, NO_FOCUS, idle)).toBe(null)
    expect(shortcutFor({ key: 'l' }, NO_FOCUS, idle)).toBe('leave')
    expect(shortcutFor({ key: '?', shiftKey: true }, NO_FOCUS, idle)).toBe('help')
  })
  it('never with a modifier, in a field, in a type-ahead list, or on key repeat', () => {
    expect(shortcutFor({ key: 'm', metaKey: true }, NO_FOCUS, idle)).toBe(null)
    expect(shortcutFor({ key: 'm', ctrlKey: true }, NO_FOCUS, idle)).toBe(null)
    expect(shortcutFor({ key: 'm' }, at({ editable: true }), idle)).toBe(null)
    expect(shortcutFor({ key: 'm' }, at({ typeahead: true }), idle)).toBe(null)
    expect(shortcutFor({ key: 'm', repeat: true }, NO_FOCUS, idle)).toBe(null)
    expect(shortcutFor({ key: 'Escape' }, NO_FOCUS, idle)).toBe(null)
  })
})

describe('devices (#2847)', () => {
  const mic = (deviceId: string, label: string, groupId = deviceId) => ({
    deviceId,
    kind: 'audioinput',
    label,
    groupId
  })
  it('a headset that appears wins; another plain mic does not', () => {
    const before = [mic('default', 'Default'), mic('a', 'MacBook Microphone')]
    expect(micChange(before, [...before, mic('h', 'Jabra Evolve2 Headset')], 'a')).toEqual({
      kind: 'switch',
      device: mic('h', 'Jabra Evolve2 Headset')
    })
    expect(micChange(before, [...before, mic('u', 'USB Audio CODEC')], 'a')).toEqual({
      kind: 'none'
    })
  })
  it('the microphone in use disappearing falls back to the default', () => {
    const before = [mic('a', 'MacBook Microphone'), mic('h', 'AirPods Pro')]
    expect(micChange(before, [mic('a', 'MacBook Microphone')], 'h')).toEqual({ kind: 'fallback' })
    expect(micChange(before, before, 'default')).toEqual({ kind: 'none' })
  })
  it('prefs parse defensively and build constraints', () => {
    expect(parseDevicePrefs('not json')).toMatchObject({ micId: null, noiseSuppression: true })
    const p = parseDevicePrefs(JSON.stringify({ micId: 'x', echoCancellation: false }))
    expect(p).toMatchObject({ micId: 'x', echoCancellation: false, autoGainControl: true })
    expect(micConstraints(p)).toEqual({
      deviceId: { ideal: 'x' },
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true
    })
    expect(micConstraints(parseDevicePrefs(null))).not.toHaveProperty('deviceId')
  })
})

describe('connection quality (#2848)', () => {
  const page = (over: {
    rtt?: number
    lost?: number
    recv?: number
    relay?: boolean
    bytes?: number
  }) => [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    {
      id: 'P',
      type: 'candidate-pair',
      localCandidateId: 'L',
      remoteCandidateId: 'R',
      currentRoundTripTime: (over.rtt ?? 40) / 1000,
      bytesSent: over.bytes ?? 0,
      bytesReceived: over.bytes ?? 0
    },
    { id: 'L', type: 'local-candidate', candidateType: over.relay ? 'relay' : 'srflx' },
    { id: 'R', type: 'remote-candidate', candidateType: 'host' },
    {
      id: 'I',
      type: 'inbound-rtp',
      kind: 'audio',
      packetsLost: over.lost ?? 0,
      packetsReceived: over.recv ?? 0,
      jitter: 0.008
    }
  ]
  it('reads rtt, path, jitter, loss and bitrate across two polls', () => {
    const first = summarizeStats(page({ recv: 100, bytes: 1000 }), null, 0)
    expect(first.quality).toMatchObject({ rtt: 40, path: 'direct', jitter: 8, loss: null })
    const second = summarizeStats(page({ lost: 10, recv: 190, bytes: 9000 }), first.cursor, 2000)
    expect(second.quality.loss).toBeCloseTo(10) // 10 lost of 100 sent in the window
    expect(second.quality.inKbps).toBeCloseTo(32)
    expect(second.quality.poor).toBe(true)
    expect(summarizeStats(page({ relay: true }), null, 0).quality.path).toBe('relay')
  })
  it('uses the remote report for outgoing loss and rtt when the pair has none', () => {
    const q = summarizeStats(
      [
        {
          id: 'X',
          type: 'remote-inbound-rtp',
          kind: 'audio',
          roundTripTime: 0.5,
          fractionLost: 0.02
        }
      ],
      null,
      0
    ).quality
    expect(q).toMatchObject({ rtt: 500, loss: 2, path: null, poor: true })
  })
  it('grades into four bars', () => {
    expect(gradeQuality({ rtt: null, loss: null, jitter: null })).toBe(0)
    expect(gradeQuality({ rtt: 40, loss: 0, jitter: 5 })).toBe(4)
    expect(gradeQuality({ rtt: 200, loss: 2, jitter: 20 })).toBe(3)
    expect(gradeQuality({ rtt: 350, loss: 4, jitter: 20 })).toBe(2)
    expect(gradeQuality({ rtt: 600, loss: 0, jitter: 20 })).toBe(1)
  })
  it('PoorDetector needs 10 s of trouble to trip and 6 s of calm to recover', () => {
    const d = new PoorDetector(10_000, 6_000)
    expect(d.push(true, 0)).toBe(false)
    expect(d.push(true, 8_000)).toBe(false)
    expect(d.push(false, 9_000)).toBe(false) // a good poll restarts the clock
    expect(d.push(true, 10_000)).toBe(false)
    expect(d.push(true, 20_000)).toBe(true)
    expect(d.push(false, 22_000)).toBe(true)
    expect(d.push(false, 27_999)).toBe(true)
    expect(d.push(false, 28_000)).toBe(false) // 6 s of calm since 22 s
  })
  it('explains the bars in plain words', () => {
    expect(qualityTip('Amy', undefined)).toBe('Amy — measuring the connection')
    const q = summarizeStats(page({ recv: 100 }), null, 0).quality
    expect(qualityTip('Amy', q)).toBe('Good connection to Amy · 40 ms · 8 ms jitter · direct')
  })
})
