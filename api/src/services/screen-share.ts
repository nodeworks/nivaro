/**
 * Share my screen with support (realtime idea 24).
 *
 * The person who raised a support ticket starts a view-only live share of their APP screen (never
 * their desktop or other tabs) with whoever works that ticket. The browser records the page with
 * the session-replay recorder's rrweb stream and its masking (packages/shared lib/replay-masking:
 * every input masked, record field values / rich text / file names masked unless an admin allowed
 * a field) and sends batches over the socket; the server relays them to the watching sockets.
 *
 * Who may do what (all judged here, every time):
 *  - START: only the ticket's requester, on their own browser session (sign-in kind `session`:
 *    never View-as, an API key, a static token, a phone token or an MCP call — an administrator
 *    can never start a share on someone's behalf), while the ticket is open and has someone to
 *    share with: its assignee (when that is not the requester), else its team.
 *  - WATCH: only that target — the assignee, or a member of the team when nobody is assigned —
 *    on their own browser session. Being an administrator gives no access. The target is fixed
 *    when the share starts: a ticket handed to someone else (or closed) ends the share.
 *  - STOP: the requester, any time; the share also ends by itself after 30 minutes, when the
 *    sharing page goes away (no heartbeat for STALE_MS), or when the ticket moves.
 *
 * Every relayed frame is judged per recipient SOCKET (field-change-relay's pattern): each watcher
 * socket is re-judged as its person (cached briefly) and an unknown or other sign-in kind gets
 * nothing. Frames go to socket ids, never to `user:` rooms.
 *
 * State lives in Redis (a share + a hash of watcher sockets, both with a TTL), so a share works
 * whichever API process the requester and the support person landed on. Starts, stops and each
 * watcher's first look are written to the ticket's history (nivaro_activity).
 */
import { db } from '../db/index.js'

// Mirrors support-tickets.ts (importing it here would pull the socket plugin into a cycle).
const SUPPORT_KIND = 'support'
const OPEN_STATUSES = ['open', 'in_progress']

/** A share ends by itself after this long. */
export const SHARE_MAX_MS = 30 * 60_000
/** How long a finished-but-unnoticed share key lingers so its end is still logged. */
export const SHARE_KEEP_AFTER_MS = 24 * 60 * 60_000
/** No heartbeat or frame from the sharing page for this long = the page went away. */
export const SHARE_STALE_MS = 45_000
/** A watcher re-says "watching" every 15 s; an entry older than this is dropped. */
export const WATCH_TTL_MS = 40_000
/** One frame part: characters of the batch's JSON text (≤ 4 bytes each = ≤ 256 KiB). */
export const FRAME_MAX_CHARS = 65_536
/** Parts in one batch (a large full snapshot is split into many). */
export const FRAME_MAX_PARTS = 400
/** Bytes one share may relay per minute; past it frames are dropped (the viewer resyncs). */
export const SHARE_BYTES_PER_MIN = 40 * 1024 * 1024

/** The only sign-in kind that may share or watch: a person's own browser session. */
export const SHARE_SIGN_IN_KINDS: ReadonlySet<string> = new Set(['session'])

export function screenShareEnabled(): boolean {
  return (process.env.SCREEN_SHARE ?? 'on').toLowerCase() !== 'off'
}

export type ShareTarget =
  | { kind: 'user'; id: string; name: string }
  | { kind: 'team'; id: number; name: string }

export interface ShareState {
  id: string
  ticket: number
  sharer: string
  sharer_name: string
  to: ShareTarget
  started_at: number
  expires_at: number
  /** Last heartbeat or frame from the sharing page. */
  beat_at: number
  /** The sharing page's socket (where "take a fresh snapshot" goes); set by its first beat. */
  socket: string | null
}

export interface ShareTicket {
  id: number
  kind: string | null
  status: string
  created_by: string
  assignee: string | null
  team_id: number | null
}

