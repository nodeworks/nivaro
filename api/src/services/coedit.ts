/**
 * Co-editing long text (realtime round 3, item 8) — the session store.
 *
 * When two or more people type in the same rich-text field of the same record, their typing
 * merges live. The browsers run ProseMirror's central-authority model (the protocol of
 * prosemirror-collab): each sends the steps it made against the version it last saw; the
 * authority accepts a batch only when that version is still the newest, appends it and hands
 * out the new version; a browser that was behind receives the steps it missed, rebases its own
 * on top and sends again. Every browser therefore applies the same steps in the same order and
 * ends on the same document.
 *
 * This module is the authority. A session is SESSION STATE ONLY: the document it started from
 * (the first typist's field value, as ProseMirror JSON), the steps since, and who is in it, in
 * Redis under one key prefix with a sliding TTL, so every API replica answers for the same
 * session and nothing outlives it. The field is saved the normal way — the record form's Save
 * through the items service — never from here. The server never reads the steps (it holds no
 * schema): it checks shape and size, orders them and passes them on.
 *
 * Without Redis (tests, a lone process) the same store runs in memory.
 */

/** How long an idle session lives (every open, batch and heartbeat extends it). */
export const COEDIT_TTL_S = 600
/** A member who sent nothing (no steps, no heartbeat) for this long has left. */
export const COEDIT_MEMBER_STALE_MS = 45_000
/** Steps one session may hold; past it the session ends and the next typist opens a new one. */
export const COEDIT_MAX_STEPS = 5_000
/** Steps in one batch. */
export const COEDIT_MAX_BATCH = 200
/** Bytes of one batch (its JSON). */
export const COEDIT_MAX_BATCH_BYTES = 128 * 1024
/** Bytes of the document a session starts from (its JSON). */
export const COEDIT_MAX_DOC_BYTES = 512 * 1024
/** Bytes of one step (its JSON): a paste of a long passage fits, a flood does not. */
export const COEDIT_MAX_STEP_BYTES = 64 * 1024
/** Bytes a session may hold in all (its document plus every step): past it the session is full
 *  and ends; the browsers fall back to plain editing and the merge at save. */
export const COEDIT_MAX_SESSION_BYTES = 2 * 1024 * 1024

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ITEM_RE = /^[A-Za-z0-9_-]{1,64}$/
const CLIENT_RE = /^[A-Za-z0-9_-]{4,40}$/

export interface CoeditTarget {
  collection: string
  item: string
  field: string
}

/** `{collection, item, field}` from a client payload, or null when any part is not plain. */
export function cleanTarget(p: unknown): CoeditTarget | null {
  const o = (p ?? {}) as Record<string, unknown>
  const collection = typeof o.collection === 'string' ? o.collection : ''
  const item = o.item == null ? '' : String(o.item)
  const field = typeof o.field === 'string' ? o.field : ''
  if (!NAME_RE.test(collection) || !ITEM_RE.test(item) || !FIELD_RE.test(field)) return null
  if (/^(nivaro_|directus_|chat_)/i.test(collection)) return null
  return { collection, item, field }
}

/** A browser's editor id (one per mounted editor), or null. */
export function cleanClientId(v: unknown): string | null {
  return typeof v === 'string' && CLIENT_RE.test(v) ? v : null
}

// The ProseMirror step shapes (prosemirror-transform's toJSON), and nothing else: the server
// never applies a step, but it only stores and relays ones that are well-formed.
const POS_MAX = 10_000_000
const isPos = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= POS_MAX
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const isMark = (v: unknown) => isObj(v) && typeof v.type === 'string'
const isSlice = (v: unknown) =>
  v === undefined ||
  (isObj(v) &&
    (v.content === undefined || Array.isArray(v.content)) &&
    (v.openStart === undefined || isPos(v.openStart)) &&
    (v.openEnd === undefined || isPos(v.openEnd)))
