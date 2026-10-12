import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1845 POST /ai/memory (the "Remember this?" click) and #1897 the admin
// view/clear of someone's Ask AI memory.

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001'
const PERSON = 'bbbbbbbb-0000-4000-8000-000000000002'
const who = vi.hoisted(() => ({ id: '', admin: false }))
const store = vi.hoisted(() => ({
  users: new Map<string, { id: string; preferences: string | null }>(),
  updates: [] as Array<{ id: string; preferences: string }>,
  tables: [] as string[],
  activity: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: who.id, role: 'R' }
    req.isAdmin = who.admin
  }
  return {
    authenticate,
    requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
      await authenticate(req)
      if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    }
  }
})
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (opts: Record<string, unknown>) => {
    const { req: _req, ...rest } = opts
    store.activity.push(rest)
    return 1
  })
}))
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    store.tables.push(table)
    let id = ''
    const b = {
      where: (w: { id: string }) => {
        id = w.id
        return b
      },
      first: async () => store.users.get(id),
      update: async (patch: { preferences: string }) => {
        store.updates.push({ id, preferences: patch.preferences })
        const row = store.users.get(id)
        if (row) row.preferences = patch.preferences
        return 1
      }
    }
    return b
  }
}))

import { aiMemoryAdminRoutes, aiMemoryRoutes } from '../../../routes/ai-memory.js'

const notes = [
  { id: 'n1', text: 'I work Zone 3 inventory requests', at: '2026-10-01T00:00:00.000Z' },
  { id: 'n2', text: 'amounts in thousands', at: '2026-10-02T00:00:00.000Z' }
]

async function app() {
  const a = Fastify()
  await a.register(aiMemoryRoutes, { prefix: '/api/ai' })
  await a.register(aiMemoryAdminRoutes, { prefix: '/api/users' })
  return a
}

const memoryOf = (id: string) =>
  (JSON.parse(store.users.get(id)?.preferences ?? '{}').ai_memory ?? []) as Array<{
    text: string
  }>

beforeEach(() => {
  store.users.clear()
  store.updates.length = 0
  store.tables.length = 0
  store.activity.length = 0
  store.users.set(ADMIN, { id: ADMIN, preferences: null })
  store.users.set(PERSON, { id: PERSON, preferences: JSON.stringify({ ai_memory: notes }) })
})

describe('POST /ai/memory — the "Remember this?" click (#1845)', () => {
  it('adds to the CALLER’s own memory only', async () => {
    who.id = PERSON
    who.admin = false
    const r = await (await app()).inject({
      method: 'POST',
      url: '/api/ai/memory',
      payload: { text: 'By my zone I mean Zone 3' }
    })
    expect(r.statusCode).toBe(200)
    expect(store.updates.map((u) => u.id)).toEqual([PERSON])
    expect(memoryOf(PERSON).map((n) => n.text)).toContain('By my zone I mean Zone 3')
    // Only the note — no conversation (history off or on), no other table.
    expect(new Set(store.tables)).toEqual(new Set(['nivaro_users']))
  })

  it('an admin’s click lands in the admin’s memory, never someone else’s', async () => {
    who.id = ADMIN
    who.admin = true
    await (await app()).inject({
      method: 'POST',
      url: '/api/ai/memory',
      payload: { text: 'Planted note', user: PERSON, id: PERSON }
    })
    expect(store.updates.map((u) => u.id)).toEqual([ADMIN])
    expect(memoryOf(PERSON)).toHaveLength(2)
  })

  it('refuses an empty or over-long note', async () => {
    who.id = PERSON
    const a = await app()
    expect(
      (await a.inject({ method: 'POST', url: '/api/ai/memory', payload: {} })).statusCode
    ).toBe(400)
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/api/ai/memory',
          payload: { text: 'x'.repeat(301) }
        })
      ).statusCode
    ).toBe(400)
    expect(store.updates).toEqual([])
  })
})

describe('admin view / clear of someone’s Ask AI memory (#1897)', () => {
  it('a non-admin gets 403 on another person’s memory — read and clear', async () => {
    who.id = ADMIN // any id: not an admin this time
    who.admin = false
    const a = await app()
    for (const [method, url] of [
      ['GET', `/api/users/${PERSON}/ai-memory`],
      ['DELETE', `/api/users/${PERSON}/ai-memory`],
      ['DELETE', `/api/users/${PERSON}/ai-memory/n1`]
    ] as const) {
      expect((await a.inject({ method, url })).statusCode).toBe(403)
    }
    expect(store.updates).toEqual([])
    expect(store.activity).toEqual([])
  })

  it('an admin view returns the notes and writes an activity row (counts, never the text)', async () => {
    who.id = ADMIN
    who.admin = true
    const r = await (await app()).inject({ method: 'GET', url: `/api/users/${PERSON}/ai-memory` })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.notes.map((n: { id: string }) => n.id)).toEqual(['n1', 'n2'])
    expect(store.activity).toEqual([
      expect.objectContaining({
        action: 'ai-memory-view',
        user: ADMIN,
        collection: 'nivaro_users',
        item: PERSON
      })
    ])
    expect(String(store.activity[0].comment)).not.toContain('Zone 3')
  })

  it('clearing one note and then all writes an activity row each', async () => {
    who.id = ADMIN
    who.admin = true
    const a = await app()
    const one = await a.inject({ method: 'DELETE', url: `/api/users/${PERSON}/ai-memory/n1` })
    expect(one.json().data).toEqual({ removed: 1, remaining: 1 })
    expect(memoryOf(PERSON).map((n) => n.text)).toEqual(['amounts in thousands'])
    const all = await a.inject({ method: 'DELETE', url: `/api/users/${PERSON}/ai-memory` })
    expect(all.json().data).toEqual({ removed: 1, remaining: 0 })
    expect(memoryOf(PERSON)).toEqual([])
    expect(store.activity.map((x) => x.action)).toEqual(['ai-memory-clear', 'ai-memory-clear'])
  })

  it('an unknown note or person is a 404 with no activity row', async () => {
    who.id = ADMIN
    who.admin = true
    const a = await app()
    expect(
      (await a.inject({ method: 'DELETE', url: `/api/users/${PERSON}/ai-memory/nope` })).statusCode
    ).toBe(404)
    expect(
      (
        await a.inject({
          method: 'GET',
          url: '/api/users/cccccccc-0000-4000-8000-000000000003/ai-memory'
        })
      ).statusCode
    ).toBe(404)
    expect(
      (await a.inject({ method: 'GET', url: '/api/users/not-a-uuid/ai-memory' })).statusCode
    ).toBe(404)
    expect(store.activity).toEqual([])
  })

  it('an admin can never add or reword a note — there is no write route', async () => {
    who.id = ADMIN
    who.admin = true
    const a = await app()
    for (const method of ['POST', 'PATCH', 'PUT'] as const) {
      for (const url of [`/api/users/${PERSON}/ai-memory`, `/api/users/${PERSON}/ai-memory/n1`]) {
        const r = await a.inject({
          method,
          url,
          payload: { text: 'Planted', ai_memory: ['Planted'] }
        })
        expect(r.statusCode).toBe(404)
      }
    }
    expect(store.updates).toEqual([])
    expect(memoryOf(PERSON)).toHaveLength(2)
  })
})
