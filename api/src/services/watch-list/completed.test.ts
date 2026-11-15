import { describe, expect, it } from 'vitest'
import { dueRemovals, isDue, markDone, restoreRemoved, restoreTeamRemoved } from './completed.js'
import { normalizeTeam, normalizeWatchList, REMOVED_KEEP_MS } from './store.js'
import { newTeam } from './teams.js'

const T0 = new Date('2026-11-15T10:00:00Z')
const H = 3600_000
const OWNER = 'aaaa-1111'

const own = (
  settings: Record<string, boolean>,
  pins: unknown[],
  extra: Record<string, unknown> = {}
) => normalizeWatchList({ settings, pins, ...extra })

describe('remove records when they are completed', () => {
  it('stamps completion only on lists with the switch on, and clears it on reopen', () => {
    const on = own({ remove_completed: true }, [{ c: 'po', id: '1', at: '2026-11-01T00:00:00Z' }])
    const done = markDone(on, 'po', '1', true, T0)
    expect(done?.pins[0].done).toBe(T0.toISOString())
    expect(markDone(done as never, 'po', '1', true, T0)).toBeNull()
    expect(markDone(done as never, 'po', '1', false, T0)?.pins[0].done).toBeUndefined()
    const off = own({}, [{ c: 'po', id: '1' }])
    expect(markDone(off, 'po', '1', true, T0)).toBeNull()
    // A pin put back by hand is kept: never marked again.
    const kept = own({ remove_completed: true }, [{ c: 'po', id: '1', keep: true }])
    expect(markDone(kept, 'po', '1', true, T0)).toBeNull()
  })

  it('leaves 24 h after completion, or at once when seen after completion', () => {
    expect(isDue(T0.toISOString(), T0.getTime() + 23 * H, null)).toBe(false)
    expect(isDue(T0.toISOString(), T0.getTime() + 24 * H, null)).toBe(true)
    expect(isDue(T0.toISOString(), T0.getTime() + H, '2026-11-15T10:30:00.000Z')).toBe(true)
    expect(isDue(T0.toISOString(), T0.getTime() + H, '2026-11-15T09:00:00.000Z')).toBe(false)

    const l = own(
      { remove_completed: true },
      [
        { c: 'po', id: '1', at: '2026-11-01T00:00:00Z', done: T0.toISOString() },
        { c: 'po', id: '2', at: '2026-11-01T00:00:00Z', done: T0.toISOString() },
        { c: 'po', id: '3', at: '2026-11-01T00:00:00Z' }
      ],
      {
        seen: { 'po:2': '2026-11-15T11:00:00.000Z' },
        alerts: [{ id: 'abcd1234', c: 'po', rid: '2', kind: 'overdue' }]
      }
    )
    const next = dueRemovals(l, new Date(T0.getTime() + 2 * H))
    expect(next?.pins.map((p) => p.id)).toEqual(['1', '3'])
    expect(next?.removed.map((r) => r.id)).toEqual(['2'])
    expect(next?.alerts).toEqual([])
    expect(next?.seen['po:2']).toBeUndefined()
    const later = dueRemovals(next as never, new Date(T0.getTime() + 25 * H))
    expect(later?.pins.map((p) => p.id)).toEqual(['3'])
    expect(later?.removed.map((r) => r.id).sort()).toEqual(['1', '2'])
    expect(dueRemovals(own({}, [{ c: 'po', id: '3' }]), T0)).toBeNull()
  })

  it('forgets a removed record after 7 days', () => {
    const l = own({ remove_completed: true }, [], {
      removed: [
        {
          c: 'po',
          id: '9',
          at: '2026-11-01T00:00:00Z',
          done: T0.toISOString(),
          gone: T0.toISOString()
        }
      ]
    })
    expect(dueRemovals(l, new Date(T0.getTime() + H))).toBeNull()
    expect(dueRemovals(l, new Date(T0.getTime() + REMOVED_KEEP_MS + 1))?.removed).toEqual([])
  })

  it('puts a removed record back as it was, and keeps it from then on', () => {
    const l = own({ remove_completed: true }, [], {
      removed: [
        {
          c: 'po',
          id: '9',
          at: '2026-11-01T00:00:00.000Z',
          auto: true,
          done: T0.toISOString(),
          gone: T0.toISOString()
        }
      ]
    })
    const back = restoreRemoved(l, 'po', '9', T0)
    expect(back?.pins[0]).toMatchObject({
      c: 'po',
      id: '9',
      at: '2026-11-01T00:00:00.000Z',
      auto: true,
      keep: true
    })
    expect(back?.removed).toEqual([])
    expect(markDone(back as never, 'po', '9', true, T0)).toBeNull()
    expect(restoreRemoved(l, 'po', 'nope', T0)).toBeNull()
  })

  it('shared lists: new lists start on, older ones read as off; completed records leave after 24 h', () => {
    const fresh = newTeam({
      owner: OWNER,
      name: 'Ops',
      members: [],
      creatorMayStayOff: false,
      now: T0
    })
    expect(fresh.remove_completed).toBe(true)
    const old = normalizeTeam({ id: `${OWNER}~abc12345`, name: 'Old', owner: OWNER, members: [] })
    expect(old?.remove_completed).toBe(false)

    const team = { ...fresh, pins: [{ c: 'po', id: '1', at: '2026-11-01T00:00:00Z', by: OWNER }] }
    const list = normalizeWatchList({ teams: [team] })
    const marked = markDone(list, 'po', '1', true, T0)
    expect(marked?.teams[0].pins[0].done).toBe(T0.toISOString())
    // No single "seen" on a shared list: it waits the 24 h.
    expect(dueRemovals(marked as never, new Date(T0.getTime() + H))).toBeNull()
    const gone = dueRemovals(marked as never, new Date(T0.getTime() + 24 * H))
    expect(gone?.teams[0].pins).toEqual([])
    expect(gone?.teams[0].removed.map((r) => r.id)).toEqual(['1'])
    const undo = restoreTeamRemoved(gone?.teams[0] as never, 'po', '1')
    expect(undo?.pins[0]).toMatchObject({ id: '1', keep: true })

    const offList = normalizeWatchList({ teams: [{ ...team, remove_completed: false }] })
    expect(markDone(offList, 'po', '1', true, T0)).toBeNull()
  })
})