const STEP_SHAPES: Record<string, { keys: string[]; ok: (s: Record<string, unknown>) => boolean }> =
  {
    replace: {
      keys: ['from', 'to', 'slice', 'structure'],
      ok: (s) => isPos(s.from) && isPos(s.to) && isSlice(s.slice)
    },
    replaceAround: {
      keys: ['from', 'to', 'gapFrom', 'gapTo', 'insert', 'slice', 'structure'],
      ok: (s) => [s.from, s.to, s.gapFrom, s.gapTo, s.insert].every(isPos) && isSlice(s.slice)
    },
    addMark: {
      keys: ['from', 'to', 'mark'],
      ok: (s) => isPos(s.from) && isPos(s.to) && isMark(s.mark)
    },
    removeMark: {
      keys: ['from', 'to', 'mark'],
      ok: (s) => isPos(s.from) && isPos(s.to) && isMark(s.mark)
    },
    addNodeMark: { keys: ['pos', 'mark'], ok: (s) => isPos(s.pos) && isMark(s.mark) },
    removeNodeMark: { keys: ['pos', 'mark'], ok: (s) => isPos(s.pos) && isMark(s.mark) },
    attr: { keys: ['pos', 'attr', 'value'], ok: (s) => isPos(s.pos) && typeof s.attr === 'string' },
    docAttr: { keys: ['attr', 'value'], ok: (s) => typeof s.attr === 'string' }
  }

/** One step in a shape ProseMirror makes (known type, only its own keys, sane positions). */
export function isStepShape(s: unknown): boolean {
  if (!isObj(s) || typeof s.stepType !== 'string') return false
  const shape = STEP_SHAPES[s.stepType]
  if (!shape) return false
  for (const k of Object.keys(s)) if (k !== 'stepType' && !shape.keys.includes(k)) return false
  if (s.structure !== undefined && typeof s.structure !== 'boolean') return false
  return shape.ok(s)
}

/**
 * A batch of steps as the store keeps it, or null when it is not one: 1..COEDIT_MAX_BATCH steps
 * of a ProseMirror shape (isStepShape), each at most COEDIT_MAX_STEP_BYTES and together at most
 * COEDIT_MAX_BATCH_BYTES of JSON.
 */
export function cleanSteps(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > COEDIT_MAX_BATCH) return null
  const out: string[] = []
  let bytes = 0
  for (const s of v) {
    if (!isStepShape(s)) return null
    const json = JSON.stringify(s)
    if (json.length > COEDIT_MAX_STEP_BYTES) return null
    bytes += json.length
    if (bytes > COEDIT_MAX_BATCH_BYTES) return null
    out.push(json)
  }
  return out
}

/** The document a session starts from: ProseMirror JSON with a `type`, within the size cap. */
export function cleanDoc(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  if (typeof (v as { type?: unknown }).type !== 'string') return null
  const json = JSON.stringify(v)
  return json.length <= COEDIT_MAX_DOC_BYTES ? json : null
}

/** One step as stored: the step JSON and the editor that made it. */
export interface StoredStep {
  s: unknown
  c: string
}

export interface SessionState {
  /** This session's id: a new session (after one ended) never continues an old one's versions. */
  sid: string
  /** The version the base document is at (0 for a fresh session). */
  baseVersion: number
  /** The base document (ProseMirror JSON). */
  doc: unknown
  /** Every step since the base, in order. */
  steps: StoredStep[]
  /** baseVersion + steps.length. */
  version: number
}

export type AppendResult =
  | { ok: true; version: number }
  /** The batch was made against an older version: send the steps since `version` first. */
  | { ok: false; reason: 'behind'; version: number }
  /** No session (it ended, or lapsed). */
  | { ok: false; reason: 'gone' }
  /** The session is full: it ends, the next typist opens a fresh one. */
  | { ok: false; reason: 'full' }

