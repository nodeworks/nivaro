import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// An administrator signing a person out may leave a message (2026-11-10, Rob):
// stored for their next sign-in, sent to their open tabs, never blocks the sign-out.

const state = vi.hoisted(() => ({
  activity: [] as Array<Record<string, unknown>>,
  emitted: [] as Array<{ user: string; event: string; payload: unknown }>,
  self: null as { id: string } | null
}))
vi.mock('../../../db/index.js', () => {
  const q: Record<string, unknown> = {
    where: () => q,
    whereIn: () => q,
    first: async () => ({
      id: 'AAAAAAAA-0000-4000-8000-000000000002',
      first_name: 'Jane',
      last_name: 'Roe'
    }),
    select: async () => [],
    del: async () => 0
  }
  return { db: () => q }
})
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (a: Record<string, unknown>) => {
    state.activity.push(a)
    return 1
  }
}))
vi.mock('../../../services/socket-access.js', () => ({ endSessionSockets: () => {} }))
vi.mock('../../../services/user-sync.js', () => ({
  emitToUserRoom: (user: string, event: string, payload: unknown) =>
    state.emitted.push({ user, event, payload })
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'ADMIN000-0000-4000-8000-000000000001', first_name: 'Rob', last_name: 'Lee' }
    req.isAdmin = true
  },
  authenticate: async (req: { user?: unknown }) => {
    if (state.self) req.user = { id: state.self.id }
  }
}))

import { securityRoutes, securitySelfRoutes } from '../../../routes/security.js'
import {
  parseSignOutMessage,
  SIGN_OUT_NOTE_MAX,
  signOutNoteKey
} from '../../../services/sign-out-note.js'

const JANE = 'aaaaaaaa-0000-4000-8000-000000000002'
const JANE_UP = JANE.toUpperCase()

