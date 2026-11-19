import { describe, expect, it } from 'vitest'
import { keepNewestActivity } from '../../../hooks/presence-typing-strip.js'
import type { BoardLive } from '../../../services/realtime-board.js'

describe('M3 — a background tab never makes an active person idle (newest activity wins)', () => {
  const stored = '2026-11-18T12:00:00.000Z'

  it('an older last_active (a tab touched an hour ago) keeps the stored one and its idle claim', () => {
    const p: Record<string, unknown> = {
      last_active: '2026-11-18T11:00:00.000Z',
      is_idle: true,
      last_seen: 'now',
      is_online: true
    }
    keepNewestActivity(p, stored)
    expect(p).toEqual({ last_seen: 'now', is_online: true })
  })

  it('a newer or equal claim is written as sent', () => {
    const p: Record<string, unknown> = { last_active: '2026-11-18T12:00:05.000Z', is_idle: true }
    keepNewestActivity(p, stored)
    expect(p).toEqual({ last_active: '2026-11-18T12:00:05.000Z', is_idle: true })
    const q: Record<string, unknown> = { last_active: stored, is_idle: false }
    keepNewestActivity(q, new Date(stored))
    expect(q).toEqual({ last_active: stored, is_idle: false })
  })

  it('no stored activity, or no claim, leaves the payload alone', () => {
    const p: Record<string, unknown> = { last_active: '2026-11-18T11:00:00.000Z', is_idle: true }
    keepNewestActivity(p, null)
    expect(p.last_active).toBe('2026-11-18T11:00:00.000Z')
    const q: Record<string, unknown> = { is_online: false, is_idle: true }
    keepNewestActivity(q, stored)
    expect(q).toEqual({ is_online: false, is_idle: true })
  })

  it('an unreadable claim is dropped rather than wiping the stored activity', () => {
    const p: Record<string, unknown> = { last_active: 'not a date', is_idle: true }
    keepNewestActivity(p, stored)
    expect(p).toEqual({})
  })
})

describe('L12 — an idle flip tells the Online lists only when what they show moves', () => {
  it('compiles to the rows whose displayed idle state changes', async () => {
    const knex = (await import('knex')).default({ client: 'mssql' })
    const { presenceIdleChangedWhen } = await import('../../../services/presence-sockets.js')
    const now = new Date('2026-11-18T12:00:00Z')
    const sql = (idle: boolean) => {
      const qb = knex('user_presence').where({ user_id: 'u' })
      qb.where((w) => void presenceIdleChangedWhen(idle, now)(w))
      return qb.toSQL().toNative()
    }
    const back = sql(false)
    expect(back.sql).toMatch(/\[last_active\] is null or \[last_active\] < @p1/)
    expect(back.bindings).toEqual(['u', new Date('2026-11-18T11:55:00Z')])
    const away = sql(true)
    expect(away.sql).toMatch(
      /\[last_active\] is null and \(\[is_idle\] = @p1 or \[is_idle\] is null\)/
    )
  })
})

describe('L9 — machine accounts are never listed online', () => {
  it('drops machine-account rows; keeps everything when the read fails', async () => {
    const { withoutMachineAccounts } = await import('../../../routes/presence.js')
    const rows = [{ user_id: 'u-amy' }, { user_id: 'U-BOT' }, { user_id: 'u-ben' }]
    const out = await withoutMachineAccounts(rows, async () => ['u-bot'])
    expect(out.map((r) => r.user_id)).toEqual(['u-amy', 'u-ben'])
    const kept = await withoutMachineAccounts(rows, async () => {
      throw new Error('no column')
    })
    expect(kept).toHaveLength(3)
  })

  it('API-key and machine sockets do not mark presence; View-as is unchanged', async () => {
    const { presenceRole } = await import('../../../services/record-viewing.js')
    expect(presenceRole('apikey', {})).toBe('none')
    expect(presenceRole('session', { account_kind: 'integration' })).toBe('none')
    expect(presenceRole('session', {})).toBe('viewer')
    expect(presenceRole('masq', {})).not.toBe('none')
  })
})

describe('M8 — server "is X online" reads follow the Online list rules', () => {
  const now = new Date('2026-11-18T12:00:00Z')
  it('row-or-socket, minus machine accounts and Appear away', async () => {
    const { onlineNow } = await import('../../../services/online-now.js')
    const out = await onlineNow(['u-a', 'u-b', 'u-c', 'u-bot', 'u-away', 'u-d'], now, {
      rows: async (_ids, since) => {
        expect(since.toISOString()).toBe('2026-11-18T11:58:50.000Z')
        return [
          { user_id: 'u-a', is_online: true },
          // One tab closed (pagehide wrote false) but another is still open on a socket.
          { user_id: 'u-b', is_online: false },
          { user_id: 'u-c', is_online: null },
          { user_id: 'u-bot', is_online: true },
          { user_id: 'u-away', is_online: true },
          { user_id: 'u-d', is_online: 0 }
        ]
      },
      connected: (id) => (id === 'u-b' ? true : id === 'u-d' ? null : false),
      people: async () => [
        { id: 'U-BOT', account_kind: 'integration' },
        { id: 'u-away', preferences: JSON.stringify({ presence_override: { mode: 'away' } }) },
        { id: 'u-a', account_kind: 'placeholder' }
      ]
    })
    expect([...out].sort()).toEqual(['U-A', 'U-B', 'U-C'])
  })

  it('no presence = nobody; a failed people read keeps the presence answer', async () => {
    const { onlineNow } = await import('../../../services/online-now.js')
    expect(
      await onlineNow(['u-a'], now, {
        rows: async () => {
          throw new Error('down')
        }
      })
    ).toEqual(new Set())
    const kept = await onlineNow(['u-a'], now, {
      rows: async () => [{ user_id: 'u-a', is_online: true }],
      connected: () => null,
      people: async () => {
        throw new Error('down')
      }
    })
    expect([...kept]).toEqual(['U-A'])
    expect(await onlineNow([], now)).toEqual(new Set())
  })
})