export interface CoeditStore {
  /** Start the session from `doc` unless one is running; join `member`. */
  open(
    key: string,
    doc: string,
    member: string,
    now: number,
    sid?: string
  ): Promise<{ created: boolean; state: SessionState }>
  read(key: string): Promise<SessionState | null>
  /** Steps after `version`; null = no session, or `version` is not inside it. */
  since(
    key: string,
    version: number
  ): Promise<{ sid: string; version: number; steps: StoredStep[] } | null>
  /** Append a batch made against `version` of session `sid` (another session = 'gone'). */
  append(
    key: string,
    sid: string,
    version: number,
    steps: string[],
    clientId: string,
    member: string,
    now: number
  ): Promise<AppendResult>
  /** Heartbeat: keep `member` (and the session) alive. */
  seen(key: string, member: string, now: number): Promise<void>
  /** `member` left; true = nobody is left, and the session is gone. */
  leave(key: string, member: string, now: number): Promise<boolean>
  drop(key: string): Promise<void>
}

/** The store key of one field's session (tenant-scoped: record ids repeat across tenants). */
export function sessionKey(tenant: string, t: CoeditTarget): string {
  // One hash tag, so the session's keys share a slot on a Redis cluster.
  return `nvr:coedit:{${tenant || '-'}|${t.collection}|${t.item}|${t.field}}`
}

function parseEntry(raw: string): StoredStep | null {
  try {
    const e = JSON.parse(raw) as { s?: unknown; c?: unknown }
    return e && typeof e.c === 'string' ? { s: e.s, c: e.c } : null
  } catch {
    return null
  }
}

/** A fresh session id. */
export function newSessionId(): string {
  return `s${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-5)}`
}

function entryOf(step: string, clientId: string): string {
  return `{"s":${step},"c":${JSON.stringify(clientId)}}`
}

// ── In memory ───────────────────────────────────────────────────────────────

interface MemSession {
  sid: string
  bytes: number
  baseVersion: number
  doc: string
  steps: string[]
  members: Map<string, number>
  expires: number
}

export function memoryCoeditStore(): CoeditStore & { size(): number } {
  const sessions = new Map<string, MemSession>()
  const live = (key: string, now: number): MemSession | null => {
    const s = sessions.get(key)
    if (!s) return null
    for (const [m, at] of s.members) if (at < now - COEDIT_MEMBER_STALE_MS) s.members.delete(m)
    // Lapsed, or every writer in it went quiet (a browser that died without saying so): gone.
    if (s.expires <= now || s.members.size === 0) {
      sessions.delete(key)
      return null
    }
    return s
  }
  const stateOf = (s: MemSession): SessionState => ({
    sid: s.sid,
    baseVersion: s.baseVersion,
    doc: JSON.parse(s.doc),
    steps: s.steps.map(parseEntry).filter((e): e is StoredStep => !!e),
    version: s.baseVersion + s.steps.length
  })
  const touch = (s: MemSession, now: number) => {
    s.expires = now + COEDIT_TTL_S * 1000
  }
  return {
    size: () => sessions.size,
    async open(key, doc, member, now, sid = newSessionId()) {
      // A session nobody is still in (live() drops it) starts over from this document.
      let s = live(key, now)
      const created = !s
      if (!s) {
        s = {
          sid,
          bytes: doc.length,
          baseVersion: 0,
          doc,
          steps: [],
          members: new Map(),
          expires: 0
        }
        sessions.set(key, s)
      }
      s.members.set(member, now)
      touch(s, now)
      return { created, state: stateOf(s) }
    },
    async read(key) {
      const s = live(key, Date.now())
      return s ? stateOf(s) : null
    },
    async since(key, version) {
      const s = live(key, Date.now())
      if (!s || version < s.baseVersion) return null
      const from = version - s.baseVersion
      if (from > s.steps.length) return null
      return {
        sid: s.sid,
        version,
        steps: s.steps
          .slice(from)
          .map(parseEntry)
          .filter((e): e is StoredStep => !!e)
      }
    },
    async append(key, sid, version, steps, clientId, member, now) {
      const s = live(key, now)
      if (!s || s.sid !== sid) return { ok: false, reason: 'gone' }
      const cur = s.baseVersion + s.steps.length
      if (version !== cur) return { ok: false, reason: 'behind', version: cur }
      if (s.steps.length + steps.length > COEDIT_MAX_STEPS) return { ok: false, reason: 'full' }
      const entries = steps.map((step) => entryOf(step, clientId))
      const add = entries.reduce((n, e) => n + e.length, 0)
      if (s.bytes + add > COEDIT_MAX_SESSION_BYTES) return { ok: false, reason: 'full' }
      s.bytes += add
      for (const e of entries) s.steps.push(e)
      s.members.set(member, now)
      touch(s, now)
      return { ok: true, version: cur + steps.length }
    },
    async seen(key, member, now) {
      const s = live(key, now)
      if (!s) return
      s.members.set(member, now)
      touch(s, now)
    },
    async leave(key, member, now) {
      const s = live(key, now)
      if (!s) return true
      s.members.delete(member)
      for (const [m, at] of s.members) if (at < now - COEDIT_MEMBER_STALE_MS) s.members.delete(m)
      if (s.members.size > 0) return false
      sessions.delete(key)
      return true
    },
    async drop(key) {
      sessions.delete(key)
    }
  }
}

