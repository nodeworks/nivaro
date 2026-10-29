import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { type CollectionChange, collectionChangeOf, onJournalEntry } from './journal-listeners.js'

/**
 * Live MCP sessions (#2467): record subscriptions over the hosted endpoint.
 *
 * /api/mcp is stateless — every POST builds a fresh server. A client that connects to
 * `/api/mcp?live=1` gets an `Mcp-Session-Id` on its initialize answer instead, and with it:
 *   - resources/subscribe + resources/unsubscribe on `nivaro://record/<collection>/<id>`
 *   - GET /api/mcp (the session's event stream, SSE) carrying
 *     `notifications/resources/updated { uri, _meta: { changed_fields, action } }` when the
 *     record changes — the URI and field NAMES, never a value
 *   - DELETE /api/mcp to end the session.
 *
 * A session is only a name for a list of subscriptions, bound to the user who opened it and
 * the tenant it was opened in. It lives in Redis (memory when there is none) with a sliding
 * 24 h lifetime, so POSTs can land on any replica; the event stream holds no credential beyond
 * the request that opened it. Record changes are heard from the event journal
 * (journal-listeners.ts), which every replica hears for every replica's writes while the Redis
 * event stream is on. Each POST still builds a fresh server: requests in a session cost what
 * stateless ones do.
 *
 * MCP_SESSIONS=off turns live mode off (?live=1 is then ignored and everything is stateless).
 */

const off = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'off'
export const mcpSessionsEnabled = () => !off(process.env.MCP_SESSIONS)

export const MCP_SESSION_HEADER = 'mcp-session-id'
/** Records one session may follow at once. */
export const MAX_SUBSCRIPTIONS = 50
export const SESSION_TTL_S = 24 * 3600

const SESSION_ID = /^[A-Za-z0-9-]{16,64}$/
export const validSessionId = (id: unknown): id is string =>
  typeof id === 'string' && SESSION_ID.test(id)

/** `?live=1` (or true/on) on the endpoint URL. */
export function wantsLiveMode(url: string | undefined): boolean {
  const q = (url ?? '').split('?')[1]
  if (!q) return false
  const v = new URLSearchParams(q).get('live')?.toLowerCase()
  return v === '1' || v === 'true' || v === 'on'
}

/** Whether a JSON-RPC body (one message or a batch) is an initialize request. */
export function isInitializeBody(body: unknown): boolean {
  const list = Array.isArray(body) ? body : [body]
  return list.some(
    (m) => !!m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize'
  )
}

export interface McpSession {
  id: string
  user: string
  tenant: string
  created: number
  /** Which event stream currently owns the session (one at a time). */
  stream?: string | null
}

// ─── Store (Redis, memory fallback) ───────────────────────────────────────────

const metaKey = (tenant: string, id: string) => `nvr:mcp:sess:${tenant || '-'}:${id}`
const subsKey = (tenant: string, id: string) => `nvr:mcp:subs:${tenant || '-'}:${id}`

interface MemEntry {
  meta: McpSession
  subs: Set<string>
  exp: number
}
const mem = new Map<string, MemEntry>()

function memGet(tenant: string, id: string): MemEntry | null {
  const e = mem.get(metaKey(tenant, id))
  if (!e) return null
  if (e.exp < Date.now()) {
    mem.delete(metaKey(tenant, id))
    return null
  }
  return e
}

function parseMeta(raw: string | null): McpSession | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as McpSession
    return v && typeof v.id === 'string' && typeof v.user === 'string' ? v : null
  } catch {
    return null
  }
}

export async function openSession(
  redis: Redis | null | undefined,
  input: { user: string; tenant: string; id?: string }
): Promise<McpSession> {
  const meta: McpSession = {
    id: input.id ?? randomUUID(),
    user: input.user,
    tenant: input.tenant,
    created: Date.now(),
    stream: null
  }
  if (redis)
    await redis.set(metaKey(meta.tenant, meta.id), JSON.stringify(meta), 'EX', SESSION_TTL_S)
  else
    mem.set(metaKey(meta.tenant, meta.id), {
      meta,
      subs: new Set(),
      exp: Date.now() + SESSION_TTL_S * 1000
    })
  return meta
}

export async function findSession(
  redis: Redis | null | undefined,
  id: string,
  tenant: string
): Promise<McpSession | null> {
  if (!validSessionId(id)) return null
  if (!redis) return memGet(tenant, id)?.meta ?? null
  return parseMeta(await redis.get(metaKey(tenant, id)))
}

/** Slide the session's lifetime (its subscriptions with it). */
export async function touchSession(redis: Redis | null | undefined, s: McpSession): Promise<void> {
  if (!redis) {
    const e = memGet(s.tenant, s.id)
    if (e) e.exp = Date.now() + SESSION_TTL_S * 1000
    return
  }
  await redis
    .multi()
    .expire(metaKey(s.tenant, s.id), SESSION_TTL_S)
    .expire(subsKey(s.tenant, s.id), SESSION_TTL_S)
    .exec()
}

