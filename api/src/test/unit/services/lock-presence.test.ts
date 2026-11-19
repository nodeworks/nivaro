import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  holderKnownGone,
  LEGACY_LOCK_TTL_MS,
  LOCK_LIVE_MS,
  lastHeartbeatAt,
  lockIsLive,
  lockWindowMs,
  noteHolderSeen,
  PRESENCE_ABSENCE_MS,
  resetLockPresenceMemory,
  setLockPresenceProbe
} from '../../../services/lock-presence.js'
import {
  boardKnowsEveryone,
  resetBoard,
  setBoardsForTests,
  setLoneForTests
} from '../../../services/realtime-board.js'

const NOW = 1_800_000_000_000
const lock = (beatAgoMs: number, takenAgoMs = 120_000, window = LOCK_LIVE_MS) => ({
  user: 'U-ETIEN',
  locked_at: new Date(NOW - takenAgoMs),
  expires_at: new Date(NOW - beatAgoMs + window)
})

beforeEach(() => {
  // This process has been judging long enough to know who left.
  resetLockPresenceMemory(NOW - 10 * 60_000)
})

afterEach(() => {
  setLockPresenceProbe(null)
  resetBoard()
})

describe('lockWindowMs', () => {
  it('grants the 30 s lease only to a client that beats every ≤15 s', () => {
    expect(lockWindowMs({ beat_ms: 10_000 })).toBe(LOCK_LIVE_MS)
    expect(lockWindowMs({ beat_ms: 60_000 })).toBe(LEGACY_LOCK_TTL_MS)
    expect(lockWindowMs({})).toBe(LEGACY_LOCK_TTL_MS)
    expect(lockWindowMs(null)).toBe(LEGACY_LOCK_TTL_MS)
    expect(lockWindowMs({ beat_ms: 'x' })).toBe(LEGACY_LOCK_TTL_MS)
  })
})

describe('lastHeartbeatAt', () => {
  it('tells the short and the legacy lease apart by what is left of it', () => {
    expect(lastHeartbeatAt(lock(4_000).expires_at, NOW).getTime()).toBe(NOW - 4_000)
    const legacy = lock(20_000, 120_000, LEGACY_LOCK_TTL_MS)
    expect(lastHeartbeatAt(legacy.expires_at, NOW).getTime()).toBe(NOW - 20_000)
  })
})

describe('lockIsLive', () => {
  it('stale heartbeat = not held; live heartbeat = held (no presence known)', () => {
    expect(lockIsLive(lock(31_000), NOW)).toBe(false)
    expect(lockIsLive(lock(9_000), NOW)).toBe(true)
  })

  it('presence absent for the whole absence window = released inside the lease', () => {
    setLockPresenceProbe(() => false)
    expect(holderKnownGone(lock(22_000), NOW)).toBe(true)
    expect(lockIsLive(lock(22_000), NOW)).toBe(false)
    // A legacy (150 s) lease whose holder left a minute ago.
    const legacy = lock(60_000, 120_000, LEGACY_LOCK_TTL_MS)
    expect(lockIsLive(legacy, NOW)).toBe(false)
  })

  it('presence unavailable = the heartbeat rule only (never invents or keeps a holder)', () => {
    setLockPresenceProbe(() => null)
    expect(lockIsLive(lock(9_000), NOW)).toBe(true)
    expect(lockIsLive(lock(31_000), NOW)).toBe(false)
    setLockPresenceProbe(() => {
      throw new Error('board broke')
    })
    expect(lockIsLive(lock(9_000), NOW)).toBe(true)
    // Connected keeps nothing alive past the lease either.
    setLockPresenceProbe(() => true)
    expect(lockIsLive(lock(31_000), NOW)).toBe(false)
  })

  it('a fresh lock or a recent heartbeat is not judged by presence', () => {
    setLockPresenceProbe(() => false)
    expect(lockIsLive(lock(1_000, 3_000), NOW)).toBe(true)
    expect(lockIsLive(lock(2_000), NOW)).toBe(true)
    // One heartbeat (10 s) missed during a deploy is not a departure (audit H1).
    expect(lockIsLive(lock(9_000), NOW)).toBe(true)
    expect(lockIsLive(lock(15_000), NOW)).toBe(true)
  })

  it('a deploy / reconnect blip never voids a typing holder (absence must last, audit H1)', () => {
    // Beth's socket was seen 4 s ago, then the process she was on drained: no socket anywhere
    // for a moment. Her lease is legacy-long and her last beat 25 s ago (beats failed in the
    // restart). One "no socket" snapshot is not enough.
    let here = true
    setLockPresenceProbe(() => here)
    const legacy = lock(25_000, 300_000, LEGACY_LOCK_TTL_MS)
    expect(lockIsLive(legacy, NOW - 4_000)).toBe(true) // seen connected
    here = false
    expect(lockIsLive(legacy, NOW)).toBe(true) // gone 4 s: kept
    expect(lockIsLive(legacy, NOW + PRESENCE_ABSENCE_MS - 5_000)).toBe(true)
    // Still nowhere 20 s after she was last seen: released.
    expect(lockIsLive(legacy, NOW - 4_000 + PRESENCE_ABSENCE_MS)).toBe(false)
  })

  it('a freshly booted process does not judge presence until it has been up the window', () => {
    setLockPresenceProbe(() => false)
    resetLockPresenceMemory(NOW - 5_000)
    const legacy = lock(60_000, 300_000, LEGACY_LOCK_TTL_MS)
    expect(lockIsLive(legacy, NOW)).toBe(true)
    expect(lockIsLive(legacy, NOW - 5_000 + PRESENCE_ABSENCE_MS)).toBe(false)
  })

  it('a socket that signed in on this process counts as seen', () => {
    setLockPresenceProbe(() => false)
    noteHolderSeen('u-etien', NOW - 3_000)
    expect(lockIsLive(lock(22_000), NOW)).toBe(true)
    expect(lockIsLive(lock(22_000), NOW + 18_000)).toBe(false) // lease ran out anyway
  })
})

describe('boardKnowsEveryone', () => {
  it('a lone socket-serving process knows everyone only while the registry just said so', () => {
    expect(boardKnowsEveryone()).toBe(false)
    setLoneForTests(Date.now())
    expect(boardKnowsEveryone()).toBe(true)
    setLoneForTests(Date.now() - 60_000)
    expect(boardKnowsEveryone()).toBe(false)
  })

  it('a board reader knows everyone only with a fresh read that a realtime process answered', () => {
    setBoardsForTests([], [], Date.now())
    expect(boardKnowsEveryone()).toBe(false)
    setBoardsForTests(
      [{ node: 'rt-1', at: Date.now(), viewers: {}, users: ['U-X'] } as never],
      [],
      Date.now()
    )
    expect(boardKnowsEveryone()).toBe(true)
    setBoardsForTests(
      [{ node: 'rt-1', at: Date.now(), viewers: {}, users: ['U-X'] } as never],
      [],
      Date.now() - 20_000
    )
    expect(boardKnowsEveryone()).toBe(false)
  })
})
