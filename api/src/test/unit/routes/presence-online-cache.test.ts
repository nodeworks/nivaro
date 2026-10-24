import { beforeEach, describe, expect, it, vi } from 'vitest'

// A chainable knex stand-in: every builder method returns the builder, awaiting it answers by
// table. Enough for GET /presence/online's reads.
const state = vi.hoisted(() => ({
  presenceReads: 0,
  listedReads: 0,
  presenceRows: [] as Array<Record<string, unknown>>,
  deadlockOnce: false,
  /** viewer id → their own restrict rows */
  ownScopes: {} as Record<string, Array<{ dimension: string; values: string }>>,
  /** the listed people's restrict rows */
  listedScopes: [] as Array<{ user: string; dimension: string; values: string }>,
  adminIds: [] as string[],
  /** listed person → manager */
  managers: {} as Record<string, string>,
  /** account names, for rows with no presence name yet */
  accounts: {} as Record<string, { first_name?: string; last_name?: string; email?: string }>
}))

vi.mock('../../../db/index.js', () => {
  const make = (table: string) => {
    const calls: { where: unknown[]; whereIn: unknown[] } = { where: [], whereIn: [] }
    const b: Record<string, unknown> = {}
    for (const m of [
      'join',
      'orderBy',
      'limit',
      'select',
      'whereNull',
      'groupBy',
      'max',
      'orWhereNull'
    ])
      b[m] = () => b
    b.where = (...args: unknown[]) => {
      calls.where.push(args[0])
      return b
    }
    b.whereIn = (...args: unknown[]) => {
      calls.whereIn.push(args)
      return b
    }
    // Every collection named in a path is registered (resolveRecordLabels checks).
    b.first = async () => (table === 'nivaro_collections' ? { collection: 'requests' } : undefined)
    const answer = async (): Promise<unknown[]> => {
      if (table === 'user_presence') {
        state.presenceReads++
        if (state.deadlockOnce) {
          state.deadlockOnce = false
          throw Object.assign(new Error('deadlock victim'), { number: 1205 })
        }
        return state.presenceRows.map((r) => ({ ...r }))
      }
      if (table === 'nivaro_user_scopes') {
        const own = calls.where.find(
          (w) => w && typeof w === 'object' && 'user' in (w as Record<string, unknown>)
        ) as { user?: string } | undefined
        if (own) return state.ownScopes[String(own.user)] ?? []
        state.listedReads++
        return state.listedScopes
      }
      if (table === 'nivaro_users as u') return state.adminIds.map((id) => ({ id }))
      if (table === 'nivaro_users')
        return state.presenceRows.map((r) => ({
          id: r.user_id,
          preferences: null,
          manager_id: state.managers[String(r.user_id)] ?? null,
          ...state.accounts[String(r.user_id)]
        }))
      return []
    }
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited as a thenable
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => answer().then(res, rej)
    return b
  }
  const db = Object.assign((table: string) => make(table), {
    from: (table: unknown) => make(typeof table === 'string' ? table : 'user_presence'),
    raw: () => ({}),
    client: { config: { client: 'pg' } }
  })
  return { db }
})
vi.mock('../../../services/masquerade-marker.js', () => ({
  activeMasquerades: vi.fn(async () => new Map())
}))
vi.mock('../../../services/huddle-presence.js', () => ({
  huddlingUsers: vi.fn(async () => new Set())
}))
const stuck = vi.hoisted(() => ({ minutes: new Map<string, number>() }))
vi.mock('../../../services/presence-stuck.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/presence-stuck.js')>()),
  stuckMinutes: vi.fn(async () => stuck.minutes)
}))
// Labels go through the viewer's OWN read access: here only viewer R1 may read requests:5.
const labelCalls = vi.hoisted(() => ({ viewers: [] as string[] }))
vi.mock('../../../services/ai-link-labels.js', () => ({
  linkLabelsAsUser: vi.fn(async (viewer: { id: string }, byTarget: Map<string, Set<string>>) => {
    labelCalls.viewers.push(viewer.id)
    return viewer.id === 'R1' && byTarget.get('requests')?.has('5') ? { 'requests:5': 'REQ-5' } : {}
  })
}))
vi.mock('../../../plugins/socketio.js', () => ({
  getClusterStaleBuilds: vi.fn(async () => new Map())
}))

import {
  presenceOnlineCounters,
  presenceOnlineFor,
  resetPresenceOnlineCache,
  visibilitySignature,
  visibleToViewer
} from '../../../routes/presence.js'
import { resetSingleFlight } from '../../../services/single-flight.js'

const app = { redis: {} } as never
const user = (id: string) => ({ id, role: 'R' }) as never

const ZONE1 = [{ dimension: 'zone', values: '["1"]' }]
const ZONE2 = [{ dimension: 'zone', values: '["2"]' }]

