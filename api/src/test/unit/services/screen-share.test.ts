import { beforeEach, describe, expect, it } from 'vitest'
import {
  cleanFrame,
  createShareBudget,
  type EndDeps,
  endShare,
  frameRecipients,
  memoryShareRedis,
  readShare,
  SHARE_MAX_MS,
  SHARE_STALE_MS,
  type ShareState,
  type ShareTicket,
  shareKeys,
  shareLiveness,
  startRefusal,
  targetKey,
  WATCH_TTL_MS,
  watchRefusal,
  writeShare
} from '../../../services/screen-share.js'
import {
  __resetScreenShareSocket,
  registerScreenShare,
  type ScreenShareSocketDeps
} from '../../../services/screen-share-socket.js'

const REQ = 'AAAA0000-0000-0000-0000-00000000000A'
const BETH = 'BBBB0000-0000-0000-0000-00000000000B'
const ADMIN = 'CCCC0000-0000-0000-0000-00000000000C'
const TEAMMATE = 'DDDD0000-0000-0000-0000-00000000000D'

const ticket = (over: Partial<ShareTicket> = {}): ShareTicket => ({
  id: 7,
  kind: 'support',
  status: 'in_progress',
  created_by: REQ,
  assignee: BETH,
  team_id: null,
  ...over
})

const session = (id: string) => ({ id, kind: 'session', viewAs: false, mcp: false })

function share(over: Partial<ShareState> = {}, now = 1_000_000): ShareState {
  return {
    id: 'a'.repeat(32),
    ticket: 7,
    sharer: REQ,
    sharer_name: 'Rita Requester',
    to: { kind: 'user', id: BETH, name: 'Beth' },
    started_at: now,
    expires_at: now + SHARE_MAX_MS,
    beat_at: now,
    socket: null,
    ...over
  }
}

describe('start authority', () => {
  it('lets the requester start on their own browser session when someone works the ticket', () => {
    expect(startRefusal({ enabled: true, actor: session(REQ), ticket: ticket() })).toBeNull()
    // Team routing works too when nobody is assigned yet.
    expect(
      startRefusal({
        enabled: true,
        actor: session(REQ),
        ticket: ticket({ assignee: null, team_id: 4 })
      })
    ).toBeNull()
  })

  it('never lets anyone else start it — an administrator included', () => {
    expect(startRefusal({ enabled: true, actor: session(ADMIN), ticket: ticket() })).toBe(
      'NOT_REQUESTER'
    )
    expect(startRefusal({ enabled: true, actor: session(BETH), ticket: ticket() })).toBe(
      'NOT_REQUESTER'
    )
  })

  it('refuses View-as even though the id is the requester (an admin on their behalf)', () => {
    expect(
      startRefusal({
        enabled: true,
        actor: { ...session(REQ), kind: 'masquerade', viewAs: true },
        ticket: ticket()
      })
    ).toBe('VIEW_AS')
  })

  it('refuses every sign-in that is not the person in a browser (fails closed)', () => {
    for (const kind of ['api_key', 'token', 'device', 'oauth', 'key_sim', 'teams', null, undefined])
      expect(
        startRefusal({ enabled: true, actor: { ...session(REQ), kind }, ticket: ticket() })
      ).toBe('SIGN_IN_KIND')
    expect(
      startRefusal({ enabled: true, actor: { ...session(REQ), mcp: true }, ticket: ticket() })
    ).toBe('SIGN_IN_KIND')
  })

  it('needs an open support ticket with someone to share with', () => {
    expect(
      startRefusal({ enabled: true, actor: session(REQ), ticket: ticket({ status: 'done' }) })
    ).toBe('CLOSED')
    expect(
      startRefusal({ enabled: true, actor: session(REQ), ticket: ticket({ kind: 'task' }) })
    ).toBe('NOT_FOUND')
    expect(
      startRefusal({
        enabled: true,
        actor: session(REQ),
        ticket: ticket({ assignee: null, team_id: null })
      })
    ).toBe('NO_SUPPORT_PERSON')
    // Assigned to themselves: nobody to share with.
    expect(
      startRefusal({ enabled: true, actor: session(REQ), ticket: ticket({ assignee: REQ }) })
    ).toBe('NO_SUPPORT_PERSON')
    expect(startRefusal({ enabled: false, actor: session(REQ), ticket: ticket() })).toBe('OFF')
  })

  it('targets the assignee, else the team', () => {
    expect(targetKey(ticket())).toEqual({ kind: 'user', id: BETH })
    expect(targetKey(ticket({ assignee: null, team_id: 4 }))).toEqual({ kind: 'team', id: 4 })
  })
})

