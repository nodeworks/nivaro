import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// One person's preferences row, read and written through the route.
let stored: string | null = null
const writes: string[] = []
vi.mock('../db/index.js', () => {
  const chain = () => {
    const c: Record<string, unknown> = {}
    c.where = () => c
    c.whereNull = () => c
    c.whereIn = () => c
    c.limit = () => c
    c.select = () => c
    // Lists of people (direct reports, listable people): none here.
    c.catch = async () => []
    c.first = async () => ({ preferences: stored })
    c.update = async (v: { preferences: string }) => {
      stored = v.preferences
      writes.push(v.preferences)
      return 1
    }
    return c
  }
  return { db: chain }
})
vi.mock('../middleware/authenticate.js', () => ({ requireAuth: async () => {} }))
// The record read gate: record 7 is outside this person's scope.
const visibleAsked: string[] = []
vi.mock('../services/revision-access.js', () => ({
  recordVisibleTo: async (_req: unknown, c: string, id: string) => {
    visibleAsked.push(`${c}:${id}`)
    return id !== '7'
  }
}))
const announced: string[][] = []
vi.mock('../services/user-sync.js', () => ({
  announcePrefsChanged: (_u: string, keys: string[]) => announced.push(keys)
}))
vi.mock('../services/watch-list/rows.js', () => ({
  readWatchRows: async () => ({ rows: [], changed: [] })
}))
vi.mock('../services/watch-list/waiting.js', () => ({ readWaiting: async () => [] }))
vi.mock('../services/watch-list/mentions.js', () => ({
  readMentions: async () => ({ items: [], unread: 0 })
}))

import { watchListRoutes } from './watch-list.js'

let app: FastifyInstance
let viewAs = false
let authMethod: string | undefined = 'session'

beforeEach(async () => {
  stored = JSON.stringify({ theme_accent: 'teal' })
  writes.length = 0
  visibleAsked.length = 0
  announced.length = 0
  viewAs = false
  authMethod = 'session'
  app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { user: unknown }).user = { id: 'u-me' }
    ;(req as unknown as { authMethod?: string }).authMethod = authMethod
    if (viewAs) Object.assign(req, { authMethod: 'masquerade', masqueradeAdminId: 'admin-1' })
  })
  await app.register(watchListRoutes, { prefix: '/watch-list' })
})
afterEach(async () => {
  await app.close()
})