beforeEach(() => {
  resetPresenceOnlineCache()
  resetSingleFlight()
  state.presenceReads = 0
  state.listedReads = 0
  state.deadlockOnce = false
  state.adminIds = []
  state.managers = {}
  state.accounts = {}
  stuck.minutes = new Map()
  labelCalls.viewers = []
  presenceOnlineCounters.signatures = 0
  presenceOnlineCounters.persons = 0
  const seen = new Date()
  state.presenceRows = [
    { user_id: 'A', display_name: 'Ann', last_seen: seen, is_online: true },
    { user_id: 'B', display_name: 'Bob', last_seen: seen, is_online: true }
  ]
  // RESTRICTED (and R1/R2) are limited to zone 1; Z2 to zone 2. A is in zone 1, B in zone 2.
  state.ownScopes = { RESTRICTED: ZONE1, R1: ZONE1, R2: ZONE1, Z2: ZONE2 }
  state.listedScopes = [
    { user: 'A', dimension: 'zone', values: '["1"]' },
    { user: 'B', dimension: 'zone', values: '["2"]' }
  ]
})

const ids = (a: { data: Array<Record<string, unknown>> }) => a.data.map((r) => r.user_id)

describe('GET /presence/online cache', () => {
  it('a burst of viewers shares ONE presence read', async () => {
    const answers = await Promise.all(
      ['U1', 'U2', 'U3', 'U1', 'U2'].map((id) => presenceOnlineFor(app, user(id), false))
    )
    expect(state.presenceReads).toBe(1)
    for (const a of answers) expect(ids(a)).toEqual(['A', 'B'])
  })

  it("applies each viewer's visibility on top of the shared base", async () => {
    const open = await presenceOnlineFor(app, user('OPEN'), false)
    const restricted = await presenceOnlineFor(app, user('RESTRICTED'), false)
    expect(state.presenceReads).toBe(1)
    expect(ids(open)).toEqual(['A', 'B'])
    // Zone-1 viewer: never sees B (zone 2), although the cached base lists B.
    expect(ids(restricted)).toEqual(['A'])
  })

  it('admin-only fields stay with admins', async () => {
    state.presenceRows[0].current_path = '/collections/secret/1'
    const admin = await presenceOnlineFor(app, user('ADM'), true)
    const plain = await presenceOnlineFor(app, user('U1'), false)
    expect(admin.data[0].current_path).toBe('/collections/secret/1')
    expect(plain.data[0].current_path).toBeUndefined()
    expect(plain.data[0]).not.toHaveProperty('stale_build')
  })

  it('an API-key caller is never served from the per-viewer cache', async () => {
    const keyed = { id: 'K', role: 'R', api_key_scopes: [{ collection: 'x', actions: [] }] }
    await presenceOnlineFor(app, keyed as never, false)
    await presenceOnlineFor(app, keyed as never, false)
    // Base and signature are still shared (one read); the person step simply runs each time.
    expect(state.presenceReads).toBe(1)
    expect(presenceOnlineCounters.signatures).toBe(1)
    expect(presenceOnlineCounters.persons).toBe(2)
  })

  it('names a row the socket created before the first beat from the account', async () => {
    const seen = new Date()
    state.presenceRows.push(
      { user_id: 'C', display_name: null, last_seen: seen, is_online: true },
      { user_id: 'D', display_name: '  ', last_seen: seen, is_online: true }
    )
    state.accounts = { C: { first_name: 'Eddy', last_name: 'Rodriguez' }, D: { email: 'd@x.test' } }
    const a = await presenceOnlineFor(app, user('U1'), false)
    const names = Object.fromEntries(a.data.map((r) => [r.user_id, r.display_name]))
    expect(names).toEqual({ A: 'Ann', B: 'Bob', C: 'Eddy Rodriguez', D: 'd@x.test' })
  })

  it('retries the presence read once when it loses a deadlock', async () => {
    state.deadlockOnce = true
    const a = await presenceOnlineFor(app, user('U1'), false)
    expect(ids(a)).toEqual(['A', 'B'])
    expect(state.presenceReads).toBe(2)
  })
})

