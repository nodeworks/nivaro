import { db } from '../db/index.js'
import { isMultiTenant } from './deployment-mode.js'
import { getIo } from './io-holder.js'
import { broadcastCollectionUpdate } from './realtime.js'
import { noteRealtimeEmit } from './request-trace.js'
import { currentTenantKey, tenantScopedRoom } from './tenant-rooms.js'

/**
 * Record-page live signals (rt-record). Everything here is a NOTICE — ids and
 * aspect names, never values — and best-effort: a failed emit never affects
 * the write that caused it. Clients refetch through their own
 * permission-checked queries (packages/shared lib/live.ts).
 *
 * Two shapes:
 * - `announceRecordAspect(c, id, '$state')` rides the existing
 *   `collection:update` contract with NO action and a `$`-named
 *   changed_fields entry, so list rows (CBV, queues) and open records both
 *   hear it, while the traffic map / GraphQL subscriptions (which key on
 *   `action`) do not count it as a write. Aspects: `$state` (pipeline moved),
 *   `$addendums`, `$comments`, `$tasks`, `$integrations`, `$lock` (an edit lock
 *   was taken or released — list rows show/clear the lock icon), `$files` and `$related`
 *   (both normally coalesced through services/related-announce.ts).
 * - `emitRecordEvent(c, id, 'record:integrity')` goes only to the record
 *   room (`record:<c>:<id>` — joined after a `can(read)` check), for signals
 *   nobody outside the open record needs.
 */

/**
 * The record aspects a notice may name. Comments per aspect:
 * - `$files`: the files a record carries changed (realtime 3; services/related-announce.ts).
 * - `$sla`: the SLA clock crossed its warning or breach line with no write (services/sla-flips.ts),
 *   or a deadline was acknowledged / overridden (routes/sla.ts).
 * - `$related`: a child or linked record changed (realtime 18; services/related-announce.ts).
 * - `$owners`: rt2 #17 — the record's resolved owners moved (services/owner-change-live.ts).
 * - `$approvals`: rt4 #8 — an approval chain on the record was started or a step decided.
 * - `$picker`: rt4 #6 — the record was hidden from or shown in pickers again.
 * - `$cells`: rt6 #15 — someone started or stopped editing a list cell of the record in place.
 * - `$scheduled`: rt7 #12 — a scheduled change on the record was made, moved, cancelled or applied.
 * - `$alerts`: rt9 #20 — a banner-enabled threshold alert fired on the record (hooks/alerts.ts).
 * - `$support`: rt9 #19 — a support request raised from the record opened, moved or closed.
 * - `$proposals`: S10 (realtime gaps 2026-11-17) — a change proposal on the record was made,
 *   accepted, declined or withdrawn (services/change-proposals.ts). Sent beside `$comments`,
 *   which is what open Notes panels listen for.
 * - `$attributes`: S13 — the record's dynamic attribute values changed (routes/attributes.ts).
 *   Sent beside `$related` for clients that only know that one.
 */
export const RECORD_ASPECTS = [
  '$state',
  '$addendums',
  '$comments',
  '$tasks',
  '$integrations',
  '$lock',
  '$files',
  '$sla',
  '$related',
  '$owners',
  '$approvals',
  '$picker',
  '$cells',
  '$scheduled',
  '$alerts',
  '$support',
  '$proposals',
  '$attributes'
] as const

export type RecordAspect = (typeof RECORD_ASPECTS)[number]

const ASPECT_SET: ReadonlySet<string> = new Set(RECORD_ASPECTS)

/** True for a known `$` aspect name (S3: the raw announcer and extensions accept only these). */
export function isRecordAspect(name: unknown): name is RecordAspect {
  return typeof name === 'string' && ASPECT_SET.has(name)
}