describe('watch authority', () => {
  const judge = (
    viewer: { id: string; kind?: string; active?: boolean },
    t: ShareTicket = ticket(),
    s: ShareState = share(),
    teams: number[] = []
  ) =>
    watchRefusal({
      enabled: true,
      viewer: { id: viewer.id, kind: viewer.kind ?? 'session', active: viewer.active ?? true },
      ticket: t,
      share: s,
      viewerTeams: () => teams
    })

  it('only the assigned support person watches', () => {
    expect(judge({ id: BETH })).toBeNull()
    expect(judge({ id: ADMIN })).toBe('NOT_ASSIGNED')
    expect(judge({ id: TEAMMATE }, ticket(), share(), [4])).toBe('NOT_ASSIGNED')
    expect(judge({ id: REQ })).toBe('SELF')
  })

  it('a team share goes to the team members only', () => {
    const t = ticket({ assignee: null, team_id: 4 })
    const s = share({ to: { kind: 'team', id: 4, name: 'Desk' } })
    expect(judge({ id: TEAMMATE }, t, s, [4])).toBeNull()
    expect(judge({ id: ADMIN }, t, s, [9])).toBe('NOT_ASSIGNED')
  })

  it('fails closed on any sign-in that is not a browser session, and on inactive people', () => {
    for (const kind of ['apikey', 'token', 'masq', 'device', ''])
      expect(judge({ id: BETH, kind })).toBe('SIGN_IN_KIND')
    expect(judge({ id: BETH, active: false })).toBe('SIGN_IN_KIND')
  })

  it('ends with the ticket: moved to someone else or closed', () => {
    expect(judge({ id: BETH }, ticket({ assignee: TEAMMATE }))).toBe('MOVED')
    // The new assignee does not inherit a share started with Beth.
    expect(judge({ id: TEAMMATE }, ticket({ assignee: TEAMMATE }))).toBe('MOVED')
    expect(judge({ id: BETH }, ticket({ status: 'cancelled' }))).toBe('CLOSED')
    expect(judge({ id: BETH }, ticket({ id: 8 }))).toBe('NO_SHARE')
  })
})

describe('frame recipients (per socket)', () => {
  it('sends only to sockets judged as their person; an unknown kind gets nothing', async () => {
    const s = share()
    const { to, refused } = await frameRecipients(
      [
        { socket: 's-beth', user: BETH, kind: 'session' },
        { socket: 's-beth-key', user: BETH, kind: 'apikey' },
        { socket: 's-beth-old', user: BETH, kind: '' },
        { socket: 's-admin', user: ADMIN, kind: 'session' }
      ],
      s,
      {
        enabled: true,
        ticket: async () => ticket(),
        person: async () => ({ active: true, teams: [] })
      }
    )
    expect(to).toEqual(['s-beth'])
    expect(refused.map((r) => r.socket).sort()).toEqual(['s-admin', 's-beth-key', 's-beth-old'])
  })

  it('a failing lookup refuses (never delivers)', async () => {
    const r = await frameRecipients([{ socket: 's1', user: BETH, kind: 'session' }], share(), {
      enabled: true,
      ticket: async () => ticket(),
      person: async () => {
        throw new Error('db down')
      }
    })
    expect(r.to).toEqual([])
    const r2 = await frameRecipients([{ socket: 's1', user: BETH, kind: 'session' }], share(), {
      enabled: true,
      ticket: async () => {
        throw new Error('db down')
      },
      person: async () => ({ active: true, teams: [] })
    })
    expect(r2.to).toEqual([])
  })
})

describe('frames, liveness, budget', () => {
  it('accepts only bounded frame parts', () => {
    const ok = { ticket: 7, share: 'a'.repeat(32), seq: 0, part: 0, parts: 1, data: '[]' }
    expect(cleanFrame(ok)).toEqual(ok)
    expect(cleanFrame({ ...ok, share: 'x' })).toBeNull()
    expect(cleanFrame({ ...ok, data: 'x'.repeat(70_000) })).toBeNull()
    expect(cleanFrame({ ...ok, part: 1 })).toBeNull()
    expect(cleanFrame({ ...ok, parts: 10_000 })).toBeNull()
    expect(cleanFrame({ ...ok, data: { a: 1 } })).toBeNull()
  })

  it('a share expires after 30 minutes and goes stale without heartbeats', () => {
    const s = share({}, 0)
    expect(shareLiveness(s, 10_000)).toBe('live')
    expect(shareLiveness(s, SHARE_STALE_MS + 1)).toBe('stale')
    expect(shareLiveness({ ...s, beat_at: SHARE_MAX_MS - 1 }, SHARE_MAX_MS)).toBe('expired')
  })

  it('limits bytes per share per minute', () => {
    let t = 0
    const b = createShareBudget(100, () => t)
    expect(b.take('x', 60)).toBe(true)
    expect(b.take('x', 60)).toBe(false)
    expect(b.take('y', 60)).toBe(true)
    t = 60_001
    expect(b.take('x', 60)).toBe(true)
  })
})