// ── Redis ───────────────────────────────────────────────────────────────────

export interface CoeditRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  llen(key: string): Promise<number>
  del(...keys: string[]): Promise<unknown>
}

const keysOf = (key: string) => ({ meta: `${key}:m`, steps: `${key}:s`, members: `${key}:p` })

// KEYS meta steps members · ARGV doc member now ttl sid staleBefore → {created, bv, doc, sid, ...steps}
// A session whose writers all went quiet (a browser that died without saying so) starts over.
const OPEN_SCRIPT = `
local created = 0
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. ARGV[6])
if redis.call('EXISTS', KEYS[1]) == 1 and redis.call('ZCARD', KEYS[3]) == 0 then
  redis.call('DEL', KEYS[1], KEYS[2])
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[2], KEYS[3])
  redis.call('HSET', KEYS[1], 'bv', 0, 'doc', ARGV[1], 'sid', ARGV[5], 'bytes', string.len(ARGV[1]))
  created = 1
end
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2])
for i = 1, 3 do redis.call('EXPIRE', KEYS[i], ARGV[4]) end
local m = redis.call('HMGET', KEYS[1], 'bv', 'doc', 'sid')
local out = { created, m[1], m[2], m[3] }
for _, s in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do out[#out + 1] = s end
return out`

// KEYS meta steps members · ARGV version member now ttl max sid maxBytes entry... → {code, version}
const APPEND_SCRIPT = `
if redis.call('HGET', KEYS[1], 'sid') ~= ARGV[6] then return { -1, 0 } end
local bv = tonumber(redis.call('HGET', KEYS[1], 'bv')) or 0
local len = redis.call('LLEN', KEYS[2])
local cur = bv + len
if tonumber(ARGV[1]) ~= cur then return { -2, cur } end
local n = #ARGV - 7
if len + n > tonumber(ARGV[5]) then return { -3, cur } end
local add = 0
for i = 8, #ARGV do add = add + string.len(ARGV[i]) end
local bytes = tonumber(redis.call('HGET', KEYS[1], 'bytes')) or 0
if bytes + add > tonumber(ARGV[7]) then return { -3, cur } end
redis.call('HINCRBY', KEYS[1], 'bytes', add)
for i = 8, #ARGV do redis.call('RPUSH', KEYS[2], ARGV[i]) end
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2])
for i = 1, 3 do redis.call('EXPIRE', KEYS[i], ARGV[4]) end
return { 0, cur + n }`

