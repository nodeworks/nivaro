import { describe, expect, it, vi } from 'vitest'
import type { User } from '../types.js'

vi.mock('./socket-tenant.js', () => ({
  inSocketTenant: (_s: unknown, h: (...a: unknown[]) => unknown) => h
}))

import {
  invalidateHuddleMarks,
  MARK_ACCESS_TTL_MS,
  MARK_BURST,
  MARK_BYTES_BURST,
  MARK_MAX_POINTS,
  MARK_SLOW_NOTICE_MS,
  type MarkContext,
  markBucket,
  parseMark,
  registerHuddleMarks
} from './huddle-marks.js'

const user = { id: 'U1', first_name: 'Rob' } as unknown as User

function setup(over: Partial<MarkContext> = {}, roster = ['S1', 'S2', 'S3']) {
  const handlers = new Map<string, (p: unknown) => Promise<void>>()
  const notices: Array<{ event: string; payload: any }> = []
  const socket = {
    id: 'S1',
    on: (e: string, h: any) => handlers.set(e, h),
    emit: (event: string, payload: unknown) => notices.push({ event, payload })
  } as any
  const sent: Array<{ to: string[]; event: string; payload: any }> = []
  const io = {
    to: (to: string[]) => ({
      emit: (event: string, payload: unknown) => sent.push({ to, event, payload })
    })
  } as any
  let clock = 10_000
  const stillAllowed = vi.fn(async () => true)
  const peers = vi.fn(async () => roster.map((socket) => ({ socket })))
  const ctx: MarkContext = {
    room: () => 'ch:1',
    tenant: () => 't1',
    stillAllowed,
    peers,
    warn: vi.fn(),
    ...over
  }
  registerHuddleMarks(
    io,
    socket,
    () => user,
    ctx,
    () => clock
  )
  const mark = (p: Record<string, unknown>) =>
    handlers.get('huddle:mark')?.({ room: 'ch:1', t: 'pt', s: 'S2', x: 0.5, y: 0.5, ...p })
  return {
    sent,
    notices,
    mark,
    stillAllowed,
    peers,
    tick: (ms: number) => {
      clock += ms
    }
  }
}

describe('parseMark', () => {
  it('keeps coordinates, tool, stroke id and colour index only', () => {
    expect(parseMark({ t: 'pt', s: 'S2', x: 1.5, y: -2, c: 3, from: 'evil', user: 'U9' })).toEqual({
      t: 'pt',
      s: 'S2',
      x: 1,
      y: 0,
      c: 3
    })
    expect(parseMark({ t: 'st', s: 'S2', id: 'k1', tool: 'pen', k: 0, p: [0.1, 0.2] })).toEqual({
      t: 'st',
      s: 'S2',
      id: 'k1',
      tool: 'pen',
      k: 0,
      p: [0.1, 0.2]
    })
    expect(parseMark({ t: 'clr', s: 'S2' })).toEqual({ t: 'clr', s: 'S2' })
  })

  it('drops anything off-shape', () => {
    expect(parseMark({ t: 'pt', s: 'S 2', x: 0, y: 0 })).toBeNull()
    expect(parseMark({ t: 'pt', s: 'S2', x: 'a', y: 0 })).toBeNull()
    expect(parseMark({ t: 'pt', s: 'S2', x: 0, y: 0, c: 99 })).toBeNull()
    expect(parseMark({ t: 'pt', s: 'S2', x: 0, y: 0, c: 1.5 })).toBeNull()
    expect(parseMark({ t: 'st', s: 'S2', id: 'k', tool: 'laser', k: 0, p: [] })).toBeNull()
    expect(parseMark({ t: 'st', s: 'S2', id: 'k', tool: 'pen', k: 0, p: [0.1] })).toBeNull()
    // At most MARK_MAX_POINTS points per message (the client splits longer strokes).
    const pts = (n: number) => new Array(n * 2).fill(0.5)
    expect(
      parseMark({ t: 'st', s: 'S2', id: 'k', tool: 'pen', k: 0, p: pts(MARK_MAX_POINTS) })
    ).not.toBeNull()
    expect(
      parseMark({ t: 'st', s: 'S2', id: 'k', tool: 'pen', k: 0, p: pts(MARK_MAX_POINTS + 1) })
    ).toBeNull()
    expect(parseMark({ t: 'img', s: 'S2' })).toBeNull()
    expect(parseMark(null)).toBeNull()
  })
})

