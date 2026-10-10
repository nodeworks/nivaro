import { describe, expect, it } from 'vitest'
import {
  deniedText,
  followAction,
  hostLeft,
  hostName,
  INITIAL_WATCH,
  LEAD_HEARTBEAT_MS,
  leaderShouldSend,
  makeWatchKey,
  replayLink,
  WATCH_KEY_RE,
  type WatchState,
  watchReducer
} from './watch-together'

const ann = { id: 'U1', name: 'Ann', leader: true }
const bob = { id: 'U2', name: 'Bob', leader: false }

describe('watchReducer', () => {
  it('joins as the role the server gave, then takes the roster', () => {
    let s = watchReducer(INITIAL_WATCH, { type: 'joined', leader: false })
    expect(s).toMatchObject({ status: 'joined', role: 'follower' })
    s = watchReducer(s, { type: 'roster', viewers: [ann, bob] })
    expect(s.viewers).toEqual([ann, bob])
    expect(hostName(s)).toBe('Ann')
    expect(hostLeft(s)).toBe(false)
  })

  it('a follower keeps the leader’s state; a leader ignores echoes', () => {
    const remote = { playing: true, time: 5_000, speed: 2, by: 'Ann' }
    const f = watchReducer(watchReducer(INITIAL_WATCH, { type: 'joined', leader: false }), {
      type: 'remote',
      state: remote
    })
    expect(f.remote).toEqual(remote)
    const l = watchReducer(INITIAL_WATCH, { type: 'joined', leader: true })
    expect(watchReducer(l, { type: 'remote', state: remote })).toBe(l)
  })

  it('denied and reset', () => {
    const d = watchReducer(INITIAL_WATCH, { type: 'denied', reason: 'admins-only' })
    expect(d).toMatchObject({ status: 'denied', denied: 'admins-only' })
    expect(deniedText(d.denied)).toMatch(/admins/i)
    expect(watchReducer(d, { type: 'reset' })).toBe(INITIAL_WATCH)
  })

  it('notices when the host has left', () => {
    const s: WatchState = { ...INITIAL_WATCH, status: 'joined', role: 'follower', viewers: [bob] }
    expect(hostLeft(s)).toBe(true)
    expect(hostLeft({ ...s, viewers: [] })).toBe(false)
  })
})

describe('followAction', () => {
  it('plays on when close enough', () => {
    expect(
      followAction(
        { time: 10_500, playing: true, speed: 1 },
        { time: 10_000, playing: true, speed: 1 }
      )
    ).toEqual({ seekTo: null, play: null, speed: null })
  })

  it('seeks when it drifted, and follows play / pause / speed', () => {
    expect(
      followAction(
        { time: 4_000, playing: true, speed: 1 },
        { time: 60_000, playing: false, speed: 4 }
      )
    ).toEqual({ seekTo: 60_000, play: false, speed: 4 })
  })

  it('lands exactly on a paused leader', () => {
    expect(
      followAction(
        { time: 10_400, playing: false, speed: 1 },
        { time: 10_000, playing: false, speed: 1 }
      ).seekTo
    ).toBe(10_000)
  })
})

describe('leaderShouldSend', () => {
  const at = 1_000_000
  const base = { time: 10_000, playing: true, speed: 1, at }

  it('sends first, on play / pause and speed changes', () => {
    expect(leaderShouldSend(null, base)).toBe(true)
    expect(leaderShouldSend(base, { ...base, playing: false })).toBe(true)
    expect(leaderShouldSend(base, { ...base, speed: 2 })).toBe(true)
  })

  it('stays quiet while playing as expected, then heartbeats', () => {
    expect(leaderShouldSend(base, { ...base, time: 10_500, at: at + 500 })).toBe(false)
    expect(
      leaderShouldSend(base, {
        ...base,
        time: 10_000 + LEAD_HEARTBEAT_MS,
        at: at + LEAD_HEARTBEAT_MS
      })
    ).toBe(true)
  })

  it('sends on a jump (seek, chapter, skipped gap)', () => {
    expect(leaderShouldSend(base, { ...base, time: 40_000, at: at + 500 })).toBe(true)
    const paused = { ...base, playing: false }
    expect(leaderShouldSend(paused, { ...paused, at: at + 10_000 })).toBe(false)
    expect(leaderShouldSend(paused, { ...paused, time: 2_000, at: at + 100 })).toBe(true)
  })
})

describe('keys and links', () => {
  it('makes 16-character keys the server accepts', () => {
    const k = makeWatchKey()
    expect(k).toHaveLength(16)
    expect(WATCH_KEY_RE.test(k)).toBe(true)
    expect(makeWatchKey()).not.toBe(k)
    expect(makeWatchKey((n) => new Uint8Array(n))).toBe('AAAAAAAAAAAAAAAA')
  })

  it('links to the moment, with the watch party when there is one', () => {
    expect(replayLink('https://x.dev', 'R1', 12_345.6)).toBe(
      'https://x.dev/session-replays?recording=R1&t=12346'
    )
    expect(replayLink('https://x.dev', 'R1', -5, 'abcDEF123456')).toBe(
      'https://x.dev/session-replays?recording=R1&t=0&watch=abcDEF123456'
    )
  })
})