export function announceRecordAspect(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  aspects: RecordAspect | RecordAspect[],
  /** Real field NAMES that changed with the aspect (a `$state` move's mirrored state column). */
  alsoFields?: string | string[] | null
): void {
  if (!collection || item == null || item === '') return
  try {
    const extra = (Array.isArray(alsoFields) ? alsoFields : alsoFields ? [alsoFields] : []).filter(
      (f) => /^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(f)
    )
    broadcastCollectionUpdate(undefined, collection, item, {
      changed_fields: [...(Array.isArray(aspects) ? aspects : [aspects]), ...extra]
    })
  } catch {
    /* best-effort */
  }
}

/** More named records than this fold into one `item: '*'` notice (same cap as raw writes). */
export const ASPECT_BULK_CAP = 100

/**
 * S3 (realtime gaps 2026-11-17): one or more aspects of one or many records changed. Unknown
 * aspect names are dropped and returned (an extension typo must not reach clients as a field
 * name). Past ASPECT_BULK_CAP ids, ONE notice goes out with `item: '*'` and `bulk: <count>`.
 * Never throws. This is what `ctx.realtime.announceAspect` calls.
 */
export function announceRecordAspects(
  collection: string | null | undefined,
  ids: string | number | Array<string | number> | null | undefined,
  aspects: readonly unknown[]
): { announced: number; rejected: string[] } {
  const rejected: string[] = []
  const known: RecordAspect[] = []
  for (const a of Array.isArray(aspects) ? aspects : []) {
    if (isRecordAspect(a)) {
      if (!known.includes(a)) known.push(a)
    } else rejected.push(String(a).slice(0, 64))
  }
  if (!collection || !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(collection) || known.length === 0)
    return { announced: 0, rejected }
  const list = (Array.isArray(ids) ? ids : ids == null ? [] : [ids])
    .filter((i) => i != null && String(i).trim() !== '')
    .map((i) => String(i).trim().slice(0, 255))
  const unique = [...new Set(list)]
  if (unique.length === 0) return { announced: 0, rejected }
  try {
    if (unique.length > ASPECT_BULK_CAP) {
      broadcastCollectionUpdate(undefined, collection, '*', {
        changed_fields: known,
        bulk: unique.length
      })
      return { announced: 1, rejected }
    }
    for (const id of unique) announceRecordAspect(collection, id, known)
    return { announced: unique.length, rejected }
  } catch {
    return { announced: 0, rejected }
  }
}

/**
 * The same aspects on a set of records named by (collection, item) — task or comment rows
 * repointed in bulk, a merge survivor and its partner. One announcement per distinct record
 * (per collection past ASPECT_BULK_CAP, one '*' notice); rows with no record are skipped.
 * Returns how many records were named. Never throws.
 */
export function announceAspectOnRecords(
  records: Iterable<{ collection?: string | null; item?: string | number | null }>,
  aspects: readonly RecordAspect[]
): number {
  const by = new Map<string, Set<string>>()
  try {
    for (const r of records) {
      if (!r?.collection || r.item == null || String(r.item) === '') continue
      const set = by.get(r.collection) ?? new Set<string>()
      set.add(String(r.item))
      by.set(r.collection, set)
    }
  } catch {
    return 0
  }
  let n = 0
  for (const [collection, ids] of by) {
    announceRecordAspects(collection, [...ids], aspects)
    n += ids.size
  }
  return n
}

export function emitRecordEvent(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  event: string,
  extra: Record<string, unknown> = {}
): void {
  if (!collection || item == null || item === '') return
  noteRealtimeEmit(event)
  try {
    // Cloud: record rooms are per tenant (sockets join `t:<tenant>:record:…`).
    getIo()
      ?.to(tenantScopedRoom(`record:${collection}:${String(item)}`))
      .emit(event, { ...extra, collection, item: String(item) })
  } catch {
    /* best-effort */
  }
}

/**
 * An addendum moved: its own pipeline subject (`nivaro_addendums:<id>`) and
 * the parent record (whose addendum view, totals and list badges show it).
 */