const up = (v: unknown) => String(v ?? '').toUpperCase()
const same = (a: unknown, b: unknown) => !!a && !!b && up(a) === up(b)

export function ticketOpen(t: Pick<ShareTicket, 'status'>): boolean {
  return OPEN_STATUSES.includes(t.status)
}

/**
 * Who a share from this ticket would go to: the assignee (never the requester themselves), else
 * the ticket's team. Null = nobody yet (unassigned, no team: the administrators' queue — a share
 * needs a named person or team).
 */
export function targetKey(
  t: ShareTicket
): { kind: 'user'; id: string } | { kind: 'team'; id: number } | null {
  if (t.assignee && !same(t.assignee, t.created_by)) return { kind: 'user', id: up(t.assignee) }
  if (t.assignee) return null
  if (t.team_id != null) return { kind: 'team', id: Number(t.team_id) }
  return null
}

function sameTarget(
  a: { kind: string; id: string | number } | null,
  b: { kind: string; id: string | number } | null
): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind === 'user' ? same(a.id, b.id) : Number(a.id) === Number(b.id)
}

export type StartRefusal =
  | 'OFF'
  | 'NOT_FOUND'
  | 'NOT_REQUESTER'
  | 'SIGN_IN_KIND'
  | 'VIEW_AS'
  | 'CLOSED'
  | 'NO_SUPPORT_PERSON'

/** Why this caller may not start a share on this ticket, or null when they may. */
export function startRefusal(input: {
  enabled: boolean
  actor: { id: string; kind: string | null | undefined; viewAs: boolean; mcp: boolean }
  ticket: ShareTicket | null | undefined
}): StartRefusal | null {
  const { actor, ticket } = input
  if (!input.enabled) return 'OFF'
  // View-as first: an administrator behind it is never the requester, whatever the id says.
  if (actor.viewAs) return 'VIEW_AS'
  if (actor.mcp || !actor.kind || !SHARE_SIGN_IN_KINDS.has(actor.kind)) return 'SIGN_IN_KIND'
  if (!ticket || ticket.kind !== SUPPORT_KIND) return 'NOT_FOUND'
  if (!same(ticket.created_by, actor.id)) return 'NOT_REQUESTER'
  if (!ticketOpen(ticket)) return 'CLOSED'
  if (!targetKey(ticket)) return 'NO_SUPPORT_PERSON'
  return null
}

export const START_REFUSAL_TEXT: Record<StartRefusal, string> = {
  OFF: 'Screen sharing is turned off on this site.',
  NOT_FOUND: 'Not found',
  NOT_REQUESTER: 'Only the person who asked for help can share their screen.',
  SIGN_IN_KIND: 'Share your screen from the app in your browser, signed in as yourself.',
  VIEW_AS: 'A screen cannot be shared while viewing as someone else.',
  CLOSED: 'This request is closed.',
  NO_SUPPORT_PERSON: 'You can share your screen once someone picks up your request.'
}

export type WatchRefusal =
  | 'OFF'
  | 'SIGN_IN_KIND'
  | 'NO_SHARE'
  | 'SELF'
  | 'CLOSED'
  | 'MOVED'
  | 'NOT_ASSIGNED'

/**
 * Why this viewer may not see this share, or null when they may. `viewerTeams` is read only when
 * the share goes to a team. Being an administrator changes nothing.
 */
export function watchRefusal(input: {
  enabled: boolean
  viewer: { id: string; kind: string | null | undefined; active: boolean }
  ticket: ShareTicket | null | undefined
  share: ShareState | null | undefined
  viewerTeams: () => number[]
}): WatchRefusal | null {
  const { viewer, ticket, share } = input
  if (!input.enabled) return 'OFF'
  if (!viewer.kind || !SHARE_SIGN_IN_KINDS.has(viewer.kind) || !viewer.active) return 'SIGN_IN_KIND'
  if (!share || !ticket || Number(ticket.id) !== Number(share.ticket)) return 'NO_SHARE'
  if (same(viewer.id, share.sharer)) return 'SELF'
  if (!ticketOpen(ticket)) return 'CLOSED'
  // The person the share was started with must still be who the ticket goes to.
  if (!sameTarget(targetKey(ticket), share.to)) return 'MOVED'
  if (share.to.kind === 'user') return same(share.to.id, viewer.id) ? null : 'NOT_ASSIGNED'
  return input.viewerTeams().includes(Number(share.to.id)) ? null : 'NOT_ASSIGNED'
}