async function writeMeta(redis: Redis | null | undefined, s: McpSession): Promise<void> {
  if (!redis) {
    const e = memGet(s.tenant, s.id)
    if (e) e.meta = s
    return
  }
  await redis.set(metaKey(s.tenant, s.id), JSON.stringify(s), 'EX', SESSION_TTL_S)
}

export async function endSession(redis: Redis | null | undefined, s: McpSession): Promise<void> {
  if (redis) await redis.del(metaKey(s.tenant, s.id), subsKey(s.tenant, s.id))
  else mem.delete(metaKey(s.tenant, s.id))
  localStreams.get(streamKey(s))?.close('session_ended')
}

export async function listSubscriptions(
  redis: Redis | null | undefined,
  s: McpSession
): Promise<string[]> {
  if (!redis) return [...(memGet(s.tenant, s.id)?.subs ?? [])]
  return redis.smembers(subsKey(s.tenant, s.id))
}

/** Remember a subscription. 'limit' when the session already follows MAX_SUBSCRIPTIONS. */
export async function addSubscription(
  redis: Redis | null | undefined,
  s: McpSession,
  uri: string
): Promise<'ok' | 'limit'> {
  if (!redis) {
    const e = memGet(s.tenant, s.id)
    if (!e) return 'ok'
    if (!e.subs.has(uri) && e.subs.size >= MAX_SUBSCRIPTIONS) return 'limit'
    e.subs.add(uri)
  } else {
    const key = subsKey(s.tenant, s.id)
    const [isMember, count] = await Promise.all([redis.sismember(key, uri), redis.scard(key)])
    if (!isMember && count >= MAX_SUBSCRIPTIONS) return 'limit'
    await redis.multi().sadd(key, uri).expire(key, SESSION_TTL_S).exec()
  }
  void localStreams.get(streamKey(s))?.refresh()
  return 'ok'
}

export async function removeSubscription(
  redis: Redis | null | undefined,
  s: McpSession,
  uri: string
): Promise<void> {
  if (!redis) memGet(s.tenant, s.id)?.subs.delete(uri)
  else await redis.srem(subsKey(s.tenant, s.id), uri)
  void localStreams.get(streamKey(s))?.refresh()
}

// ─── Event streams ────────────────────────────────────────────────────────────

