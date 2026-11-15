import { beforeEach, describe, expect, it, vi } from 'vitest'

// Security review L6: a shared list lives on its owner's preferences row, and two members pinning
// at once used to read the same list and the second write dropped the first pin. Writes are now a
// compare-and-swap on the row (plus one-at-a-time per person in this process).

const row: { preferences: string | null } = { preferences: null }
/** Run once right after the next read (simulates another process writing in between). */
let afterRead: Array<() => void> = []
let updates = 0

vi.mock('../../db/index.js', () => {
  const tick = () => new Promise((r) => setTimeout(r, 1))
  const make = () => {
    const conds: Array<[unknown, unknown]> = []
    let wantsNull = false
    const q = {
      where(a: unknown, b?: unknown) {
        conds.push([a, b])
        return q
      },
      whereNull() {
        wantsNull = true
        return q
      },
      async first() {
        const seen = { preferences: row.preferences }
        await tick()
        const hook = afterRead.shift()
        hook?.()
        return seen
      },
      async update(v: { preferences: string }) {
        await tick()
        updates++
        const named = conds.find((c) => c[0] === 'preferences')
        const same = wantsNull
          ? row.preferences == null
          : named
            ? named[1] === row.preferences
            : true
        if (!same) return 0
        row.preferences = v.preferences
        return 1
      }
    }
    return q
  }
  return { db: make }
})
vi.mock('../user-sync.js', () => ({ announcePrefsChanged: () => {} }))

import { normalizeWatchList } from './store.js'
import { newTeam, saveTeam, teamAddPin, updateTeam } from './teams.js'
import { loadWatchList, updateWatchList } from './user-store.js'

const OWNER = 'aaaa-1111'
const T0 = new Date('2026-11-15T10:00:00Z')

beforeEach(() => {
  row.preferences = JSON.stringify({ theme_accent: 'teal' })
  afterRead = []
  updates = 0
})

describe('watch list writes are compare-and-swap (L6)', () => {
  it('a write that lost the race re-reads and applies its change on top', async () => {
    // Another process adds a key between our read and our write.
    afterRead.push(() => {
      const p = JSON.parse(row.preferences as string)
      row.preferences = JSON.stringify({ ...p, other: 1 })
    })
    const next = await updateWatchList(OWNER, (l) => ({ ...l, dock: { ...l.dock, width: 420 } }))
    expect(next).not.toBeNull()
    const stored = JSON.parse(row.preferences as string)
    expect(stored.other).toBe(1) // the other writer's change kept
    expect(stored.theme_accent).toBe('teal')
    expect(normalizeWatchList(stored.watch_list).dock.width).toBe(420)
    expect(updates).toBe(2) // one refused, one landed
  })

  it('gives up with a 409 after three lost races (never a silent overwrite)', async () => {
    for (let i = 0; i < 3; i++)
      afterRead.push(() => {
        row.preferences = JSON.stringify({ n: Math.random() })
      })
    await expect(
      updateWatchList(OWNER, (l) => ({ ...l, dock: { ...l.dock, width: 400 } }))
    ).rejects.toMatchObject({ statusCode: 409, code: 'WATCH_LIST_BUSY' })
  })

  it('two members pinning to a shared list at once both land', async () => {
    const team = newTeam({
      owner: OWNER,
      name: 'Ops',
      members: ['bbbb', 'cccc'],
      creatorMayStayOff: false,
      now: T0
    })
    await saveTeam(null, team)
    const pin = (who: string, id: string) =>
      updateTeam(team.id, (cur) => {
        const res = teamAddPin(cur, 'orders', id, who, T0)
        return res.ok && res.changed ? res.team : undefined
      })
    await Promise.all([pin('bbbb', '1'), pin('cccc', '2'), pin(OWNER, '3')])
    const { list } = await loadWatchList(OWNER)
    const stored = list.teams.find((t) => t.id === team.id)
    expect(stored?.pins.map((p) => p.id).sort()).toEqual(['1', '2', '3'])
  })

  it('a pin made in another process between read and write is kept', async () => {
    const team = newTeam({
      owner: OWNER,
      name: 'Ops',
      members: ['bbbb'],
      creatorMayStayOff: false,
      now: T0
    })
    await saveTeam(null, team)
    // The other process's pin lands right after our read.
    afterRead.push(() => {
      const p = JSON.parse(row.preferences as string)
      const l = normalizeWatchList(p.watch_list)
      const t = l.teams[0]
      const res = teamAddPin(t, 'orders', '9', 'bbbb', T0)
      if (!res.ok) throw new Error('pin')
      p.watch_list.teams = [res.team]
      row.preferences = JSON.stringify(p)
    })
    await updateTeam(team.id, (cur) => {
      const res = teamAddPin(cur, 'orders', '1', OWNER, T0)
      return res.ok && res.changed ? res.team : undefined
    })
    const { list } = await loadWatchList(OWNER)
    expect(list.teams[0]?.pins.map((p) => p.id).sort()).toEqual(['1', '9'])
  })
})