/** live, or why it is over. */
export function shareLiveness(share: ShareState, now: number): 'live' | 'expired' | 'stale' {
  if (now >= share.expires_at) return 'expired'
  if (now - share.beat_at > SHARE_STALE_MS) return 'stale'
  return 'live'
}

/** Is this socket payload a well-formed frame part? */
export function cleanFrame(p: unknown): {
  ticket: number
  share: string
  seq: number
  part: number
  parts: number
  data: string
} | null {
  const o = (p ?? {}) as Record<string, unknown>
  const ticket = Number(o.ticket)
  const seq = Number(o.seq)
  const part = Number(o.part ?? 0)
  const parts = Number(o.parts ?? 1)
  if (!Number.isSafeInteger(ticket) || ticket <= 0) return null
  if (typeof o.share !== 'string' || !SHARE_ID_RE.test(o.share)) return null
  if (!Number.isSafeInteger(seq) || seq < 0) return null
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > FRAME_MAX_PARTS) return null
  if (!Number.isSafeInteger(part) || part < 0 || part >= parts) return null
  if (typeof o.data !== 'string' || o.data.length === 0 || o.data.length > FRAME_MAX_CHARS)
    return null
  return { ticket, share: o.share, seq, part, parts, data: o.data }
}

export const SHARE_ID_RE = /^[0-9a-f]{32}$/

// ── Storage ──────────────────────────────────────────────────────────────────

/** The few Redis calls a share needs (ioredis shape); `memoryShareRedis` for tests. */
export interface ShareRedis {
  get(key: string): Promise<string | null>
  /** With 'NX': 'OK' when set, null when the key already held a value. */
  set(key: string, value: string, mode: 'PX', ms: number, nx?: 'NX'): Promise<unknown>
  del(...keys: string[]): Promise<number>
  hset(key: string, field: string, value: string): Promise<unknown>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  pexpire(key: string, ms: number): Promise<unknown>
}

export function memoryShareRedis(now: () => number = Date.now): ShareRedis {
  const kv = new Map<string, { v: string; exp: number }>()
  const hashes = new Map<string, { h: Map<string, string>; exp: number }>()
  const live = <T extends { exp: number }>(m: Map<string, T>, k: string): T | undefined => {
    const e = m.get(k)
    if (e && e.exp <= now()) {
      m.delete(k)
      return undefined
    }
    return e
  }
  return {
    async get(k) {
      return live(kv, k)?.v ?? null
    },
    async set(k, v, _mode, ms, nx) {
      if (nx && live(kv, k)) return null
      kv.set(k, { v, exp: now() + ms })
      return 'OK'
    },
    async del(...keys) {
      let n = 0
      for (const k of keys) {
        if (live(kv, k)) n++
        if (live(hashes, k)) n++
        kv.delete(k)
        hashes.delete(k)
      }
      return n
    },
    async hset(k, f, v) {
      const e = live(hashes, k) ?? { h: new Map(), exp: Number.POSITIVE_INFINITY }
      e.h.set(f, v)
      hashes.set(k, e)
      return 1
    },
    async hdel(k, ...fields) {
      const e = live(hashes, k)
      for (const f of fields) e?.h.delete(f)
      return 1
    },
    async hgetall(k) {
      return Object.fromEntries(live(hashes, k)?.h ?? [])
    },
    async pexpire(k, ms) {
      const e = live(hashes, k)
      if (e) e.exp = now() + ms
      const v = live(kv, k)
      if (v) v.exp = now() + ms
      return 1
    }
  }
}

