import { beforeEach, describe, expect, it, vi } from 'vitest'

// A chainable knex stand-in: every builder method returns the builder, awaiting it answers by
// table. Enough for GET /presence/online's reads.
const state = vi.hoisted(() => ({
  presenceReads: 0,
  presenceRows: [] as Array<Record<string, unknown>>,
  deadlockOnce: false
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
    b.first = async () => undefined
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
        // The viewer's own restriction: RESTRICTED is limited to zone 1.
        if (own) return own.user === 'RESTRICTED' ? [{ dimension: 'zone', values: '["1"]' }] : []
        // The listed people's restrictions: A in zone 1, B in zone 2.
        return [
          { user: 'A', dimension: 'zone', values: '["1"]' },
          { user: 'B', dimension: 'zone', values: '["2"]' }
        ]
      }
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
vi.mock('../../../services/presence-stuck.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/presence-stuck.js')>()),
  stuckMinutes: vi.fn(async () => new Map())
}))
vi.mock('../../../services/ai-link-labels.js', () => ({
  linkLabelsAsUser: vi.fn(async () => ({}))
}))
vi.mock('../../../plugins/socketio.js', () => ({
  getClusterStaleBuilds: vi.fn(async () => new Map())
}))

import { presenceOnlineFor, resetPresenceOnlineCache } from '../../../routes/presence.js'
import { resetSingleFlight } from '../../../services/single-flight.js'

const app = { redis: {} } as never
const user = (id: string) => ({ id, role: 'R' }) as never

beforeEach(() => {
  resetPresenceOnlineCache()
  resetSingleFlight()
  state.presenceReads = 0
  state.deadlockOnce = false
  const seen = new Date()
  state.presenceRows = [
    { user_id: 'A', display_name: 'Ann', last_seen: seen, is_online: true },
    { user_id: 'B', display_name: 'Bob', last_seen: seen, is_online: true }
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
  })

  it('an API-key caller is never served from the per-viewer cache', async () => {
    const keyed = { id: 'K', role: 'R', api_key_scopes: [{ collection: 'x', actions: [] }] }
    await presenceOnlineFor(app, keyed as never, false)
    await presenceOnlineFor(app, keyed as never, false)
    // Base is still shared (one read); the viewer step simply runs each time.
    expect(state.presenceReads).toBe(1)
  })

  it('retries the presence read once when it loses a deadlock', async () => {
    state.deadlockOnce = true
    const a = await presenceOnlineFor(app, user('U1'), false)
    expect(ids(a)).toEqual(['A', 'B'])
    expect(state.presenceReads).toBe(2)
  })
})