describe('markBucket', () => {
  it('allows a burst, then refills at the rate', () => {
    const take = markBucket(3, 10)
    expect([take(0), take(0), take(0), take(0)]).toEqual([true, true, true, false])
    expect(take(50)).toBe(false)
    expect(take(100)).toBe(true)
  })
})

describe('huddle:mark relay (#2856 on the SFU)', () => {
  it('relays to the other sockets in the roster, naming the sender itself', async () => {
    const { sent, mark } = setup()
    await mark({ from: 'S9' })
    expect(sent).toEqual([
      {
        to: ['S2', 'S3'],
        event: 'huddle:mark',
        payload: { t: 'pt', s: 'S2', x: 0.5, y: 0.5, room: 'ch:1', from: 'S1' }
      }
    ])
  })

  it('is canSeeRoom-gated: a refused check relays nothing', async () => {
    const refused = vi.fn(async () => false)
    const { sent, mark } = setup({ stillAllowed: refused })
    await mark({})
    await mark({})
    expect(sent).toHaveLength(0)
    // A refusal is never cached: the next mark asks again.
    expect(refused).toHaveBeenCalledTimes(2)
  })

  it('relays nothing for a socket that is not in the roster, or for another room', async () => {
    const a = setup({}, ['S2', 'S3'])
    await a.mark({})
    expect(a.sent).toHaveLength(0)
    const b = setup({ room: () => 'ch:2' })
    await b.mark({})
    expect(b.sent).toHaveLength(0)
  })

  it('re-asks access and the roster once per TTL, not on every mark', async () => {
    const { mark, stillAllowed, peers, tick } = setup()
    await mark({})
    await mark({})
    await mark({})
    expect(stillAllowed).toHaveBeenCalledTimes(1)
    expect(peers).toHaveBeenCalledTimes(1)
    tick(MARK_ACCESS_TTL_MS)
    await mark({})
    expect(stillAllowed).toHaveBeenCalledTimes(2)
  })

  it('drops marks past the burst before asking anything', async () => {
    const { sent, mark } = setup()
    for (let i = 0; i < MARK_BURST + 5; i++) await mark({})
    expect(sent).toHaveLength(MARK_BURST)
  })

  it('never relays a malformed mark', async () => {
    const { sent, mark } = setup()
    await mark({ t: 'st', tool: 'laser' })
    expect(sent).toHaveLength(0)
  })

  it('has a byte budget: big strokes past it are dropped and the sender hears one notice', async () => {
    const { sent, notices, mark, tick } = setup()
    const p = new Array(MARK_MAX_POINTS * 2).fill(0.123456789012345)
    const one = Buffer.byteLength(
      JSON.stringify({ t: 'st', s: 'S2', id: 'k', tool: 'pen', k: 0, p, room: 'ch:1', from: 'S1' })
    )
    const fits = Math.floor(MARK_BYTES_BURST / one)
    for (let i = 0; i < fits + 5; i++) await mark({ t: 'st', id: 'k', tool: 'pen', k: 0, p })
    expect(sent).toHaveLength(fits)
    expect(notices).toEqual([{ event: 'huddle:mark:slow', payload: { room: 'ch:1' } }])
    // Throttled: the next notice waits MARK_SLOW_NOTICE_MS (the budget refills meanwhile).
    tick(MARK_SLOW_NOTICE_MS)
    for (let i = 0; i < fits + 5; i++) await mark({ t: 'st', id: 'k', tool: 'pen', k: 0, p })
    expect(notices).toHaveLength(2)
  })

  it('a removal invalidates the cached recipient list at once (H2)', async () => {
    const roster = ['S1', 'S2', 'S3']
    const { sent, mark, peers } = setup({}, roster)
    await mark({})
    expect(sent.at(-1)?.to).toEqual(['S2', 'S3'])
    // S3 leaves (huddle.ts leave → invalidateHuddleMarks); well inside the TTL.
    roster.pop()
    invalidateHuddleMarks('t1', 'ch:1')
    await mark({})
    expect(peers).toHaveBeenCalledTimes(2)
    expect(sent.at(-1)?.to).toEqual(['S2'])
    // Another tenant's room of the same name leaves this cache alone.
    invalidateHuddleMarks('t2', 'ch:1')
    await mark({})
    expect(peers).toHaveBeenCalledTimes(2)
  })
})