describe('ending a share', () => {
  it('ends once, logs one line and tells the sharer and the watchers', async () => {
    let now = 1_000_000
    const redis = memoryShareRedis(() => now)
    await writeShare(redis, '', share({}, now), now)
    await redis.hset(
      shareKeys('', 7).watchers,
      'w1',
      JSON.stringify({ user: BETH, kind: 'session', at: now })
    )
    const logs: string[] = []
    const people: string[][] = []
    const sockets: string[][] = []
    const deps: EndDeps = {
      redis,
      now: () => now,
      log: async (_t, _u, text) => {
        logs.push(text)
      },
      tellPeople: (ids) => people.push(ids),
      tellSockets: (ids) => sockets.push(ids)
    }
    now += 5 * 60_000
    expect(await endShare(deps, '', 7, 'stopped', REQ)).toBe(true)
    expect(await endShare(deps, '', 7, 'stopped', REQ)).toBe(false)
    expect(logs).toEqual(['Stopped sharing their screen (5 min)'])
    expect(people).toEqual([[REQ]])
    expect(sockets).toEqual([['w1']])
    expect(await readShare(redis, '', 7)).toBeNull()
  })
})

// ── The socket half, with a fake io / socket and an in-memory Redis ─────────

type Sent = { to: string | string[]; event: string; payload: any }

function fakeIo() {
  const sent: Sent[] = []
  return {
    sent,
    io: {
      to: (target: string | string[]) => ({
        emit: (event: string, payload: unknown) => {
          sent.push({ to: target, event, payload })
          return true
        }
      })
    }
  }
}

function fakeSocket(id: string, user: { id: string } | null, kind: string | undefined) {
  const handlers = new Map<string, (...a: any[]) => Promise<void> | void>()
  const own: Array<{ event: string; payload: any }> = []
  const socket = {
    id,
    data: kind ? { nvrBind: { kind } } : {},
    on: (ev: string, fn: (...a: any[]) => Promise<void> | void) => {
      handlers.set(ev, fn)
    },
    emit: (event: string, payload: unknown) => {
      own.push({ event, payload })
      return true
    }
  }
  return {
    socket,
    own,
    user,
    fire: async (ev: string, ...args: unknown[]) => {
      await handlers.get(ev)?.(...args)
    }
  }
}