export function shareKeys(tenant: string, ticket: number) {
  const base = `nvr:ss:${tenant}:${ticket}`
  return { share: base, watchers: `${base}:w`, seen: (user: string) => `${base}:seen:${up(user)}` }
}

export async function readShare(
  redis: ShareRedis,
  tenant: string,
  ticket: number
): Promise<ShareState | null> {
  const raw = await redis.get(shareKeys(tenant, ticket).share)
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as ShareState
    return s && typeof s.id === 'string' ? s : null
  } catch {
    return null
  }
}

export async function writeShare(
  redis: ShareRedis,
  tenant: string,
  share: ShareState,
  now: number
): Promise<void> {
  // Kept past its end so a late look still finds it, logs how it ended, then forgets it.
  const ms = Math.max(1_000, share.expires_at - now) + SHARE_KEEP_AFTER_MS
  await redis.set(shareKeys(tenant, share.ticket).share, JSON.stringify(share), 'PX', ms)
}

/** A watcher socket's entry: the person and sign-in kind its own process read from the socket. */
export interface WatchEntry {
  user: string
  kind: string
  at: number
}

export async function readWatchers(
  redis: ShareRedis,
  tenant: string,
  ticket: number,
  now: number
): Promise<Array<WatchEntry & { socket: string }>> {
  const all = await redis.hgetall(shareKeys(tenant, ticket).watchers)
  const out: Array<WatchEntry & { socket: string }> = []
  const old: string[] = []
  for (const [socket, raw] of Object.entries(all ?? {})) {
    try {
      const e = JSON.parse(raw) as WatchEntry
      if (now - Number(e.at) > WATCH_TTL_MS) old.push(socket)
      else out.push({ socket, user: String(e.user), kind: String(e.kind), at: Number(e.at) })
    } catch {
      old.push(socket)
    }
  }
  if (old.length)
    await redis.hdel(shareKeys(tenant, ticket).watchers, ...old).catch(() => undefined)
  return out
}

// ── Database reads (cached briefly: frames arrive several times a second) ────

const TICKET_TTL_MS = 5_000
const PERSON_TTL_MS = 10_000
const ticketCache = new Map<string, { v: ShareTicket | null; exp: number }>()
const personCache = new Map<string, { v: { active: boolean; teams: number[] }; exp: number }>()

function capped<K, V>(m: Map<K, V>): Map<K, V> {
  if (m.size > 2_000) m.clear()
  return m
}

export async function loadShareTicket(id: number, tenant = ''): Promise<ShareTicket | null> {
  const row = (await db('nivaro_tasks')
    .where({ id, kind: SUPPORT_KIND })
    .first('id', 'kind', 'status', 'created_by', 'assignee', 'team_id')) as ShareTicket | undefined
  const v = row
    ? {
        id: Number(row.id),
        kind: row.kind,
        status: String(row.status),
        created_by: up(row.created_by),
        assignee: row.assignee ? up(row.assignee) : null,
        team_id: row.team_id != null ? Number(row.team_id) : null
      }
    : null
  capped(ticketCache).set(`${tenant}|${id}`, { v, exp: Date.now() + TICKET_TTL_MS })
  return v
}

export async function cachedShareTicket(id: number, tenant: string): Promise<ShareTicket | null> {
  const hit = ticketCache.get(`${tenant}|${id}`)
  if (hit && hit.exp > Date.now()) return hit.v
  return loadShareTicket(id, tenant)
}

