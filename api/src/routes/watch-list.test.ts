import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// One person's preferences row, read and written through the route.
let stored: string | null = null
const writes: string[] = []
vi.mock('../db/index.js', () => {
  const chain = () => {
    const c: Record<string, unknown> = {}
    c.where = () => c
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

beforeEach(async () => {
  stored = JSON.stringify({ theme_accent: 'teal' })
  writes.length = 0
  visibleAsked.length = 0
  announced.length = 0
  viewAs = false
  app = Fastify()
  app.addHook('preHandler', async (req) => {
    ;(req as unknown as { user: unknown }).user = { id: 'u-me' }
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
})
