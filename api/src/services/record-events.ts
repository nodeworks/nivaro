import { db } from '../db/index.js'
import { onOwnersChanged } from '../db/owner-signal.js'
import { getIo } from './io-holder.js'
import { broadcastCollectionUpdate } from './realtime.js'
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
 *   `$addendums`, `$comments`, `$tasks`, `$integrations`.
 * - `emitRecordEvent(c, id, 'record:integrity')` goes only to the record
 *   room (`record:<c>:<id>` — joined after a `can(read)` check), for signals
 *   nobody outside the open record needs.
 */

export type RecordAspect = '$state' | '$addendums' | '$comments' | '$tasks' | '$integrations'

export function announceRecordAspect(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  aspects: RecordAspect | RecordAspect[]
): void {
  if (!collection || item == null || item === '') return
  try {
    broadcastCollectionUpdate(undefined, collection, item, {
      changed_fields: Array.isArray(aspects) ? aspects : [aspects]
    })
  } catch {
    /* best-effort */
  }
}

export function emitRecordEvent(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  event: string,
  extra: Record<string, unknown> = {}
): void {
  if (!collection || item == null || item === '') return
  try {
    getIo()
      ?.to(`record:${collection}:${String(item)}`)
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
    if (process.env.CLOUD_META_DB_URL) {
      if (tenant) io.to(tenantScopedRoom(TENANT_ALL_ROOM, tenant)).emit(event, payload)
    } else io.emit(event, payload)
  } catch {
    /* best-effort */
  }
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

/**
 * #1870: who owns records changed (owner matrix, delegation, out-of-office,
 * team membership — the in-process owner signal, which on nivaro_users only
 * rises for the delegation/out-of-office/status columns). One payload-free
 * `owners:changed` to the tenant, coalesced over 5s and at most one per 15s
 * (the signal also rises on every transition, which already tells its own
 * record through `$state`); open records refetch their owners chip and
 * approval chain. With the Redis adapter the emit reaches every replica's
 * sockets; each process only announces its own writes.
 */
const ownersThrottle = keyedThrottle(5000, 15_000, (tenant) =>
  emitToTenant(tenant, 'owners:changed', { at: Date.now() })
)
onOwnersChanged(() => ownersThrottle(currentTenantKey()))

/**
 * #1925: a role, policy, row filter, scope or subtree grant changed — any open
 * record might now be hidden from its viewer. A payload-free `access:changed`
 * — to the tenant for an administrator's change, or to one person's sockets
 * for their own scope pick — coalesced; open records re-read themselves (as
 * the viewer) and say "You no longer have access" on a 403/404. Called from
 * the access-route onResponse hook (routes/index.ts) via accessAnnouncement.
 */
const accessThrottle = keyedThrottle(2000, 5000, (key) => {
  const payload = { at: Date.now() }
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
  /^\/api\/(roles|user-scopes|scope-dimensions|tree-permissions|access-requests\/[^/?]+\/resolve|users\/(bulk|me\/scopes|[^/?]+\/copy-access)|users\/(?!me\b)[^/?]+(?:[?]|$))/
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
