import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerPresenceTypingStripHooks,
  stripTypingRoom
} from '../../../hooks/presence-typing-strip.js'
import {
  CHAT_TYPING_MIN_GAP_MS,
  chatTypingRoomName,
  createChatTypingThrottle,
  parseChatTyping
} from '../../../services/chat-typing.js'
import { setLockPresenceProbe } from '../../../services/lock-presence.js'
import {
  boardIsViewing,
  boardPeerViewers,
  boardPeerViewersNow,
  boardRecordViewers,
  boardViewerEntry,
  changedPeerRooms,
  resetBoard,
  setBoardsForTests
} from '../../../services/realtime-board.js'
import {
  activeViewers,
  HIDDEN_GRACE_MS,
  parseRecordVisibility,
  presenceRole,
  RecordVisibilityBook,
  socketBindKindOf,
  viewersRoomName,
  viewingNow
} from '../../../services/record-viewing.js'
import { liveLockHolders } from '../../../services/traffic-taps/hot-records.js'

/** Realtime gaps 2026-11-17, batch B4 (presence): the pure parts of P1, P2, P3, P9, P10 + Low. */

describe('P1 — a background tab is not viewing', () => {
  it('counts a viewer while visible or inside the grace, not after', () => {
    const now = 1_000_000
    expect(viewingNow({}, now)).toBe(true)
    expect(viewingNow({ hiddenAt: now - 1_000 }, now)).toBe(true)
    expect(viewingNow({ hiddenAt: now - HIDDEN_GRACE_MS }, now)).toBe(false)
    expect(
      activeViewers(
        [
          { id: 'a', name: 'Ada' },
          { id: 'b', name: 'Bo', hiddenAt: now - HIDDEN_GRACE_MS - 1 },
          { id: 'c', name: 'Cy', hiddenAt: now - 10 }
        ],
        now
      )
    ).toEqual([
      { id: 'a', name: 'Ada' },
      { id: 'c', name: 'Cy' }
    ])
  })

  it('parses record:visibility (hidden_ms clamped, junk refused)', () => {
    expect(parseRecordVisibility({ collection: 'orders', item: 7, hidden: true })).toEqual({
      collection: 'orders',
      item: '7',
      hidden: true,
      hiddenMs: 0
    })
    expect(
      parseRecordVisibility({ collection: 'orders', item: '7', hidden: true, hidden_ms: 9e12 })
        ?.hiddenMs
    ).toBe(86_400_000)
    // hidden_ms means nothing on a visible report.
    expect(
      parseRecordVisibility({ collection: 'orders', item: '7', hidden: false, hidden_ms: 5 })
    ).toMatchObject({ hidden: false, hiddenMs: 0 })
    expect(parseRecordVisibility({ collection: '', item: '7' })).toBeNull()
    expect(parseRecordVisibility({ collection: 'orders', item: { x: 1 } })).toBeNull()
    expect(parseRecordVisibility(null)).toBeNull()
  })

  it('remembers a report made before the join, keeps the first away moment, and lapses once', () => {
    let t = 10_000
    const timers: Array<{ fn: () => void; at: number; cleared?: boolean }> = []
    const book = new RecordVisibilityBook({
      now: () => t,
      setTimer: (fn, ms) => {
        const h = { fn, at: t + ms }
        timers.push(h)
        return h as never
      },
      clearTimer: (h) => {
        ;(h as unknown as { cleared: boolean }).cleared = true
      }
    })
    // Reported away (already 5 s) before the join finished: the join reads it.
    const at = book.note({ collection: 'orders', item: '7', hidden: true, hiddenMs: 5_000 })
    expect(at).toBe(5_000)
    expect(book.hiddenAtOf('orders', '7')).toBe(5_000)
    // A repeat "still hidden" keeps the first moment.
    t += 3_000
    expect(book.note({ collection: 'orders', item: '7', hidden: true, hiddenMs: 0 })).toBe(5_000)
    const lapsed = vi.fn()
    book.arm('orders', '7', 5_000, lapsed)
    expect(timers.at(-1)?.at).toBe(5_000 + HIDDEN_GRACE_MS + 50)
    // Back in front: the timer goes, the state clears.
    expect(
      book.note({ collection: 'orders', item: '7', hidden: false, hiddenMs: 0 })
    ).toBeUndefined()
    book.disarm('orders', '7')
    expect(timers.at(-1)?.cleared).toBe(true)
    expect(book.hiddenAtOf('orders', '7')).toBeUndefined()
    // Already past the grace: lapses at once.
    book.arm('orders', '7', t - HIDDEN_GRACE_MS - 1, lapsed)
    expect(lapsed).toHaveBeenCalledTimes(1)
    book.forget('orders', '7')
    book.dispose()
    expect(book.pending).toBe(0)
  })

  it('the board carries `away`: other processes stop listing and suppressing, relays still reach', () => {
    const now = Date.now()
    expect(boardViewerEntry('s', { id: 'u', name: 'U' }, 'session', true)).toEqual({
      socket: 's',
      id: 'u',
      name: 'U',
      kind: 'session',
      away: true
    })
    expect(boardViewerEntry('s', { id: 'u', name: 'U' }, 'session', false)).not.toHaveProperty(
      'away'
    )
    const board = (away: boolean) => ({
      node: 'rt-x',
      at: now,
      sockets: 1,
      users: ['u-1'],
      viewers: {
        'record:projects:1': [{ socket: 's1', id: 'u-1', name: 'Ada', ...(away ? { away } : {}) }]
      },
      pages: []
    })
    try {
      setBoardsForTests([board(true)])
      expect(boardIsViewing('record:projects:1', 'u-1', 3_000, now)).toBe(false)
      expect(boardRecordViewers('')).toEqual([])
      expect(boardPeerViewersNow('record:projects:1')).toEqual([])
      expect(boardPeerViewers('record:projects:1').map((v) => v.id)).toEqual(['u-1'])
      setBoardsForTests([board(false)])
      expect(boardIsViewing('record:projects:1', 'u-1', 3_000, now)).toBe(true)
      // Going away is a change the other processes re-tell their rooms about.
      expect(changedPeerRooms([board(false)], [board(true)])).toEqual(['record:projects:1'])
    } finally {
      resetBoard()
    }
  })
})