function fakeRedis(opts: { failSet?: boolean } = {}) {
  const kv = new Map<string, string>([['sess:a1', JSON.stringify({ userId: JANE_UP })]])
  const r = {
    kv,
    async get(k: string) {
      return kv.get(k) ?? null
    },
    async set(k: string, v: string) {
      if (opts.failSet) throw new Error('redis down')
      kv.set(k, v)
      return 'OK'
    },
    async del(k: string) {
      return kv.delete(k) ? 1 : 0
    },
    async smembers() {
      return []
    },
    async scan(_c: string, _m: string, pattern: string) {
      const re = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`)
      return ['0', [...kv.keys()].filter((k) => re.test(k))]
    },
    async mget(...keys: string[]) {
      return keys.map((k) => kv.get(k) ?? null)
    },
    multi() {
      const ops: Array<() => void> = []
      const m = {
        del: (k: string) => (ops.push(() => kv.delete(k)), m),
        setex: (k: string, _t: number, v: string) => (ops.push(() => kv.set(k, v)), m),
        srem: () => m,
        smembers: () => m,
        exec: async () => ops.map((op) => op())
      }
      return m
    }
  }
  return r
}

async function adminApp(r: ReturnType<typeof fakeRedis>) {
  const app = Fastify()
  app.decorate('redis', r as never)
  await app.register(securityRoutes)
  return app
}

describe('sign-out note', () => {
  beforeEach(() => {
    state.activity = []
    state.emitted = []
    state.self = null
  })

  it('parses: blank = none, whitespace folded to one line, over the cap refused', () => {
    expect(parseSignOutMessage(undefined)).toEqual({ message: null })
    expect(parseSignOutMessage('   ')).toEqual({ message: null })
    expect(parseSignOutMessage('  Call me\n  before   you  log back in ')).toEqual({
      message: 'Call me before you log back in'
    })
    expect(parseSignOutMessage(42)).toHaveProperty('error')
    expect(parseSignOutMessage('x'.repeat(SIGN_OUT_NOTE_MAX))).toEqual({
      message: 'x'.repeat(SIGN_OUT_NOTE_MAX)
    })
    expect(parseSignOutMessage('x'.repeat(SIGN_OUT_NOTE_MAX + 1))).toHaveProperty('error')
  })

  it('with a message: stored for the next sign-in, sent to their tabs before the sessions end, logged', async () => {
    const r = fakeRedis()
    const app = await adminApp(r)
    const res = await app.inject({
      method: 'POST',
      url: `/users/${JANE}/sign-out`,
      payload: { message: 'Laptop left unlocked — call the help desk' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { revoked: 1, message_left: true } })
    const stored = JSON.parse(r.kv.get(signOutNoteKey(JANE_UP)) ?? 'null')
    expect(stored).toMatchObject({
      user_id: JANE_UP,
      message: 'Laptop left unlocked — call the help desk',
      by_name: 'Rob Lee'
    })
    expect(Number.isNaN(Date.parse(stored.at))).toBe(false)
    expect(state.emitted).toEqual([
      { user: JANE_UP, event: 'session:signed-out-note', payload: stored }
    ])
    expect(r.kv.has('sess:a1')).toBe(false)
    expect(String(state.activity[0].comment)).toContain('message left: “Laptop left unlocked')
  })

  it('without a message nothing is stored or sent — the sign-out is as before', async () => {
    const r = fakeRedis()
    const app = await adminApp(r)
    const res = await app.inject({ method: 'POST', url: `/users/${JANE}/sign-out`, payload: {} })
    expect(res.json()).toEqual({ data: { revoked: 1 } })
    expect(r.kv.has(signOutNoteKey(JANE_UP))).toBe(false)
    expect(state.emitted).toEqual([])
    expect(String(state.activity[0].comment)).not.toContain('message')
  })

  it('a message over the cap is refused before anything is signed out', async () => {
    const r = fakeRedis()
    const app = await adminApp(r)
    const res = await app.inject({
      method: 'POST',
      url: `/users/${JANE}/sign-out`,
      payload: { message: 'x'.repeat(SIGN_OUT_NOTE_MAX + 1) }
    })
    expect(res.statusCode).toBe(400)
    expect(r.kv.has('sess:a1')).toBe(true)
  })

  it('a note that cannot be stored never stops the sign-out; the answer says so', async () => {
    const r = fakeRedis({ failSet: true })
    const app = await adminApp(r)
    const res = await app.inject({
      method: 'POST',
      url: `/users/${JANE}/sign-out`,
      payload: { message: 'hello' }
    })
    expect(res.json()).toEqual({ data: { revoked: 1, message_left: false } })
    expect(r.kv.has('sess:a1')).toBe(false)
  })

  it('the person reads their own note once signed in, then clears it', async () => {
    const r = fakeRedis()
    await (await adminApp(r)).inject({
      method: 'POST',
      url: `/users/${JANE}/sign-out`,
      payload: { message: 'See me' }
    })
    const self = Fastify()
    self.decorate('redis', r as never)
    await self.register(securitySelfRoutes)
    expect((await self.inject({ method: 'GET', url: '/my/sign-out-note' })).statusCode).toBe(401)
    state.self = { id: JANE_UP }
    const got = await self.inject({ method: 'GET', url: '/my/sign-out-note' })
    expect(got.json().data).toMatchObject({ message: 'See me', by_name: 'Rob Lee' })
    expect((await self.inject({ method: 'DELETE', url: '/my/sign-out-note' })).statusCode).toBe(204)
    expect((await self.inject({ method: 'GET', url: '/my/sign-out-note' })).json()).toEqual({
      data: null
    })
    // someone else's note is never read
    state.self = { id: 'BBBBBBBB-0000-4000-8000-000000000003' }
    await (await adminApp(r)).inject({
      method: 'POST',
      url: `/users/${JANE}/sign-out`,
      payload: { message: 'private' }
    })
    expect((await self.inject({ method: 'GET', url: '/my/sign-out-note' })).json()).toEqual({
      data: null
    })
  })
})