// KEYS meta steps members · ARGV member now ttl
const SEEN_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
for i = 1, 3 do redis.call('EXPIRE', KEYS[i], ARGV[3]) end
return 1`

// KEYS meta steps members · ARGV staleBefore → 1 = a session with someone still in it; a
// session whose writers all went quiet is deleted (watchers never adopt a dead session's text).
const ALIVE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. ARGV[1])
if redis.call('ZCARD', KEYS[3]) > 0 then return 1 end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return 0`

// KEYS meta steps members · ARGV member staleBefore → 1 = ended
const LEAVE_SCRIPT = `
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. ARGV[2])
if redis.call('ZCARD', KEYS[3]) > 0 then return 0 end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return 1`

export function redisCoeditStore(redis: CoeditRedis): CoeditStore {
  const run = (script: string, key: string, ...args: Array<string | number>) => {
    const k = keysOf(key)
    return redis.eval(script, 3, k.meta, k.steps, k.members, ...args)
  }
  const entries = (raw: string[]) => raw.map(parseEntry).filter((e): e is StoredStep => !!e)
  return {
    async open(key, doc, member, now, sid = newSessionId()) {
      const out = (await run(
        OPEN_SCRIPT,
        key,
        doc,
        member,
        now,
        COEDIT_TTL_S,
        sid,
        now - COEDIT_MEMBER_STALE_MS
      )) as unknown[]
      const baseVersion = Number(out[1]) || 0
      const steps = entries((out.slice(4) as unknown[]).map(String))
      return {
        created: Number(out[0]) === 1,
        state: {
          sid: String(out[3] ?? ''),
          baseVersion,
          doc: JSON.parse(String(out[2] ?? 'null')),
          steps,
          version: baseVersion + steps.length
        }
      }
    },
    async read(key) {
      const k = keysOf(key)
      if (Number(await run(ALIVE_SCRIPT, key, Date.now() - COEDIT_MEMBER_STALE_MS)) !== 1)
        return null
      const [bv, doc, sid] = await redis.hmget(k.meta, 'bv', 'doc', 'sid')
      if (doc == null) return null
      const baseVersion = Number(bv) || 0
      const steps = entries(await redis.lrange(k.steps, 0, -1))
      return {
        sid: sid ?? '',
        baseVersion,
        doc: JSON.parse(doc),
        steps,
        version: baseVersion + steps.length
      }
    },
    async since(key, version) {
      const k = keysOf(key)
      const [bv, doc, sid] = await redis.hmget(k.meta, 'bv', 'doc', 'sid')
      if (doc == null) return null
      const base = Number(bv) || 0
      if (version < base) return null
      // Past the end: the asker holds a version this session never reached (another session's).
      if (version > base + (await redis.llen(k.steps))) return null
      const raw = await redis.lrange(k.steps, version - base, -1)
      return { sid: sid ?? '', version, steps: entries(raw) }
    },
    async append(key, sid, version, steps, clientId, member, now) {
      const out = (await run(
        APPEND_SCRIPT,
        key,
        version,
        member,
        now,
        COEDIT_TTL_S,
        COEDIT_MAX_STEPS,
        sid,
        COEDIT_MAX_SESSION_BYTES,
        ...steps.map((s) => entryOf(s, clientId))
      )) as unknown[]
      const code = Number(out?.[0])
      const v = Number(out?.[1]) || 0
      if (code === 0) return { ok: true, version: v }
      if (code === -2) return { ok: false, reason: 'behind', version: v }
      if (code === -3) return { ok: false, reason: 'full' }
      return { ok: false, reason: 'gone' }
    },
    async seen(key, member, now) {
      await run(SEEN_SCRIPT, key, member, now, COEDIT_TTL_S)
    },
    async leave(key, member, now) {
      return Number(await run(LEAVE_SCRIPT, key, member, now - COEDIT_MEMBER_STALE_MS)) === 1
    },
    async drop(key) {
      const k = keysOf(key)
      await redis.del(k.meta, k.steps, k.members)
    }
  }
}
