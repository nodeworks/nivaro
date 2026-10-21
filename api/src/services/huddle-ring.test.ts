import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../types.js'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))

import type { HuddleRedis } from './huddle.js'
import {
  answerRing,
  cancelRing,
  clearRingTimersForTests,
  RING_MAX,
  type RingDeps,
  ringKey,
  ringTargets,
  ringUsers,
  timeOut
} from './huddle-ring.js'

function fakeRedis(): HuddleRedis {
  const store = new Map<string, unknown>()
  const h = (k: string) => (store.get(k) as Map<string, string>) ?? new Map<string, string>()
  return {
    async zadd() {},
    async zrem() {},
    async zremrangebyscore() {},
    async zrange() {
      return []
    },
    async zcard() {
      return 0
    },
    async hset(k, f, v) {
      const m = h(k)
      m.set(f, v)
      store.set(k, m)
    },
    async hget(k, f) {
      return h(k).get(f) ?? null
    },
    async hdel(k, f) {
      h(k).delete(f)
    },
    async hgetall(k) {
      return Object.fromEntries(h(k))
    },
    async expire() {},
    async set(k, v) {
      store.set(k, v)
    },
    async get(k) {
      const v = store.get(k)
      return typeof v === 'string' ? v : null
    },
    async del(...ks) {
      for (const k of ks) store.delete(k)
    }
  }
}

const rob = { first_name: 'Rob', last_name: 'Lee', email: 'rob@x', status: 'active' }
const amy = { first_name: 'Amy', last_name: null, email: 'amy@x', status: 'active' }
const bob = { first_name: 'Bob', last_name: null, email: 'bob@x', status: 'suspended' }

function makeDeps(over: Partial<RingDeps> = {}) {
  const sent: Array<{ to: string; event: string; payload: unknown }> = []
  const lines: string[] = []
  const notices: Array<{ to: string; subject: string }> = []
  const deps: RingDeps = {
    io: {
      to: (to: string) => ({
        emit: (event: string, payload: unknown) => {
          sent.push({ to, event, payload })
        }
      })
    } as never,
    redis: fakeRedis(),
    canSeeRoom: async () => true,
    postLine: async (_room, text) => {
      lines.push(text)
    },
    users: async () => new Map(),
    notify: async (to, n) => {
      notices.push({ to, subject: n.subject })
    },
    warn: () => {},
    timeoutMs: 1000,
    ...over
  }
  return { deps, sent, lines, notices }
}

const AMY = '11111111-1111-1111-1111-111111111111'
const BOB = '22222222-2222-2222-2222-222222222222'
const ROB = '33333333-3333-3333-3333-333333333333'

describe('ringTargets', () => {
  it('drops the caller, junk, duplicates; caps the list', () => {
    expect(ringTargets(ROB, [ROB.toLowerCase(), AMY, AMY.toLowerCase(), 'nope', 42, BOB])).toEqual([
      AMY,
      BOB
    ])
    const many = Array.from(
      { length: RING_MAX + 5 },
      (_, i) => `${String(i + 10).padStart(8, '0')}-0000-0000-0000-000000000000`
    )
    expect(ringTargets(ROB, many)).toHaveLength(RING_MAX)
  })
})

const robU = { ...rob, id: ROB } as unknown as User
const amyU = { ...amy, id: AMY } as unknown as User
const bobU = { ...bob, id: BOB } as unknown as User
const usersOf = async (want: string[]) =>
  new Map(
    [robU, amyU, bobU]
      .filter((u) => want.includes(u.id.toUpperCase()))
      .map((u) => [u.id.toUpperCase(), u])
  )

