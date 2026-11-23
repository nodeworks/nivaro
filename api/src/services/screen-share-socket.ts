import type { Server, Socket } from 'socket.io'
import type { User } from '../types.js'
import { registerAppKeyed } from './app-forget.js'
import {
  cachedPerson,
  cachedShareTicket,
  cleanFrame,
  createShareBudget,
  type EndDeps,
  endShare,
  frameRecipients,
  personName,
  readShare,
  readWatchers,
  type ShareRedis,
  type ShareState,
  type ShareTicket,
  screenShareEnabled,
  shareKeys,
  shareLiveness,
  shareOutlived,
  targetPeople,
  ticketOpen,
  WATCH_TTL_MS,
  watchRefusal,
  writeShare
} from './screen-share.js'
import { inSocketTenant } from './socket-tenant.js'

/**
 * The socket half of "Share my screen with support" (services/screen-share.ts has the rules).
 *
 *   sharer  screenshare:beat  { ticket, share }                     every 10 s while sharing
 *   sharer  screenshare:frame { ticket, share, seq, part, parts, data }  (ack → { ok, watchers })
 *   viewer  screenshare:watch { ticket }    first look + every 15 s → screenshare:joined | denied
 *   viewer  screenshare:resync { ticket }   a frame was missed → the sharer sends a full snapshot
 *   viewer  screenshare:unwatch { ticket }
 *
 *   → viewer sockets   screenshare:frame (only to sockets judged as their person, per frame)
 *   → sharer socket    screenshare:snapshot { ticket, share }   (a viewer joined or fell behind)
 *   → sharer user room screenshare:watching { ticket, share, names }   (who is looking now)
 *   → both             screenshare:ended { ticket, share, reason }
 *
 * The frame `data` is the sharing page's rrweb batch as JSON text, already masked in the browser
 * exactly as session replay masks it; the server never parses or stores it.
 */

export interface ScreenShareSocketDeps {
  redis: ShareRedis
  enabled: () => boolean
  ticket: (id: number, tenant: string) => Promise<ShareTicket | null>
  person: (userId: string, tenant: string) => Promise<{ active: boolean; teams: number[] }>
  name: (userId: string) => Promise<string>
  log: EndDeps['log']
  now: () => number
}

export interface ScreenShareScope {
  /** '' self-hosted; the tenant key in cloud; null before it resolved (do nothing). */
  tenantNow(): string | null
}