export async function announceAddendumChange(
  addendumId: string | null | undefined,
  parent?: { collection?: string | null; id?: string | number | null }
): Promise<void> {
  if (!addendumId) return
  try {
    let pc = parent?.collection ?? null
    let pid = parent?.id ?? null
    if (!pc || pid == null) {
      const row = (await db('nivaro_addendums')
        .where({ id: addendumId })
        .select('parent_collection', 'parent_id')
        .first()) as { parent_collection?: string; parent_id?: string } | undefined
      pc = row?.parent_collection ?? null
      pid = row?.parent_id ?? null
    }
    announceRecordAspect('nivaro_addendums', addendumId, '$addendums')
    if (pc && pid != null) announceRecordAspect(pc, pid, '$addendums')
  } catch {
    /* best-effort */
  }
}

/** #1825: a partner submission row changed — tell its record's viewers. */
export async function announceSubmissionAspect(submissionId: number | string): Promise<void> {
  try {
    const row = (await db('nivaro_erp_submissions')
      .where({ id: submissionId })
      .first('collection', 'item')) as { collection?: string; item?: string } | undefined
    announceRecordAspect(row?.collection, row?.item, '$integrations')
  } catch {
    /* best-effort */
  }
}

/**
 * #2079: the record a flow run is working on — its trigger payload's
 * `collection` + `item` (`keys[0]` / `key` / `id` for item-event flows).
 * System collections are skipped: nobody has one open as a record page.
 */
export function flowRecordOf(payload: unknown): { collection: string; item: string } | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const collection = typeof p.collection === 'string' ? p.collection : null
  if (!collection || collection.startsWith('nivaro_') || collection.startsWith('directus_'))
    return null
  const keys = Array.isArray(p.keys) ? p.keys : null
  const raw = p.item ?? keys?.[0] ?? p.key ?? p.id
  if (raw == null || raw === '' || typeof raw === 'object') return null
  return { collection, item: String(raw) }
}

export function announceAutomation(
  record: { collection: string; item: string },
  flow: { id: string; name?: string | null },
  state: 'start' | 'end'
): void {
  emitRecordEvent(record.collection, record.item, 'record:automation', {
    flow_id: flow.id,
    flow_name: flow.name ?? null,
    state
  })
}

/**
 * Broadcasts that are not about one record go to every socket of the CURRENT
 * tenant: in cloud mode (CLOUD_META_DB_URL) the `t:<tenant>:all` room every
 * authenticated socket joins (plugins/socketio.ts); self-hosted, every
 * socket. A cloud signal with no tenant context goes nowhere.
 */
export const TENANT_ALL_ROOM = 'all'

export function emitToTenant(
  tenant: string,
  event: string,
  payload: Record<string, unknown>
): void {
  try {
    const io = getIo()
    if (!io) return
    if (isMultiTenant()) {
      if (tenant) io.to(tenantScopedRoom(TENANT_ALL_ROOM, tenant)).emit(event, payload)
    } else io.emit(event, payload)
  } catch {
    /* best-effort */
  }
}

/**
 * Like emitToTenant, but only to sockets FULLY signed in — never to an anonymous socket or one
 * whose person is still in the new-user flow (access pending). For signals that name people
 * (presence:changed carries user ids, army 5 b10). Self-hosted, a fully signed-in socket joins
 * the plain TENANT_ALL_ROOM (plugins/socketio.ts joinTenantAllRoom); cloud, the tenant's.
 */
export function emitToSignedIn(
  tenant: string,
  event: string,
  payload: Record<string, unknown>
): void {
  try {
    const io = getIo()
    if (!io) return
    if (isMultiTenant()) {
      if (tenant) io.to(tenantScopedRoom(TENANT_ALL_ROOM, tenant)).emit(event, payload)
    } else io.to(TENANT_ALL_ROOM).emit(event, payload)
  } catch {
    /* best-effort */
  }
}