describe('M7 — the UserChip dot follows the Online list (visibility, Appear away)', () => {
  it('listed = online; away or not listed (hidden from this viewer) = not', async () => {
    const { userChipPresence } = await import('../../../routes/presence.js')
    const list = [
      { user_id: 'U-A', state: 'active', away: false },
      { user_id: 'u-b', state: 'idle', away: false },
      { user_id: 'u-c', state: 'active', away: true }
    ]
    expect(userChipPresence(list, 'u-a')).toEqual({ online: true, state: 'active' })
    expect(userChipPresence(list, 'U-B')).toEqual({ online: true, state: 'idle' })
    expect(userChipPresence(list, 'u-c')).toEqual({ online: false, state: 'away' })
    expect(userChipPresence(list, 'u-hidden')).toEqual({ online: false, state: 'offline' })
  })
})

describe('L10 — the notification skip trusts only a tab in front (a few seconds of grace)', () => {
  it('viewer lists keep 30 s; the skip uses the short grace, locally and across processes', async () => {
    const { viewingNow, HIDDEN_GRACE_MS, NOTIFY_SKIP_GRACE_MS } = await import(
      '../../../services/record-viewing.js'
    )
    const { boardIsViewing, boardViewerEntry, setBoardsForTests, resetBoard } = await import(
      '../../../services/realtime-board.js'
    )
    const now = 1_800_000_000_000
    const tabAway10s = { id: 'u-bob', name: 'Bob', hiddenAt: now - 10_000 }
    expect(viewingNow(tabAway10s, now)).toBe(true) // still listed
    expect(viewingNow(tabAway10s, now, NOTIFY_SKIP_GRACE_MS)).toBe(false) // gets the bell
    expect(HIDDEN_GRACE_MS).toBeGreaterThan(NOTIFY_SKIP_GRACE_MS)

    const entry = boardViewerEntry('s1', tabAway10s, 'session', false, true)
    expect(entry).toEqual({ socket: 's1', id: 'u-bob', name: 'Bob', kind: 'session', hidden: true })
    setBoardsForTests(
      [
        {
          node: 'rt-2',
          at: now,
          sockets: 1,
          users: [],
          pages: [],
          viewers: { 'record:w:1': [entry] }
        }
      ],
      [],
      now
    )
    expect(boardIsViewing('record:w:1', 'u-bob', 3_000, now)).toBe(false)
    setBoardsForTests(
      [
        {
          node: 'rt-2',
          at: now,
          sockets: 1,
          users: [],
          pages: [],
          viewers: { 'record:w:1': [boardViewerEntry('s1', tabAway10s, 'session')] }
        }
      ],
      [],
      now
    )
    expect(boardIsViewing('record:w:1', 'u-bob', 3_000, now)).toBe(true)
    resetBoard()
  })
})

describe('L13 — board freshness uses the reader clock, not the publishing host', () => {
  it('a skewed publisher stays fresh while it keeps publishing, and ages out when it stops', async () => {
    const { stampReceived, boardIsViewing, setBoardsForTests, resetBoard } = await import(
      '../../../services/realtime-board.js'
    )
    const now = 1_800_000_000_000
    // rt-2's clock runs 15 s behind this host.
    const entry = (at: number): BoardLive => ({
      node: 'rt-2',
      at,
      sockets: 1,
      users: ['u-1'],
      pages: [],
      viewers: { 'record:w:1': [{ socket: 's', id: 'u-1', name: 'U' }] }
    })
    const first = stampReceived([], [entry(now - 15_000)], now)
    expect(first[0].rx).toBe(now)
    // Next read 1 s later: a new publish → stamped again.
    const second = stampReceived(first, [entry(now - 14_000)], now + 1_000)
    expect(second[0].rx).toBe(now + 1_000)
    setBoardsForTests(second, [], now + 1_000)
    expect(boardIsViewing('record:w:1', 'u-1', 3_000, now + 1_500)).toBe(true)
    // The publisher stopped: the same `at` keeps its old stamp and ages out.
    const stalled = stampReceived(second, [entry(now - 14_000)], now + 5_000)
    expect(stalled[0].rx).toBe(now + 1_000)
    setBoardsForTests(stalled, [], now + 5_000)
    expect(boardIsViewing('record:w:1', 'u-1', 3_000, now + 5_000)).toBe(false)
    resetBoard()
  })
})