/** The watcher's account state: active (and not redacted), and their team ids. */
export async function cachedPerson(
  userId: string,
  tenant: string
): Promise<{ active: boolean; teams: number[] }> {
  const key = `${tenant}|${up(userId)}`
  const hit = personCache.get(key)
  if (hit && hit.exp > Date.now()) return hit.v
  const [u, teams] = await Promise.all([
    db('nivaro_users').where({ id: userId }).first('status', 'is_redacted'),
    db('nivaro_user_group_members').where('user', userId).select('group_id')
  ])
  const row = u as { status?: string; is_redacted?: unknown } | undefined
  const v = {
    active: row?.status === 'active' && !row?.is_redacted,
    teams: (teams as Array<{ group_id: number }>).map((r) => Number(r.group_id))
  }
  capped(personCache).set(key, { v, exp: Date.now() + PERSON_TTL_MS })
  return v
}

/** Tests and a ticket write (reassign / close): forget the cached ticket at once. */
export function forgetShareTicket(id?: number): void {
  if (id == null) ticketCache.clear()
  else for (const k of [...ticketCache.keys()]) if (k.endsWith(`|${id}`)) ticketCache.delete(k)
}

export function __resetScreenShareCaches(): void {
  ticketCache.clear()
  personCache.clear()
}

export async function personName(userId: string): Promise<string> {
  const u = (await db('nivaro_users')
    .where({ id: userId })
    .first('first_name', 'last_name', 'email')) as
    | { first_name?: string | null; last_name?: string | null; email?: string | null }
    | undefined
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || 'Someone'
}

/** The share target with its display name. */
export async function resolveTarget(t: ShareTicket): Promise<ShareTarget | null> {
  const k = targetKey(t)
  if (!k) return null
  if (k.kind === 'user') return { kind: 'user', id: k.id, name: await personName(k.id) }
  const g = (await db('nivaro_user_groups').where({ id: k.id }).first('name')) as
    | { name?: string }
    | undefined
  return { kind: 'team', id: k.id, name: g?.name ? String(g.name) : 'the support team' }
}

/** The people a share goes to, for "a share started / ended" nudges (ids only). */
export async function targetPeople(to: ShareTarget): Promise<string[]> {
  if (to.kind === 'user') return [to.id]
  const rows = (await db('nivaro_user_group_members as m')
    .join('nivaro_users as u', 'u.id', 'm.user')
    .where('m.group_id', to.id)
    .where('u.status', 'active')
    .select('u.id')
    .limit(200)) as Array<{ id: string }>
  return rows.map((r) => up(r.id))
}

// ── Relay judgement ──────────────────────────────────────────────────────────

export interface RelayJudgeDeps {
  enabled: boolean
  ticket: () => Promise<ShareTicket | null>
  person: (userId: string) => Promise<{ active: boolean; teams: number[] }>
}

/**
 * The watcher sockets that get this share's frames. Each one is judged as its person (account
 * active, still the share's target, ticket still open and still going to that target) and by its
 * sign-in kind; anything that cannot be judged gets nothing.
 */
export async function frameRecipients(
  watchers: Array<{ socket: string; user: string; kind: string }>,
  share: ShareState,
  deps: RelayJudgeDeps
): Promise<{ to: string[]; refused: Array<{ socket: string; reason: WatchRefusal | 'ERROR' }> }> {
  const to: string[] = []
  const refused: Array<{ socket: string; reason: WatchRefusal | 'ERROR' }> = []
  let ticket: ShareTicket | null = null
  try {
    ticket = await deps.ticket()
  } catch {
    return { to, refused: watchers.map((w) => ({ socket: w.socket, reason: 'ERROR' as const })) }
  }
  const seen = new Set<string>()
  await Promise.all(
    watchers.map(async (w) => {
      if (!w.socket || seen.has(w.socket)) return
      seen.add(w.socket)
      try {
        const p =
          w.kind && SHARE_SIGN_IN_KINDS.has(w.kind)
            ? await deps.person(w.user)
            : { active: false, teams: [] }
        const reason = watchRefusal({
          enabled: deps.enabled,
          viewer: { id: w.user, kind: w.kind, active: p.active },
          ticket,
          share,
          viewerTeams: () => p.teams
        })
        if (reason) refused.push({ socket: w.socket, reason })
        else to.push(w.socket)
      } catch {
        refused.push({ socket: w.socket, reason: 'ERROR' })
      }
    })
  )
  return { to, refused }
}