/** A payload-free notice to every socket of the CURRENT tenant (announcements, flags, config). */
export function announceToTenant(event: string, payload: Record<string, unknown> = {}): void {
  emitToTenant(currentTenantKey(), event, { at: Date.now(), ...payload })
}

/**
 * Per-key throttle: the first signal fires after `delayMs` (coalescing the
 * burst), and never sooner than `minGapMs` after the key's previous fire —
 * so a person toggling a setting cannot make every open page re-read in a
 * tight loop. Exported for tests.
 */
export function keyedThrottle(
  delayMs: number,
  minGapMs: number,
  fire: (key: string) => void
): (key: string) => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastAt = new Map<string, number>()
  return (key: string) => {
    if (timers.has(key)) return
    const now = Date.now()
    if (lastAt.size > 1000) for (const [k, at] of lastAt) if (now - at > minGapMs) lastAt.delete(k)
    const wait = Math.max(delayMs, (lastAt.get(key) ?? 0) + minGapMs - now)
    const t = setTimeout(() => {
      timers.delete(key)
      lastAt.set(key, Date.now())
      fire(key)
    }, wait)
    t.unref?.()
    timers.set(key, t)
  }
}

/*
 * #1870 → rt2 #17: who owns records changed (owner matrix, delegation, out-of-office, team
 * membership). The tenant-wide `owners:changed` and the per-record `$owners` aspect now come
 * from services/owner-change-live.ts, which re-resolves only the records somebody has open.
 */

/**
 * #1925: a role, policy, row filter, scope or subtree grant changed — any open
 * record might now be hidden from its viewer. A payload-free `access:changed`
 * — to the tenant for an administrator's change, or to one person's sockets
 * for their own scope pick — coalesced; open records re-read themselves (as
 * the viewer) and say "You no longer have access" on a 403/404. Called from
 * the access-route onResponse hook (routes/index.ts) via accessAnnouncement.
 */
const accessThrottle = keyedThrottle(2000, 5000, (key) => {
  // rt2 #18 — `perms`: what this person may do moved (menus, buttons, fields, rows), not only
  // which records they read; the shared client refetches what is on screen as them.
  const payload = { at: Date.now(), perms: true }
  if (key.startsWith('u:')) {
    try {
      getIo()
        ?.to(`user:${key.slice(2)}`)
        .emit('access:changed', payload)
    } catch {
      /* best-effort */
    }
  } else emitToTenant(key.slice(2), 'access:changed', payload)
})
export function announceAccessChanged(opts: { userId?: string } = {}): void {
  accessThrottle(opts.userId ? `u:${opts.userId}` : `t:${currentTenantKey()}`)
}

/** Write routes whose success may change who can read which records. */
export const ACCESS_ROUTES =
  /^\/api\/(roles|user-scopes|scope-dimensions|tree-permissions|access-requests\/[^/?]+\/resolve|users\/(bulk|me\/scopes|[^/?]+\/copy-access)|users\/(?!me\b|cards(?:[?]|$))[^/?]+(?:[?]|$))/
/** The one access write a non-administrator makes: picking their own scope. */
const SELF_ACCESS_ROUTES = /^\/api\/users\/me\/scopes\b/

/**
 * Who a successful write should tell. Only an administrator's access write
 * reaches every open page; a person's own scope pick reaches only their own
 * sockets; anything else a non-administrator does (their profile, a PATCH to
 * their own user row) announces nothing.
 */
export function accessAnnouncement(req: {
  method: string
  url: string
  isAdmin?: boolean
  user?: { id?: string } | null
}): 'tenant' | { userId: string } | null {
  if (req.method === 'GET' || !ACCESS_ROUTES.test(req.url)) return null
  if (req.isAdmin) return 'tenant'
  if (req.user?.id && SELF_ACCESS_ROUTES.test(req.url)) return { userId: req.user.id }
  return null
}