let budgetOne: ReturnType<typeof createShareBudget> | null = null
const budget = () => {
  budgetOne ??= createShareBudget()
  return budgetOne
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

function bindKind(socket: Socket): string | undefined {
  const k = (socket.data?.nvrBind as { kind?: unknown } | undefined)?.kind
  return typeof k === 'string' ? k : undefined
}

function ticketOf(p: unknown): number | null {
  const n = Number((p as { ticket?: unknown } | null)?.ticket)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** A share read once per ~2 s per process while frames stream (the key holds the truth). */
const shareCache = registerAppKeyed(new Map<string, { v: ShareState | null; exp: number }>())

export function __resetScreenShareSocket(): void {
  shareCache.clear()
}

export function registerScreenShare(
  io: Pick<Server, 'to'>,
  socket: Socket,
  getUser: () => User | null,
  scope: ScreenShareScope,
  deps: ScreenShareSocketDeps
): void {
  /** Ticket → the share this socket watches there (a new share on it is a first look again). */
  const watching = new Map<number, string>()
  /** Tenant-bound, and a throw (Redis or database trouble) never escapes the handler. */
  const guarded = <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
    inSocketTenant(socket, async (...args: A) => {
      try {
        await fn(...args)
      } catch {
        /* best-effort: the client's next beat / watch tries again */
      }
    })

  const endDeps = (): EndDeps => screenShareEndDeps(io, deps)

  async function shareFor(tenant: string, ticket: number, fresh = false) {
    const key = `${tenant}|${ticket}`
    const hit = shareCache.get(key)
    if (!fresh && hit && hit.exp > deps.now()) return hit.v
    const v = await readShare(deps.redis, tenant, ticket)
    if (shareCache.size > 1_000) shareCache.clear()
    shareCache.set(key, { v, exp: deps.now() + 2_000 })
    return v
  }

  /** The share this socket's person runs on this ticket, still live — else ended, null. */
  async function ownShare(tenant: string, ticket: number, shareId: unknown, fresh = false) {
    const user = getUser()
    if (!user || bindKind(socket) !== 'session' || !deps.enabled()) return null
    const share = await shareFor(tenant, ticket, fresh)
    if (!share || share.id !== shareId || up(share.sharer) !== up(user.id)) return null
    const live = shareLiveness(share, deps.now())
    if (live !== 'live') {
      shareCache.delete(`${tenant}|${ticket}`)
      await endShare(endDeps(), tenant, ticket, live, null, share.id)
      return null
    }
    return share
  }

  /** Who is looking now, by name (only the ticket's target people can be here). */
  async function tellWatching(tenant: string, share: ShareState) {
    try {
      const list = await readWatchers(deps.redis, tenant, share.ticket, deps.now())
      const ids = [...new Set(list.map((w) => up(w.user)))]
      const names = await Promise.all(ids.map((id) => deps.name(id).catch(() => 'Someone')))
      io.to(`user:${up(share.sharer)}`).emit('screenshare:watching', {
        ticket: share.ticket,
        share: share.id,
        names
      })
    } catch {
      /* decoration */
    }
  }

  function askSnapshot(share: ShareState) {
    const payload = { ticket: share.ticket, share: share.id }
    if (share.socket) io.to(share.socket).emit('screenshare:snapshot', payload)
    else io.to(`user:${up(share.sharer)}`).emit('screenshare:snapshot', payload)
  }

  socket.on(
    'screenshare:beat',
    guarded(async (p: { ticket?: unknown; share?: unknown }) => {
      const tenant = scope.tenantNow()
      const ticket = ticketOf(p)
      if (tenant == null || ticket == null) return
      const share = await ownShare(tenant, ticket, p?.share, true)
      if (!share) {
        socket.emit('screenshare:ended', { ticket, share: p?.share ?? null, reason: 'gone' })
        return
      }
      // The ticket moved (reassigned, closed): the share ends with it.
      const t = await deps.ticket(ticket, tenant).catch(() => undefined)
      if (t !== undefined && shareOutlived(share, t)) {
        const why = t && ticketOpen(t) ? 'moved' : 'closed'
        await endShare(endDeps(), tenant, ticket, why, null, share.id)
        return
      }
      const next = { ...share, beat_at: deps.now(), socket: socket.id }
      await writeShare(deps.redis, tenant, next, deps.now())
      shareCache.set(`${tenant}|${ticket}`, { v: next, exp: deps.now() + 2_000 })
    })
  )

  socket.on(
    'screenshare:frame',
    guarded(async (p: unknown, ack?: (r: unknown) => void) => {
      const reply = (r: unknown) => {
        if (typeof ack === 'function') ack(r)
      }
      const tenant = scope.tenantNow()
      const f = cleanFrame(p)
      if (tenant == null || !f) return reply({ ok: false, reason: 'bad-frame' })
      const share = await ownShare(tenant, f.ticket, f.share)
      if (!share) return reply({ ok: false, reason: 'ended' })
      if (!budget().take(share.id, f.data.length)) return reply({ ok: false, reason: 'budget' })
      const watchers = await readWatchers(deps.redis, tenant, f.ticket, deps.now())
      if (watchers.length === 0) return reply({ ok: true, watchers: 0 })
      const { to, refused } = await frameRecipients(watchers, share, {
        enabled: deps.enabled(),
        ticket: () => deps.ticket(f.ticket, tenant),
        person: (id) => deps.person(id, tenant)
      })
      if (refused.length) {
        // A socket that no longer passes is dropped from the watch list and told why.
        await deps.redis
          .hdel(shareKeys(tenant, f.ticket).watchers, ...refused.map((r) => r.socket))
          .catch(() => undefined)
        for (const r of refused)
          io.to(r.socket).emit('screenshare:denied', { ticket: f.ticket, reason: r.reason })
        if (refused.some((r) => r.reason === 'MOVED' || r.reason === 'CLOSED')) {
          await endShare(endDeps(), tenant, f.ticket, 'moved', null, share.id)
          return reply({ ok: false, reason: 'ended' })
        }
      }
      if (to.length) io.to(to).emit('screenshare:frame', { ...f })
      reply({ ok: true, watchers: to.length })
    })
  )

  socket.on(
    'screenshare:watch',
    guarded(async (p: unknown) => {
      const tenant = scope.tenantNow()
      const ticket = ticketOf(p)
      const user = getUser()
      if (tenant == null || ticket == null || !user) return
      const deny = (reason: string) => {
        watching.delete(ticket)
        void deps.redis.hdel(shareKeys(tenant, ticket).watchers, socket.id).catch(() => undefined)
        socket.emit('screenshare:denied', { ticket, reason })
      }
      try {
        const share = await shareFor(tenant, ticket, true)
        if (share && shareLiveness(share, deps.now()) !== 'live') {
          await endShare(
            endDeps(),
            tenant,
            ticket,
            shareLiveness(share, deps.now()),
            null,
            share.id
          )
          return deny('NO_SHARE')
        }
        const kind = bindKind(socket)
        const [t, person] = await Promise.all([
          deps.ticket(ticket, tenant),
          kind === 'session' ? deps.person(user.id, tenant) : { active: false, teams: [] }
        ])
        const reason = watchRefusal({
          enabled: deps.enabled(),
          viewer: { id: user.id, kind, active: person.active },
          ticket: t,
          share,
          viewerTeams: () => person.teams
        })
        if (reason || !share) return deny(reason ?? 'NO_SHARE')
        const k = shareKeys(tenant, ticket)
        const first = watching.get(ticket) !== share.id
        watching.set(ticket, share.id)
        await deps.redis.hset(
          k.watchers,
          socket.id,
          JSON.stringify({ user: up(user.id), kind, at: deps.now() })
        )
        await deps.redis.pexpire(k.watchers, Math.max(WATCH_TTL_MS, share.expires_at - deps.now()))
        if (!first) return
        socket.emit('screenshare:joined', {
          ticket,
          share: share.id,
          sharer_name: share.sharer_name,
          started_at: share.started_at,
          expires_at: share.expires_at
        })
        // A person's first look at this share goes in the ticket's history (once per share).
        // Keyed by share, so a later share on the same ticket logs its first look again.
        const seen = await deps.redis.hsetnx(k.seen(share.id), up(user.id), '1').catch(() => 0)
        if (seen === 1) {
          await deps.redis
            .pexpire(k.seen(share.id), Math.max(1_000, share.expires_at - deps.now()))
            .catch(() => undefined)
          await deps
            .log(
              ticket,
              up(user.id),
              `Watched ${share.sharer_name}'s shared screen`,
              'screen-share-watch'
            )
            .catch(() => undefined)
        }
        askSnapshot(share)
        await tellWatching(tenant, share)
      } catch {
        deny('ERROR')
      }
    })
  )

  socket.on(
    'screenshare:resync',
    guarded(async (p: unknown) => {
      const tenant = scope.tenantNow()
      const ticket = ticketOf(p)
      if (tenant == null || ticket == null || !watching.has(ticket)) return
      const share = await shareFor(tenant, ticket)
      if (!share) return
      // Only a socket on the watch list (judged when it joined, and on every frame) may ask.
      const list = await readWatchers(deps.redis, tenant, ticket, deps.now())
      if (!list.some((w) => w.socket === socket.id)) return
      askSnapshot(share)
    })
  )

  const unwatch = async (tenant: string, ticket: number) => {
    watching.delete(ticket)
    await deps.redis.hdel(shareKeys(tenant, ticket).watchers, socket.id).catch(() => undefined)
    const share = await readShare(deps.redis, tenant, ticket).catch(() => null)
    if (share) await tellWatching(tenant, share)
  }

  socket.on(
    'screenshare:unwatch',
    guarded(async (p: unknown) => {
      const tenant = scope.tenantNow()
      const ticket = ticketOf(p)
      if (tenant == null || ticket == null || !watching.has(ticket)) return
      await unwatch(tenant, ticket)
    })
  )

  socket.on(
    'disconnect',
    guarded(async () => {
      const tenant = scope.tenantNow()
      if (tenant == null) return
      for (const ticket of [...watching.keys()])
        await unwatch(tenant, ticket).catch(() => undefined)
    })
  )
}

/** Telling people a share ended (socket ids for watchers, user rooms for people). */
export function screenShareEndDeps(
  io: Pick<Server, 'to'> | null,
  deps: Pick<ScreenShareSocketDeps, 'redis' | 'log' | 'now'>
): EndDeps {
  return {
    redis: deps.redis,
    log: deps.log,
    now: deps.now,
    tellPeople: (ids, payload) => {
      for (const id of ids) io?.to(`user:${up(id)}`).emit('screenshare:ended', payload)
    },
    tellSockets: (ids, payload) => {
      if (ids.length) io?.to(ids).emit('screenshare:ended', payload)
    },
    announce: (share) => announceShareState(io, share)
  }
}

/** `screenshare:state {ticket}` (id only) to the sharer and the people it goes to. */
export function announceShareState(io: Pick<Server, 'to'> | null, share: ShareState): void {
  if (!io) return
  void targetPeople(share.to)
    .catch(() => [] as string[])
    .then((ids) => {
      for (const id of new Set([up(share.sharer), ...ids]))
        io.to(`user:${id}`).emit('screenshare:state', { ticket: share.ticket })
    })
}

/** The production deps (socketio.ts). */
export function defaultScreenShareDeps(
  redis: ShareRedis,
  log: EndDeps['log']
): ScreenShareSocketDeps {
  return {
    redis,
    enabled: screenShareEnabled,
    ticket: (id, tenant) => cachedShareTicket(id, tenant),
    person: (id, tenant) => cachedPerson(id, tenant),
    name: personName,
    log,
    now: Date.now
  }
}
