/**
 * Realtime leak auditor (#2760). Realtime payloads are ids and field names only, and rooms are
 * gated at join and re-checked (socket-access.ts) — this proves it from the other side. A small
 * sample of the events the server actually writes to sockets is checked, out of band, against
 * what that recipient could read over HTTP:
 *
 *   - the collection: role read permission (system tables: only the listed directory ones);
 *   - each record id the event names: the record read gate (row filters + User Scopes — the
 *     same canSeeRecordRoom a record room's join runs);
 *   - each field name it names (`changed_fields`, `fields`): the role's readable fields
 *     (system tables: their listed columns).
 *
 * A miss is a finding, logged with the event type, room and recipient, kept for the /realtime
 * console and raised as one deduped issue per event + collection + kind. Nothing is ever
 * blocked or delayed: sampling happens on the write path, every check runs later.
 *
 * Bounded cost: off unless REALTIME_LEAK_AUDIT_RATE (0–1, share of packets) is set or an
 * administrator starts a timed audit from /realtime; at most 20 checks a second and 100
 * waiting per process (the rest are counted as skipped). Administrators' sockets are not
 * checked (they read everything); deletes are not record-checked (the row is gone).
 */
import type { Redis } from 'ioredis'
import type { User } from '../types.js'
import { getApp } from './io-holder.js'
import { eventNameOf, splitTenantRoom } from './socket-transport.js'

export interface LeakFinding {
  at: string
  event: string
  room: string | null
  collection: string
  kind: 'collection' | 'record' | 'field'
  items?: string[]
  fields?: string[]
  user_id: string
}

export interface LeakSubject {
  event: string
  collection: string
  items: string[]
  fields: string[]
  action: string | null
}

const FINDINGS_KEY = 'nvr:rt:leak:findings'
const STATS_KEY = 'nvr:rt:leak:stats'
const STATE_KEY = 'nvr:rt:leak:state'
const FINDINGS_KEEP = 200
const MAX_PENDING = 100
const CHECKS_PER_S = 20
const MAX_IDS = 5
const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** The sampling share from env (pure). */
export function envAuditRate(env: NodeJS.ProcessEnv = process.env): number {
  // Never in cloud mode: findings and the timed-audit switch are not kept per tenant.
  if (env.CLOUD_META_DB_URL) return 0
  const n = Number(env.REALTIME_LEAK_AUDIT_RATE)
  return Number.isFinite(n) && n > 0 ? Math.min(1, n) : 0
}

