import { describe, expect, it } from 'vitest'
import { breaksThroughDnd, dndUntil, isDndActive } from './dnd'
import {
  applySignal,
  expirePeers,
  peerNames,
  SIGNAL_TTL_MS,
  type SignalPeers,
  signalSentence,
  whoText
} from './presence-signals'
import { pickSoundTab, type SoundTab } from './tab-sound'

const start = (id: string, name: string) => ({ state: 'start', user: { id, name } })

describe('signals from other people', () => {
  it('adds a person on start, refreshes them, and removes them on stop', () => {
    let peers: SignalPeers = new Map()
    peers = applySignal(peers, start('u1', 'Beth'), 1000, 'me')
    expect(peerNames(peers)).toEqual(['Beth'])
    peers = applySignal(peers, start('U1', 'Beth'), 4000, 'me')
    expect(peers.size).toBe(1)
    expect(peers.get('U1')?.until).toBe(4000 + SIGNAL_TTL_MS)
    peers = applySignal(peers, { state: 'stop', user: { id: 'u1', name: 'Beth' } }, 5000, 'me')
    expect(peers.size).toBe(0)
  })

  it('never lists the viewer themself', () => {
    const peers = applySignal(new Map(), start('ME', 'Me'), 0, 'me')
    expect(peers.size).toBe(0)
  })

  it('lets a signal lapse when the heartbeats stop', () => {
    const peers = applySignal(new Map(), start('u1', 'Kim'), 0, null)
    expect(expirePeers(peers, SIGNAL_TTL_MS - 1).size).toBe(1)
    expect(expirePeers(peers, SIGNAL_TTL_MS).size).toBe(0)
  })
})

describe('wording', () => {
  it('names one, two or many people', () => {
    expect(signalSentence([], 'approving')).toBeNull()
    expect(signalSentence(['Kim'], 'approving')).toBe('Kim is approving')
    expect(signalSentence(['Kim', 'Beth'], 'replying')).toBe('Kim and Beth are replying')
    expect(whoText(['A', 'B', 'C'])).toBe('A, B and 1 other')
    expect(whoText(['A', 'B', 'C', 'D'])).toBe('A, B and 2 others')
  })
})

describe('one tab plays the sound', () => {
  const tabs = (m: Record<string, SoundTab>) => new Map(Object.entries(m))
  it('picks the most recently used live tab', () => {
    const t = tabs({
      a: { active: 100, seen: 1000 },
      b: { active: 500, seen: 1000 },
      c: { active: 300, seen: 1000 }
    })
    expect(pickSoundTab(t, 1000)).toBe('b')
  })
  it('skips a tab that stopped answering', () => {
    const t = tabs({ a: { active: 100, seen: 100_000 }, b: { active: 900, seen: 1000 } })
    expect(pickSoundTab(t, 100_000)).toBe('a')
  })
  it('settles ties on the lowest id so exactly one tab wins', () => {
    const t = tabs({
      z: { active: 0, seen: 10 },
      m: { active: 0, seen: 10 },
      q: { active: 0, seen: 10 }
    })
    expect(pickSoundTab(t, 10)).toBe('m')
  })
  it('picks nobody when no tab is live', () => {
    expect(pickSoundTab(tabs({ a: { active: 1, seen: 0 } }), 1_000_000)).toBeNull()
  })
})

describe('do not disturb', () => {
  const now = Date.parse('2026-10-12T12:00:00Z')
  it('reads on, until a time, and off', () => {
    expect(isDndActive({}, now)).toBe(false)
    expect(isDndActive({ dnd: { until: null } }, now)).toBe(true)
    expect(isDndActive({ dnd: { until: '2026-10-12T12:30:00Z' } }, now)).toBe(true)
    expect(isDndActive({ dnd: { until: '2026-10-12T11:59:00Z' } }, now)).toBe(false)
    expect(dndUntil({ dnd: { until: '2026-10-12T12:30:00Z' } })?.toISOString()).toBe(
      '2026-10-12T12:30:00.000Z'
    )
    expect(dndUntil({ dnd: { until: null } })).toBeNull()
  })
  it('lets only critical notifications through', () => {
    expect(breaksThroughDnd({ lane: 'critical' })).toBe(true)
    expect(breaksThroughDnd({ lane: 'needs_you' })).toBe(false)
    expect(breaksThroughDnd(null)).toBe(false)
  })
})