describe('ringUsers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    clearRingTimersForTests()
    vi.useRealTimers()
  })

  it('rings active people who can see the room: socket + notify; tells the caller', async () => {
    const { deps, sent, notices } = makeDeps({ users: usersOf })
    const rung = await ringUsers(deps, {
      tenant: null,
      room: 'dm:x',
      from: robU,
      users: [AMY, BOB]
    })
    expect(rung).toEqual([{ id: AMY, name: 'Amy' }])
    expect(sent.filter((s) => s.event === 'huddle:ring').map((s) => s.to)).toEqual([`user:${AMY}`])
    expect(sent.find((s) => s.event === 'huddle:ring')?.payload).toMatchObject({
      room: 'dm:x',
      from: ROB,
      name: 'Rob Lee'
    })
    expect(notices).toEqual([{ to: AMY, subject: 'Rob Lee is calling you' }])
    expect(sent.find((s) => s.event === 'huddle:ringing')).toMatchObject({
      to: `user:${ROB}`,
      payload: { room: 'dm:x', users: [{ id: AMY, name: 'Amy' }] }
    })
    expect(await deps.redis.hget(ringKey(null, 'dm:x'), AMY)).toBe('ringing')
  })

  it('never rings someone who cannot see the room, and never twice', async () => {
    const { deps, sent } = makeDeps({ users: usersOf, canSeeRoom: async (u) => u.id !== AMY })
    expect(await ringUsers(deps, { tenant: null, room: 'ch:a', from: robU, users: [AMY] })).toEqual(
      []
    )
    expect(sent).toEqual([])
    const ok = makeDeps({ users: usersOf })
    await ringUsers(ok.deps, { tenant: null, room: 'ch:a', from: robU, users: [AMY] })
    await ringUsers(ok.deps, { tenant: null, room: 'ch:a', from: robU, users: [AMY] })
    expect(ok.sent.filter((s) => s.event === 'huddle:ring')).toHaveLength(1)
  })

  it('a decline is a line and a result for the caller; an accept is only the result', async () => {
    const { deps, sent, lines } = makeDeps({ users: usersOf })
    await ringUsers(deps, { tenant: null, room: 'dm:x', from: robU, users: [AMY, BOB] })
    sent.length = 0
    expect(await answerRing(deps, { tenant: null, room: 'dm:x', user: amyU, accept: false })).toBe(
      true
    )
    expect(lines).toEqual(['Amy declined the call'])
    expect(sent).toEqual([
      {
        to: `user:${ROB}`,
        event: 'huddle:ring-result',
        payload: { room: 'dm:x', user: AMY, name: 'Amy', accept: false }
      }
    ])
    // Everyone answered: the call record is gone, a second answer is a no-op.
    expect(await deps.redis.hgetall(ringKey(null, 'dm:x'))).toEqual({})
    expect(await answerRing(deps, { tenant: null, room: 'dm:x', user: amyU, accept: true })).toBe(
      false
    )
  })

  it('no answer in time: "No answer" line, callee toast closed, caller told', async () => {
    const { deps, sent, lines } = makeDeps({ users: usersOf })
    await ringUsers(deps, { tenant: null, room: 'dm:x', from: robU, users: [AMY] })
    sent.length = 0
    await vi.advanceTimersByTimeAsync(1100)
    expect(lines).toEqual(['No answer from Amy'])
    expect(sent.map((s) => [s.to, s.event])).toEqual([
      [`user:${AMY}`, 'huddle:ring-cancel'],
      [`user:${ROB}`, 'huddle:ring-result']
    ])
    expect((sent[1].payload as { reason: string }).reason).toBe('timeout')
  })

  it('cancel by the caller closes the callees’ toasts without a line; others cannot cancel', async () => {
    const { deps, sent, lines } = makeDeps({ users: usersOf })
    await ringUsers(deps, { tenant: null, room: 'dm:x', from: robU, users: [AMY] })
    sent.length = 0
    expect(await cancelRing(deps, { tenant: null, room: 'dm:x', by: amyU })).toBe(false)
    expect(await cancelRing(deps, { tenant: null, room: 'dm:x', by: robU })).toBe(true)
    expect(sent).toEqual([
      {
        to: `user:${AMY}`,
        event: 'huddle:ring-cancel',
        payload: { room: 'dm:x', reason: 'cancelled' }
      }
    ])
    expect(lines).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(lines).toEqual([])
    await timeOut(deps, null, 'dm:x')
    expect(lines).toEqual([])
  })
})