const RECORD_URI = /^nivaro:\/\/record\/([^/?#]+)\/([^/?#]+)$/
/** #3220 — an agent's ask_human question: notified when it is answered, expires or is withdrawn. */
const QUESTION_URI = /^nivaro:\/\/question\/([0-9a-f-]{36})$/i
export const QUESTION_COLLECTION = 'nivaro_agent_questions'

/** What a subscribed URI follows: a record, or an agent question (as its table + id). */
export function subscribedTargetOf(uri: string): { collection: string; id: string } | null {
  const q = QUESTION_URI.exec(uri)
  if (q) return { collection: QUESTION_COLLECTION, id: q[1].toLowerCase() }
  const m = RECORD_URI.exec(uri)
  if (!m) return null
  try {
    return { collection: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) }
  } catch {
    return null
  }
}

/** The match key a record (or question) URI listens on, or null for anything else. */
export function recordKeyOf(uri: string): { collection: string; key: string } | null {
  const t = subscribedTargetOf(uri)
  if (!t) return null
  return { collection: t.collection, key: `${t.collection}\u0000${t.id.toLowerCase()}` }
}

const MAX_FIELDS = 50
const FLUSH_MS = 250
const REFRESH_MS = 5_000
const HEARTBEAT_MS = 25_000
const RECHECK_MS = 120_000

export interface LiveStreamDeps {
  redis: Redis | null | undefined
  session: McpSession
  /** Write raw SSE text; false when the connection is gone. */
  write(text: string): boolean
  /** End the HTTP response. */
  end(): void
  /** Is the credential that opened the stream still good? */
  credentialOk(): Promise<boolean>
  /** May the stream's user still read this record? null = could not tell (keep it). */
  canRead(collection: string, id: string): Promise<boolean | null>
  /** false in tests: drive refresh/recheck/flush by hand. */
  timers?: boolean
}

const streamKey = (s: Pick<McpSession, 'tenant' | 'id'>) => `${s.tenant}\u0000${s.id}`
const localStreams = new Map<string, McpLiveStream>()
let unlisten: (() => void) | null = null

function listen(): void {
  if (unlisten) return
  unlisten = onJournalEntry((entry) => {
    const change = collectionChangeOf(entry)
    if (!change) return
    for (const s of localStreams.values()) s.hear(change)
  })
}

export class McpLiveStream {
  readonly token = randomUUID()
  closed = false
  private byKey = new Map<string, Set<string>>()
  private byCollection = new Map<string, Set<string>>()
  private pending = new Map<string, { fields: Set<string>; actions: Set<string> }>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private seq = 0
  private checking = false

  constructor(private deps: LiveStreamDeps) {}

  get session(): McpSession {
    return this.deps.session
  }

  /** Claim the session's stream slot, load its subscriptions, start the timers. */
  async start(): Promise<void> {
    const key = streamKey(this.deps.session)
    localStreams.get(key)?.close('replaced')
    localStreams.set(key, this)
    listen()
    await writeMeta(this.deps.redis, { ...this.deps.session, stream: this.token })
    await this.refresh()
    if (this.deps.timers === false) return
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      this.timers.push(t)
    }
    every(REFRESH_MS, () => void this.refresh())
    every(HEARTBEAT_MS, () => {
      if (this.deps.write(': hb\n\n')) void touchSession(this.deps.redis, this.deps.session)
      else this.close('gone')
    })
    every(RECHECK_MS, () => void this.recheck())
  }

  /** Re-read the session: gone → close; another stream took it → close; else the subscriptions. */
  async refresh(): Promise<void> {
    if (this.closed) return
    try {
      const s = this.deps.session
      const meta = await findSession(this.deps.redis, s.id, s.tenant)
      if (!meta) return this.close('session_ended')
      if (meta.stream && meta.stream !== this.token) return this.close('replaced')
      this.index(await listSubscriptions(this.deps.redis, s))
    } catch {
      /* Redis briefly away: keep the last list, ask again next time */
    }
  }

  private index(uris: string[]): void {
    const byKey = new Map<string, Set<string>>()
    const byCollection = new Map<string, Set<string>>()
    for (const uri of uris) {
      const k = recordKeyOf(uri)
      if (!k) continue
      if (!byKey.has(k.key)) byKey.set(k.key, new Set())
      byKey.get(k.key)?.add(uri)
      if (!byCollection.has(k.collection)) byCollection.set(k.collection, new Set())
      byCollection.get(k.collection)?.add(uri)
    }
    this.byKey = byKey
    this.byCollection = byCollection
  }

  /** A record change from the journal (any replica's write). Cheap: runs for every change. */
  hear(change: CollectionChange): void {
    if (this.closed || change.tenant !== this.deps.session.tenant) return
    const uris =
      change.item === '*'
        ? this.byCollection.get(change.collection)
        : this.byKey.get(`${change.collection}\u0000${String(change.item).toLowerCase()}`)
    if (!uris?.size) return
    for (const uri of uris) {
      let p = this.pending.get(uri)
      if (!p) {
        p = { fields: new Set(), actions: new Set() }
        this.pending.set(uri, p)
      }
      for (const f of change.changed_fields ?? []) if (p.fields.size < MAX_FIELDS) p.fields.add(f)
      if (change.action) p.actions.add(change.action)
    }
    if (this.deps.timers === false) return
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_MS)
  }

  /** Send one notice per changed record (changes within FLUSH_MS of each other coalesce). */
  flush(): void {
    const batch = [...this.pending]
    this.pending.clear()
    for (const [uri, p] of batch) {
      const action = p.actions.has('delete')
        ? 'delete'
        : p.actions.has('create')
          ? 'create'
          : p.actions.has('update')
            ? 'update'
            : null
      this.notify(uri, { 'nivaro.dev/changed_fields': [...p.fields], 'nivaro.dev/action': action })
    }
  }

  private notify(uri: string, meta: Record<string, unknown>): void {
    const message = {
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri, _meta: meta }
    }
    this.seq += 1
    if (!this.deps.write(`id: ${this.seq}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`))
      this.close('gone')
  }

  /**
   * The credential still signs in, and every subscribed record is still readable. A record the
   * user lost sight of is dropped, with one last notice (`nivaro.dev/subscription: 'ended'`)
   * so the client re-reads it and hears why. A check that could not run keeps everything.
   */
  async recheck(): Promise<void> {
    if (this.closed || this.checking) return
    this.checking = true
    try {
      if (!(await this.deps.credentialOk().catch(() => true))) return this.close('signed_out')
      const s = this.deps.session
      for (const uri of await listSubscriptions(this.deps.redis, s)) {
        if (this.closed) return
        const t = subscribedTargetOf(uri)
        if (!t) continue
        const ok = await this.deps.canRead(t.collection, t.id).catch(() => null)
        if (ok !== false) continue
        await removeSubscription(this.deps.redis, s, uri)
        this.notify(uri, { 'nivaro.dev/subscription': 'ended', 'nivaro.dev/reason': 'no_access' })
      }
      await this.refresh()
    } catch {
      /* next time */
    } finally {
      this.checking = false
    }
  }

  close(_reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const t of this.timers) clearInterval(t)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    const key = streamKey(this.deps.session)
    if (localStreams.get(key) === this) localStreams.delete(key)
    if (localStreams.size === 0 && unlisten) {
      unlisten()
      unlisten = null
    }
    try {
      this.deps.end()
    } catch {
      /* already gone */
    }
  }
}

/** Every event stream this process holds — closed in preClose so shutdown never waits on them. */
export function closeAllMcpStreams(): void {
  for (const s of [...localStreams.values()]) s.close('shutdown')
}

export const mcpStreamCount = () => localStreams.size
