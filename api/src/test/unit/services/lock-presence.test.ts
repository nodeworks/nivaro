import { afterEach, describe, expect, it } from 'vitest'
import {
  holderKnownGone,
  LEGACY_LOCK_TTL_MS,
  LOCK_LIVE_MS,
  lastHeartbeatAt,
  lockIsLive,
  lockWindowMs,
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

  it('presence absent = released inside the lease', () => {
    setLockPresenceProbe(() => false)
    expect(holderKnownGone(lock(9_000), NOW)).toBe(true)
    expect(lockIsLive(lock(9_000), NOW)).toBe(false)
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

  it('a fresh lock or a seconds-old heartbeat is not judged by presence', () => {
    setLockPresenceProbe(() => false)
    expect(lockIsLive(lock(1_000, 3_000), NOW)).toBe(true)
    expect(lockIsLive(lock(2_000), NOW)).toBe(true)
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