describe('registerScreenShare (room scoping)', () => {
  let now: number
  let redis: ReturnType<typeof memoryShareRedis>
  let tk: ShareTicket
  let logs: Array<{ user: string | null; text: string; action: string }>
  let deps: ScreenShareSocketDeps

  beforeEach(async () => {
    __resetScreenShareSocket()
    now = 2_000_000
    redis = memoryShareRedis(() => now)
    tk = ticket()
    logs = []
    deps = {
      redis,
      enabled: () => true,
      ticket: async () => tk,
      person: async (id) => ({ active: true, teams: id === TEAMMATE ? [4] : [] }),
      name: async (id) => (id === BETH ? 'Beth' : 'Someone'),
      log: async (_t, user, text, action) => {
        logs.push({ user, text, action })
      },
      now: () => now
    }
    await writeShare(redis, '', share({}, now), now)
  })

  const wire = (io: ReturnType<typeof fakeIo>, s: ReturnType<typeof fakeSocket>) =>
    registerScreenShare(
      io.io as never,
      s.socket as never,
      () => s.user as never,
      { tenantNow: () => '' },
      deps
    )

  const frame = (over: Record<string, unknown> = {}) => ({
    ticket: 7,
    share: 'a'.repeat(32),
    seq: 0,
    part: 0,
    parts: 1,
    data: '[{"type":2}]',
    ...over
  })

  it('delivers frames only to the assigned watcher socket, never to others or user rooms', async () => {
    const io = fakeIo()
    const sharer = fakeSocket('sock-req', { id: REQ }, 'session')
    const beth = fakeSocket('sock-beth', { id: BETH }, 'session')
    const admin = fakeSocket('sock-admin', { id: ADMIN }, 'session')
    const bethKey = fakeSocket('sock-beth-key', { id: BETH }, 'apikey')
    for (const s of [sharer, beth, admin, bethKey]) wire(io, s)

    await beth.fire('screenshare:watch', { ticket: 7 })
    await admin.fire('screenshare:watch', { ticket: 7 })
    await bethKey.fire('screenshare:watch', { ticket: 7 })
    expect(beth.own.map((e) => e.event)).toContain('screenshare:joined')
    expect(admin.own).toContainEqual({
      event: 'screenshare:denied',
      payload: { ticket: 7, reason: 'NOT_ASSIGNED' }
    })
    expect(bethKey.own).toContainEqual({
      event: 'screenshare:denied',
      payload: { ticket: 7, reason: 'SIGN_IN_KIND' }
    })
    // The sharer was asked for a snapshot and told who watches.
    expect(io.sent.some((e) => e.event === 'screenshare:snapshot')).toBe(true)
    expect(io.sent.find((e) => e.event === 'screenshare:watching')?.payload.names).toEqual(['Beth'])
    // First look is logged once.
    expect(logs.filter((l) => l.action === 'screen-share-watch')).toHaveLength(1)
    await beth.fire('screenshare:watch', { ticket: 7 })
    expect(logs.filter((l) => l.action === 'screen-share-watch')).toHaveLength(1)

    io.sent.length = 0
    let ack: any = null
    await sharer.fire('screenshare:frame', frame(), (r: unknown) => {
      ack = r
    })
    const frames = io.sent.filter((e) => e.event === 'screenshare:frame')
    expect(frames).toHaveLength(1)
    expect(frames[0].to).toEqual(['sock-beth'])
    expect(ack).toEqual({ ok: true, watchers: 1 })
  })

  it('refuses frames from anyone but the sharer on their session, or for another share', async () => {
    const io = fakeIo()
    const beth = fakeSocket('sock-beth', { id: BETH }, 'session')
    const viewAs = fakeSocket('sock-masq', { id: REQ }, 'masq')
    const sharer = fakeSocket('sock-req', { id: REQ }, 'session')
    for (const s of [beth, viewAs, sharer]) wire(io, s)
    await beth.fire('screenshare:watch', { ticket: 7 })
    io.sent.length = 0
    const acks: unknown[] = []
    await beth.fire('screenshare:frame', frame(), (r: unknown) => acks.push(r))
    await viewAs.fire('screenshare:frame', frame(), (r: unknown) => acks.push(r))
    await sharer.fire('screenshare:frame', frame({ share: 'b'.repeat(32) }), (r: unknown) =>
      acks.push(r)
    )
    expect(io.sent.filter((e) => e.event === 'screenshare:frame')).toHaveLength(0)
    expect(acks).toEqual([
      { ok: false, reason: 'ended' },
      { ok: false, reason: 'ended' },
      { ok: false, reason: 'ended' }
    ])
  })

  it('a reassigned ticket ends the share on the next frame and tells the watcher', async () => {
    const io = fakeIo()
    const sharer = fakeSocket('sock-req', { id: REQ }, 'session')
    const beth = fakeSocket('sock-beth', { id: BETH }, 'session')
    for (const s of [sharer, beth]) wire(io, s)
    await beth.fire('screenshare:watch', { ticket: 7 })
    tk = ticket({ assignee: TEAMMATE })
    io.sent.length = 0
    await sharer.fire('screenshare:frame', frame(), () => {})
    expect(io.sent.filter((e) => e.event === 'screenshare:frame')).toHaveLength(0)
    expect(io.sent.some((e) => e.event === 'screenshare:ended')).toBe(true)
    expect(await readShare(redis, '', 7)).toBeNull()
    expect(logs.some((l) => l.action === 'screen-share-stop')).toBe(true)
  })

  it('drops a watcher whose heartbeat lapsed', async () => {
    const io = fakeIo()
    const sharer = fakeSocket('sock-req', { id: REQ }, 'session')
    const beth = fakeSocket('sock-beth', { id: BETH }, 'session')
    for (const s of [sharer, beth]) wire(io, s)
    await beth.fire('screenshare:watch', { ticket: 7 })
    await sharer.fire('screenshare:beat', { ticket: 7, share: 'a'.repeat(32) })
    now += WATCH_TTL_MS + 1
    await sharer.fire('screenshare:beat', { ticket: 7, share: 'a'.repeat(32) })
    io.sent.length = 0
    await sharer.fire('screenshare:frame', frame(), () => {})
    expect(io.sent.filter((e) => e.event === 'screenshare:frame')).toHaveLength(0)
  })

  it('a stale share (page gone) ends on the next look', async () => {
    const io = fakeIo()
    const beth = fakeSocket('sock-beth', { id: BETH }, 'session')
    wire(io, beth)
    now += SHARE_STALE_MS + 1
    await beth.fire('screenshare:watch', { ticket: 7 })
    expect(beth.own).toContainEqual({
      event: 'screenshare:denied',
      payload: { ticket: 7, reason: 'NO_SHARE' }
    })
    expect(logs.map((l) => l.text)).toEqual([
      'Screen share ended: sharing stopped when the page closed (1 min)'
    ])
  })
})