/** What a packet claims about records, or null when it names none (pure). */
export function leakSubjectOf(encoded: string): LeakSubject | null {
  const event = eventNameOf(encoded)
  if (!event) return null
  let payload: unknown
  try {
    const i = encoded.indexOf('[')
    payload = (JSON.parse(encoded.slice(i)) as unknown[])[1]
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  const collection = typeof p.collection === 'string' ? p.collection : null
  if (!collection || !COLLECTION_RE.test(collection)) return null
  const ids: string[] = []
  const add = (v: unknown) => {
    if ((typeof v === 'string' || typeof v === 'number') && String(v) !== '*' && String(v) !== '')
      ids.push(String(v))
  }
  add(p.item)
  if (Array.isArray(p.items)) for (const v of p.items.slice(0, MAX_IDS)) add(v)
  if (!ids.length) add(p.id)
  const fields: string[] = []
  for (const key of ['changed_fields', 'fields']) {
    const v = p[key]
    if (Array.isArray(v))
      for (const f of v) if (typeof f === 'string' && f && !f.startsWith('$')) fields.push(f)
  }
  return {
    event,
    collection,
    items: [...new Set(ids)].slice(0, MAX_IDS),
    fields: [...new Set(fields)].slice(0, 50),
    action: typeof p.action === 'string' ? p.action : null
  }
}

/** Rooms whose events are never audited: the probe's, a replay's mirror rooms (pure). */
export function auditableRoom(room: string | null): boolean {
  if (!room) return true
  const r = splitTenantRoom(room).room
  return !r.startsWith('probe:') && !r.startsWith('rtreplay:')
}

export interface LeakCheckDeps {
  isAdmin(user: User): Promise<boolean>
  canRead(user: User, collection: string): Promise<boolean>
  canSeeRecord(user: User, collection: string, item: string): Promise<boolean>
  readableFields(user: User, collection: string): Promise<string[] | null>
}

async function defaultDeps(): Promise<LeakCheckDeps> {
  const [perm, access, sys] = await Promise.all([
    import('./permissions.js'),
    import('./socket-access.js'),
    import('./system-collections.js')
  ])
  return {
    isAdmin: (u) => perm.isAdminRole(u),
    canRead: async (u, c) => {
      if (sys.isSystemCollection(c)) return sys.systemReadableColumns(c) != null
      return perm.can(u, 'read', c)
    },
    canSeeRecord: (u, c, id) => access.canSeeRecordRoom(u, c, id, false),
    readableFields: async (u, c) => {
      if (sys.isSystemCollection(c)) return [...(sys.systemReadableColumns(c) ?? [])]
      return perm.getAllowedFields(u, 'read', c)
    }
  }
}

/** The findings for one sampled delivery (no I/O beyond `deps`). */
export async function checkLeak(
  user: User,
  subject: LeakSubject,
  room: string | null,
  deps: LeakCheckDeps
): Promise<LeakFinding[]> {
  if (await deps.isAdmin(user)) return []
  const base = {
    at: new Date().toISOString(),
    event: subject.event,
    room: room ? splitTenantRoom(room).room : null,
    collection: subject.collection,
    user_id: String(user.id)
  }
  if (!(await deps.canRead(user, subject.collection))) return [{ ...base, kind: 'collection' }]
  const out: LeakFinding[] = []
  if (subject.action !== 'delete') {
    const hidden: string[] = []
    for (const id of subject.items) {
      if (!(await deps.canSeeRecord(user, subject.collection, id))) hidden.push(id)
    }
    if (hidden.length) out.push({ ...base, kind: 'record', items: hidden })
  }
  if (subject.fields.length) {
    const allowed = await deps.readableFields(user, subject.collection)
    if (allowed != null && !allowed.includes('*')) {
      const set = new Set(allowed.map((f) => f.toLowerCase()))
      const bad = subject.fields.filter((f) => f !== 'id' && !set.has(f.toLowerCase()))
      if (bad.length) out.push({ ...base, kind: 'field', fields: bad })
    }
  }
  return out
}

// ─── Per-process sampler ──────────────────────────────────────────────────────

const stats = { sampled: 0, checked: 0, findings: 0, skipped: 0, admin: 0 }
let pending = 0
let tokens = CHECKS_PER_S
let tokensAt = Date.now()
let state: { rate: number; until: number } | null = null
let stateReadAt = 0

function redis(): Redis | null {
  try {
    return (getApp()?.redis as Redis | undefined) ?? null
  } catch {
    return null
  }
}

/** The share of packets sampled right now: a timed audit wins over the env default. */
export function currentAuditRate(now = Date.now()): number {
  if (process.env.CLOUD_META_DB_URL) return 0
  if (now - stateReadAt > 30_000) {
    stateReadAt = now
    const r = redis()
    if (r)
      void r
        .get(STATE_KEY)
        .then((raw) => {
          state = raw ? (JSON.parse(raw) as { rate: number; until: number }) : null
        })
        .catch(() => {})
  }
  if (state && now < state.until) return state.rate
  return envAuditRate()
}

function takeToken(now: number): boolean {
  tokens = Math.min(CHECKS_PER_S, tokens + ((now - tokensAt) / 1000) * CHECKS_PER_S)
  tokensAt = now
  if (tokens < 1) return false
  tokens -= 1
  return true
}

async function record(found: LeakFinding[]): Promise<void> {
  stats.findings += found.length
  const r = redis()
  for (const f of found) {
    try {
      getApp()?.log?.warn?.({ leak: f }, 'realtime leak audit finding')
    } catch {
      /* logging is decoration */
    }
    if (r) {
      try {
        await r
          .multi()
          .lpush(FINDINGS_KEY, JSON.stringify(f))
          .ltrim(FINDINGS_KEY, 0, FINDINGS_KEEP - 1)
          .hincrby(STATS_KEY, 'findings', 1)
          .exec()
      } catch {
        /* the issue below still lands */
      }
    }
    try {
      const { trackError } = await import('./error-tracking.js')
      await trackError({
        source: 'server',
        route: `realtime/leak/${f.event}`,
        severity: 'high',
        message: `Socket event ${f.event} reached someone who cannot read that ${f.kind} on ${f.collection}`
      })
    } catch {
      /* the console list still has it */
    }
  }
}

/**
 * Called by the socket plugin for every string packet it writes. Cheap when off (one
 * comparison); when sampling, it parses the packet and queues the check for later.
 */
export function sampleLeakAudit(
  packet: string,
  room: string | null,
  user: () => User | null,
  run: (fn: () => Promise<void>) => void = (fn) => void fn()
): void {
  const rate = currentAuditRate()
  if (rate <= 0 || Math.random() >= rate) return
  if (!auditableRoom(room)) return
  const u = user()
  if (!u) return
  const subject = leakSubjectOf(packet)
  if (!subject) return
  stats.sampled++
  const now = Date.now()
  if (pending >= MAX_PENDING || !takeToken(now)) {
    stats.skipped++
    return
  }
  pending++
  // Out of band: after this write returns, in the socket's tenant (cloud).
  setTimeout(() => {
    run(async () => {
      try {
        const deps = await defaultDeps()
        if (await deps.isAdmin(u)) {
          stats.admin++
          return
        }
        const found = await checkLeak(u, subject, room, deps)
        stats.checked++
        if (found.length) await record(found)
      } catch {
        stats.skipped++
      } finally {
        pending--
      }
    })
  }, 250).unref?.()
}

export function leakAuditStats(): typeof stats & { pending: number; rate: number } {
  return { ...stats, pending, rate: currentAuditRate() }
}

/** Start (rate > 0) or stop (rate 0) a timed audit on every replica (they read it within 30 s). */
export async function setTimedAudit(rate: number, minutes: number): Promise<{ until: number }> {
  const until = Date.now() + Math.max(1, Math.min(24 * 60, minutes)) * 60_000
  const r = Math.max(0, Math.min(1, rate))
  state = r > 0 ? { rate: r, until } : null
  stateReadAt = Date.now()
  const client = redis()
  if (client) {
    if (state) await client.set(STATE_KEY, JSON.stringify(state), 'PX', until - Date.now())
    else await client.del(STATE_KEY)
  }
  return { until: state ? until : Date.now() }
}

export async function recentLeakFindings(limit = 100): Promise<{
  findings: LeakFinding[]
  total: number | null
  timed: { rate: number; until: number } | null
}> {
  const r = redis()
  if (!r) return { findings: [], total: null, timed: state }
  try {
    const [raw, total, st] = await Promise.all([
      r.lrange(FINDINGS_KEY, 0, Math.max(0, limit - 1)),
      r.hget(STATS_KEY, 'findings'),
      r.get(STATE_KEY)
    ])
    const findings: LeakFinding[] = []
    for (const s of raw) {
      try {
        findings.push(JSON.parse(s) as LeakFinding)
      } catch {
        /* skip */
      }
    }
    const timed = st ? (JSON.parse(st) as { rate: number; until: number }) : null
    return { findings, total: total == null ? 0 : Number(total), timed }
  } catch {
    return { findings: [], total: null, timed: state }
  }
}

/** Tests only. */
export function _resetLeakAuditForTests(): void {
  for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] = 0
  pending = 0
  tokens = CHECKS_PER_S
  tokensAt = Date.now()
  state = null
  stateReadAt = Date.now()
}