/** Has the ticket moved away from this share (closed, reassigned)? Then the share ends. */
export function shareOutlived(share: ShareState, ticket: ShareTicket | null): boolean {
  if (!ticket || !ticketOpen(ticket)) return true
  return !sameTarget(targetKey(ticket), share.to)
}

/** Per-share relay budget (bytes per rolling minute), in the process that relays its frames. */
export function createShareBudget(limit = SHARE_BYTES_PER_MIN, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; bytes: number }>()
  return {
    take(shareId: string, bytes: number): boolean {
      const t = now()
      let w = windows.get(shareId)
      if (!w || t - w.start >= 60_000) {
        if (windows.size > 500) windows.clear()
        w = { start: t, bytes: 0 }
        windows.set(shareId, w)
      }
      if (w.bytes + bytes > limit) return false
      w.bytes += bytes
      return true
    },
    forget(shareId: string) {
      windows.delete(shareId)
    }
  }
}

export function minutesText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  return `${min} min`
}

export const END_REASON_TEXT: Record<string, string> = {
  stopped: 'stopped sharing',
  expired: 'sharing stopped after 30 minutes',
  stale: 'sharing stopped when the page closed',
  page: 'sharing stopped when the page closed',
  moved: 'sharing stopped because the request moved',
  closed: 'sharing stopped because the request closed',
  replaced: 'sharing restarted'
}

// ── Ending a share ───────────────────────────────────────────────────────────

export interface EndDeps {
  redis: ShareRedis
  /** Write one line to the ticket's history (nivaro_activity). */
  log: (ticket: number, userId: string | null, comment: string, action: string) => Promise<void>
  /** `screenshare:ended {ticket, share, reason}` to these people (their user rooms). */
  tellPeople: (userIds: string[], payload: Record<string, unknown>) => void
  /** … and to these sockets (the watchers). */
  tellSockets: (sockets: string[], payload: Record<string, unknown>) => void
  /** `screenshare:state {ticket}` to the sharer and the target people (open sheets refetch). */
  announce?: (share: ShareState) => void
  now: () => number
}

/**
 * End a share once: the process whose DEL removes the share key logs the line and tells the
 * sharer and the watchers; a second ender finds nothing and returns false. `expect` = the share
 * id the caller ended (null = whatever runs).
 */
export async function endShare(
  deps: EndDeps,
  tenant: string,
  ticket: number,
  reason: keyof typeof END_REASON_TEXT,
  actorId: string | null,
  expect: string | null = null
): Promise<boolean> {
  const share = await readShare(deps.redis, tenant, ticket)
  if (!share || (expect && share.id !== expect)) return false
  const k = shareKeys(tenant, ticket)
  if ((await deps.redis.del(k.share)) < 1) return false
  // Every socket still listed is told (a lapsed heartbeat may still have the view open).
  const watchers = Object.keys(await deps.redis.hgetall(k.watchers).catch(() => ({})))
  await deps.redis.del(k.watchers).catch(() => 0)
  const payload = { ticket, share: share.id, reason }
  deps.tellPeople([share.sharer], payload)
  if (watchers.length) deps.tellSockets(watchers, payload)
  deps.announce?.(share)
  const endedAt = reason === 'stale' ? share.beat_at : Math.min(deps.now(), share.expires_at)
  const took = minutesText(endedAt - share.started_at)
  const text =
    reason === 'stopped'
      ? `Stopped sharing their screen (${took})`
      : `Screen share ended: ${END_REASON_TEXT[reason] ?? reason} (${took})`
  await deps.log(ticket, reason === 'stopped' ? actorId : null, text, 'screen-share-stop')
  return true
}