describe('GET /presence/online — visibility signature', () => {
  it('two viewers restricted the same way share ONE signature answer and get identical data', async () => {
    const a1 = await presenceOnlineFor(app, user('R1'), false)
    const a2 = await presenceOnlineFor(app, user('R2'), false)
    expect(presenceOnlineCounters.signatures).toBe(1)
    expect(state.listedReads).toBe(1)
    expect(a2).toEqual(a1)
    expect(ids(a1)).toEqual(['A'])
  })

  it('unrestricted viewers share one signature; many viewers cost one computation', async () => {
    const viewers = Array.from({ length: 50 }, (_, i) => `P${i}`)
    const answers = await Promise.all(viewers.map((v) => presenceOnlineFor(app, user(v), false)))
    expect(presenceOnlineCounters.signatures).toBe(1)
    expect(presenceOnlineCounters.persons).toBe(50)
    for (const a of answers) expect(a).toEqual(answers[0])
    // Unrestricted viewers never need the listed people's restrictions.
    expect(state.listedReads).toBe(0)
  })

  it('a different signature never sees what another signature sees', async () => {
    // Warm the zone-1 and admin signatures first, then ask as zone 2 and as unrestricted.
    const z1 = await presenceOnlineFor(app, user('R1'), false)
    state.presenceRows[1].current_path = '/collections/secret/9'
    const admin = await presenceOnlineFor(app, user('ADM'), true)
    const z2 = await presenceOnlineFor(app, user('Z2'), false)
    const open = await presenceOnlineFor(app, user('OPEN'), false)
    expect(ids(z1)).toEqual(['A'])
    expect(ids(z2)).toEqual(['B'])
    expect(ids(open)).toEqual(['A', 'B'])
    expect(ids(admin)).toEqual(['A', 'B'])
    for (const r of [...z2.data, ...open.data]) expect(r.current_path).toBeUndefined()
    expect(presenceOnlineCounters.signatures).toBe(4)
  })

  it('a listed admin is visible to restricted signatures', async () => {
    state.presenceRows.push({ user_id: 'BOSS', display_name: 'Zed', last_seen: new Date() })
    state.adminIds = ['BOSS']
    expect(ids(await presenceOnlineFor(app, user('R1'), false))).toEqual(['A', 'BOSS'])
    expect(ids(await presenceOnlineFor(app, user('Z2'), false))).toEqual(['B', 'BOSS'])
  })

  it('a viewer always sees themself, and nobody else gets them through the shared answer', async () => {
    // D is online and restricted to zone 1 by their own rows, but (a read later) no listed
    // restriction backs them, so the zone-1 signature does not list D.
    state.presenceRows.push({ user_id: 'D', display_name: 'Dee', last_seen: new Date() })
    state.ownScopes.D = ZONE1
    const d = await presenceOnlineFor(app, user('D'), false)
    const r1 = await presenceOnlineFor(app, user('R1'), false)
    expect(presenceOnlineCounters.signatures).toBe(1) // same signature
    expect(ids(d)).toEqual(['A', 'D'])
    expect(ids(r1)).toEqual(['A'])
  })

  it('matches visibleToViewer exactly for every viewer', async () => {
    state.presenceRows.push(
      { user_id: 'BOSS', display_name: 'Zed', last_seen: new Date() },
      { user_id: 'NOSCOPE', display_name: 'Nia', last_seen: new Date() }
    )
    state.adminIds = ['BOSS']
    for (const v of ['R1', 'R2', 'Z2', 'OPEN', 'A', 'B']) {
      const answer = await presenceOnlineFor(app, user(v), false)
      const expected = await visibleToViewer(
        { id: v },
        false,
        state.presenceRows.map((r) => String(r.user_id))
      )
      expect(new Set(ids(answer))).toEqual(expected)
    }
  })

  it('page labels stay per person: same signature, different read access, different label', async () => {
    state.presenceRows[0].current_path = '/collections/requests/5'
    const r1 = await presenceOnlineFor(app, user('R1'), false)
    const r2 = await presenceOnlineFor(app, user('R2'), false)
    expect(presenceOnlineCounters.signatures).toBe(1)
    expect(r1.data[0].page).toBe('Requests › REQ-5')
    // R2 may not read the record: the collection title only, never R1's label.
    expect(r2.data[0].page).toBe('Requests')
    expect(labelCalls.viewers).toEqual(['R1', 'R2'])
  })

  it("stuck shows to admins and the person's own manager only, from the shared answer", async () => {
    state.presenceRows[0].last_active = new Date()
    state.managers = { A: 'MGR' }
    stuck.minutes = new Map([['A', 14]])
    const mgr = await presenceOnlineFor(app, user('MGR'), false)
    const other = await presenceOnlineFor(app, user('OTHER'), false)
    const admin = await presenceOnlineFor(app, user('ADM'), true)
    expect(presenceOnlineCounters.signatures).toBe(2) // open + admin
    expect(mgr.data[0]).toMatchObject({ state: 'stuck', stuck: { minutes: 14 } })
    expect(other.data[0]).toMatchObject({ state: 'active', stuck: null })
    expect(admin.data[0]).toMatchObject({ state: 'stuck', stuck: { minutes: 14 } })
  })

  it('the signature is order-free and tells restrictions apart', () => {
    const s = (entries: Array<[string, string[]]>) =>
      visibilitySignature(false, new Map(entries.map(([d, v]) => [d, new Set(v)])))
    expect(
      s([
        ['zone', ['1', '2']],
        ['region', ['x']]
      ])
    ).toBe(
      s([
        ['region', ['x']],
        ['zone', ['2', '1']]
      ])
    )
    expect(s([['zone', ['1']]])).not.toBe(s([['zone', ['2']]]))
    expect(s([['zone', ['1']]])).not.toBe(
      s([
        ['zone', ['1']],
        ['region', ['x']]
      ])
    )
    expect(s([])).toBe('open')
    expect(visibilitySignature(true, new Map([['zone', new Set(['1'])]]))).toBe('admin')
  })
})