describe('P3 / P9 — who takes part in record presence', () => {
  it('a person at a screen is a viewer; View-as an audience; machines and API keys nothing', () => {
    const person = { account_kind: null }
    expect(presenceRole('session', person)).toBe('viewer')
    expect(presenceRole('device', person)).toBe('viewer')
    expect(presenceRole('token', person)).toBe('viewer')
    expect(presenceRole('session', { account_kind: 'placeholder' })).toBe('viewer')
    expect(presenceRole('masq', person)).toBe('audience')
    expect(presenceRole('apikey', person)).toBe('none')
    expect(presenceRole(undefined, person)).toBe('none')
    expect(presenceRole('session', { account_kind: 'integration' })).toBe('none')
    expect(presenceRole('masq', { account_kind: 'service' })).toBe('none')
    expect(presenceRole('session', null)).toBe('none')
  })

  it('reads the bind kind off a socket and names the audience room', () => {
    expect(socketBindKindOf({ data: { nvrBind: { kind: 'masq', token: 'x' } } })).toBe('masq')
    expect(socketBindKindOf({ data: {} })).toBeUndefined()
    expect(viewersRoomName('t:acme:record:orders:7')).toBe('viewers:t:acme:record:orders:7')
  })
})

describe('P2 / P10 — chat typing is a gated, throttled socket signal', () => {
  it('parses and names the typing audience room', () => {
    expect(parseChatTyping({ room: 'dm:A:B' })).toEqual({ room: 'dm:A:B', state: 'start' })
    expect(parseChatTyping({ room: 'global', state: 'stop' })).toEqual({
      room: 'global',
      state: 'stop'
    })
    expect(parseChatTyping({ room: '' })).toBeNull()
    expect(parseChatTyping({ room: 'x'.repeat(201) })).toBeNull()
    expect(chatTypingRoomName('global')).toBe('chat-typing:global')
  })

  it('relays a start at most once a second per room; a stop always', () => {
    let t = 0
    const allow = createChatTypingThrottle(() => t)
    expect(allow({ room: 'g', state: 'start' })).toBe(true)
    expect(allow({ room: 'g', state: 'start' })).toBe(false)
    expect(allow({ room: 'h', state: 'start' })).toBe(true)
    expect(allow({ room: 'g', state: 'stop' })).toBe(true)
    expect(allow({ room: 'g', state: 'start' })).toBe(true)
    t += CHAT_TYPING_MIN_GAP_MS
    expect(allow({ room: 'h', state: 'start' })).toBe(true)
  })

  it('a presence-row write never stores a typing room (older builds)', async () => {
    const p: Record<string, unknown> = { typing_room: 'dm:A:B', last_seen: 'x' }
    stripTypingRoom(p)
    expect(p).toEqual({ typing_room: null, last_seen: 'x' })
    const q: Record<string, unknown> = { last_seen: 'x' }
    stripTypingRoom(q)
    // A payload without the column is left alone (the column may not exist).
    expect(q).toEqual({ last_seen: 'x' })
    const { hooks } = await import('../../../hooks/registry.js')
    const spy = vi.spyOn(hooks, 'before')
    registerPresenceTypingStripHooks()
    expect(spy.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['user_presence', 'create'],
      ['user_presence', 'update']
    ])
    spy.mockRestore()
  })
})

describe('Low — Traffic Map hot records judge locks with lockIsLive', () => {
  afterEach(() => setLockPresenceProbe(null))
  it('a lapsed lease or a holder known to be gone is no lock', () => {
    const now = Date.parse('2026-11-17T12:00:00Z')
    const row = (item: string, expiresInMs: number, user = 'u-1') => ({
      item,
      user,
      locked_at: new Date(now - 60_000),
      expires_at: new Date(now + expiresInMs),
      first_name: 'Ada',
      last_name: 'L',
      email: null
    })
    setLockPresenceProbe((id) => id !== 'gone')
    const out = liveLockHolders([row('1', 20_000), row('2', -1), row('3', 20_000, 'gone')], now)
    expect([...out]).toEqual([['1', 'Ada L']])
  })
})

describe('presence minor — one tab closing does not flip the person offline', () => {
  it('a row written offline stays online while a live socket says so', async () => {
    const { onlineByRowOrSocket } = await import('../../../routes/presence.js')
    const rows = [
      { user_id: 'a', is_online: true },
      { user_id: 'b', is_online: false },
      { user_id: 'c', is_online: 0 },
      { user_id: 'd', is_online: null }
    ]
    const live = (id: string) => (id === 'b' ? true : id === 'c' ? null : false)
    expect(onlineByRowOrSocket(rows, live).map((r) => r.user_id)).toEqual(['a', 'b', 'd'])
    expect(onlineByRowOrSocket(rows, undefined).map((r) => r.user_id)).toEqual(['a', 'd'])
  })
})
