import { describe, expect, it } from 'vitest'
import { normalizeWatchList, WATCH_PINS_MAX } from './store.js'
import {
  isMember,
  markTeamSeen,
  mayManage,
  maySee,
  memberIds,
  newTeam,
  teamAddPin,
  teamAsWatchList,
  teamName,
  teamOwnerOf,
  teamRemovePin,
  withMembers
} from './teams.js'

const T0 = new Date('2026-11-14T10:00:00Z')
const T1 = new Date('2026-11-14T12:00:00Z')
const ME = 'aaaa-1111'

describe('shared watch lists', () => {
  it('a list made by someone on the team always includes them', () => {
    const t = newTeam({
      owner: ME,
      name: 'Ops',
      members: ['bbbb'],
      creatorMayStayOff: false,
      now: T0
    })
    expect(t.members.map((m) => m.u)).toEqual([ME, 'bbbb'])
    expect(teamOwnerOf(t.id)).toBe(ME)
    expect(t.id).toMatch(/^aaaa-1111~[a-z0-9]{8}$/)
  })

  it('an administrator or manager may make one they are not on', () => {
    const t = newTeam({
      owner: ME,
      name: 'Ops',
      members: ['bbbb'],
      creatorMayStayOff: true,
      now: T0
    })
    expect(isMember(t, ME)).toBe(false)
    expect(maySee(t, ME, false)).toBe(true) // the owner
    expect(mayManage(t, ME, false)).toBe(true)
    expect(maySee(t, 'cccc', false)).toBe(false)
    expect(maySee(t, 'cccc', true)).toBe(true)
    expect(mayManage(t, 'bbbb', false)).toBe(false)
  })

  it('people who stay keep their join time; new people join now', () => {
    const t = newTeam({
      owner: ME,
      name: 'Ops',
      members: ['bbbb'],
      creatorMayStayOff: false,
      now: T0
    })
    const next = withMembers(t, ['bbbb', 'cccc'], T1)
    expect(next.members).toEqual([
      { u: 'bbbb', at: T0.toISOString() },
      { u: 'cccc', at: T1.toISOString() }
    ])
  })

  it('cleans names and member lists', () => {
    expect(teamName('  Night   shift ')).toBe('Night shift')
    expect(teamName('   ')).toBeNull()
    expect(memberIds(['a-1', 'A-1', 'bad id', 7, 'b-2'])).toEqual(['a-1', 'b-2'])
  })

  it('adds and removes records, refusing past the cap', () => {
    let t = newTeam({ owner: ME, name: 'Ops', members: [], creatorMayStayOff: false, now: T0 })
    const r = teamAddPin(t, 'orders', '5', ME, T0)
    expect(r.ok && r.changed).toBe(true)
    if (!r.ok) return
    expect(teamAddPin(r.team, 'orders', '5', ME, T0)).toMatchObject({ ok: true, changed: false })
    expect(teamRemovePin(r.team, 'orders', '5').pins).toEqual([])
    t = {
      ...t,
      pins: Array.from({ length: WATCH_PINS_MAX }, (_, i) => ({
        c: 'o',
        id: `${i}`,
        at: '',
        by: ME
      }))
    }
    expect(teamAddPin(t, 'orders', '5', ME, T0)).toMatchObject({
      ok: false,
      code: 'WATCH_LIST_FULL'
    })
  })

  it('reads as one viewer: nothing before they joined is new to them; their own seen marks apply', () => {
    let t = newTeam({ owner: ME, name: 'Ops', members: [], creatorMayStayOff: false, now: T0 })
    t = withMembers(t, [ME, 'late'], T1)
    t = { ...t, pins: [{ c: 'orders', id: '5', at: T0.toISOString(), by: ME }] }
    const viewer = normalizeWatchList(undefined)
    const asLate = teamAsWatchList(t, 'late', viewer)
    expect(asLate.pins[0].at).toBe(T1.toISOString())
    const seenNow = markTeamSeen(viewer, t, null, new Date('2026-11-14T13:00:00Z'))
    expect(seenNow.team_seen[`${t.id}|orders:5`]).toBe('2026-11-14T13:00:00.000Z')
    expect(teamAsWatchList(t, ME, seenNow).seen['orders:5']).toBe('2026-11-14T13:00:00.000Z')
  })
})