describe('watch list routes', () => {
  it('pins a readable record, keeps other preferences and tells other tabs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/watch-list/pins',
      payload: { collection: 'orders', id: '5' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.pins.map((p: { key: string }) => p.key)).toEqual(['orders:5'])
    const prefs = JSON.parse(stored as string)
    expect(prefs.theme_accent).toBe('teal')
    expect(prefs.watch_list.pins[0]).toMatchObject({ c: 'orders', id: '5' })
    expect(announced).toEqual([['watch_list']])
  })

  it('answers 404 for a record the person cannot open, and stores nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/watch-list/pins',
      payload: { collection: 'orders', id: '7' }
    })
    expect(res.statusCode).toBe(404)
    expect(visibleAsked).toEqual(['orders:7'])
    expect(writes).toHaveLength(0)
  })

  it('refuses system tables before any read', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/watch-list/pins',
      payload: { collection: 'nivaro_users', id: 'x' }
    })
    expect(res.statusCode).toBe(400)
    expect(visibleAsked).toHaveLength(0)
  })

  it('unpins without needing read access (a record they lost can still go)', async () => {
    stored = JSON.stringify({ watch_list: { pins: [{ c: 'orders', id: '7', at: '2026-11-01' }] } })
    const res = await app.inject({ method: 'DELETE', url: '/watch-list/pins/orders/7' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.pins).toEqual([])
    expect(visibleAsked).toHaveLength(0)
  })

  it('reads but never writes under View-as', async () => {
    viewAs = true
    const pin = await app.inject({
      method: 'POST',
      url: '/watch-list/pins',
      payload: { collection: 'orders', id: '5' }
    })
    expect(pin.statusCode).toBe(403)
    expect(pin.json().code).toBe('VIEW_AS_READ_ONLY')
    const dock = await app.inject({
      method: 'PATCH',
      url: '/watch-list/dock',
      payload: { state: 'minimized' }
    })
    expect(dock.statusCode).toBe(200)
    expect(dock.json().data.dock.state).toBe('minimized')
    const seen = await app.inject({ method: 'POST', url: '/watch-list/seen', payload: {} })
    expect(seen.statusCode).toBe(200)
    expect(writes).toHaveLength(0)
  })

  it('saves settings; removing automatically needs adding automatically', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/watch-list/settings',
      payload: { desktop: true, auto_remove: true, digest: 'yes' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.settings).toEqual({
      desktop: true,
      auto_add: false,
      auto_remove: false,
      digest: false,
      remove_completed: false
    })
    expect(JSON.parse(stored as string).theme_accent).toBe('teal')
  })

  it('adds an alert only on a pinned, readable record and removes it again', async () => {
    const notPinned = await app.inject({
      method: 'POST',
      url: '/watch-list/alerts',
      payload: { collection: 'orders', id: '5', kind: 'overdue' }
    })
    expect(notPinned.statusCode).toBe(409)
    expect(notPinned.json().code).toBe('NOT_PINNED')
    const hidden = await app.inject({
      method: 'POST',
      url: '/watch-list/alerts',
      payload: { collection: 'orders', id: '7', kind: 'overdue' }
    })
    expect(hidden.statusCode).toBe(404)

    stored = JSON.stringify({ watch_list: { pins: [{ c: 'orders', id: '5', at: '2026-11-01' }] } })
    const ok = await app.inject({
      method: 'POST',
      url: '/watch-list/alerts',
      payload: { collection: 'orders', id: '5', kind: 'step', step: 'approved', label: 'Approved' }
    })
    expect(ok.statusCode).toBe(200)
    const alerts = ok.json().data.alerts
    expect(alerts).toEqual([
      expect.objectContaining({ key: 'orders:5', kind: 'step', step: 'approved', repeat: false })
    ])
    expect(JSON.parse(stored as string).watch_list.wl_alerts).toBe(true)
    const del = await app.inject({ method: 'DELETE', url: `/watch-list/alerts/${alerts[0].id}` })
    expect(del.json().data.alerts).toEqual([])
  })

  it('a completed record the person has now seen leaves the list, and Undo puts it back', async () => {
    const done = new Date(Date.now() - 3600_000).toISOString()
    stored = JSON.stringify({
      watch_list: {
        settings: { remove_completed: true },
        pins: [{ c: 'orders', id: '5', at: '2026-11-01T00:00:00Z', done }]
      }
    })
    const seen = await app.inject({
      method: 'POST',
      url: '/watch-list/seen',
      payload: { keys: ['orders:5'] }
    })
    expect(seen.statusCode).toBe(200)
    expect(seen.json().data.pins).toEqual([])
    expect(seen.json().data.removed).toEqual([
      expect.objectContaining({ key: 'orders:5', done_at: done })
    ])
    const back = await app.inject({
      method: 'POST',
      url: '/watch-list/removed/restore',
      payload: { collection: 'orders', id: '5' }
    })
    expect(back.statusCode).toBe(200)
    expect(back.json().data.pins.map((p: { key: string }) => p.key)).toEqual(['orders:5'])
    expect(back.json().data.removed).toEqual([])
    expect(JSON.parse(stored as string).watch_list.pins[0].keep).toBe(true)
  })

  it('answers 404 for a shared list that does not exist (never says whose it is)', async () => {
    const res = await app.inject({ method: 'GET', url: '/watch-list/teams/nope/rows' })
    expect(res.statusCode).toBe(404)
  })

  it('saves the dock within its bounds', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/watch-list/dock',
      payload: { state: 'closed', width: 5000, tab: 'waiting' }
    })
    expect(res.json().data.dock).toEqual({
      state: 'closed',
      width: 480,
      tab: 'waiting',
      sort: 'mine'
    })
  })

  it('shared lists are made and changed only on a person’s own sign-in (L7)', async () => {
    for (const m of ['api_key', 'oauth', 'token', 'key_sim', undefined]) {
      authMethod = m
      const res = await app.inject({
        method: 'POST',
        url: '/watch-list/teams',
        payload: { name: 'Ops', members: ['u-other'] }
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe('TEAM_LIST_PEOPLE_ONLY')
      for (const [method, url] of [
        ['PATCH', '/watch-list/teams/u-me~abcdefgh'],
        ['DELETE', '/watch-list/teams/u-me~abcdefgh'],
        ['POST', '/watch-list/teams/u-me~abcdefgh/take-over']
      ] as const) {
        const r = await app.inject({ method, url, payload: { name: 'X' } })
        expect(r.json().code).toBe('TEAM_LIST_PEOPLE_ONLY')
      }
    }
    expect(writes).toEqual([])
    // A browser session (or the phone app) makes one.
    for (const m of ['session', 'device']) {
      authMethod = m
      const ok = await app.inject({
        method: 'POST',
        url: '/watch-list/teams',
        payload: { name: `Ops ${m}` }
      })
      expect(ok.statusCode).toBe(200)
      expect(ok.json().data.created).toBeTruthy()
    }
  })
})
